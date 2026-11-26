'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { openDatabase } = require('./db');
const { seedDemoData } = require('./seed');
const { hashPassword, verifyPassword, newOpaqueToken, hashToken, constantTimeEqual, SESSION_TTL_MS } = require('./security');

const BRANCHES = [
  'Computer Science', 'Computer Science (AI)', 'Information Science',
  'Electronics and Communication', 'Electrical and Electronics',
  'Mechanical', 'Civil', 'Data Science'
];
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const MAX_BODY_BYTES = 32 * 1024;
const SCRYPT_DUMMY_PASSWORD = 'dummy-login-comparison-value-not-a-real-account';

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function json(res, status, value, extraHeaders = {}) {
  const payload = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(payload);
}

function text(res, status, value, headers = {}) {
  const payload = Buffer.from(String(value));
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': payload.length, ...headers });
  res.end(payload);
}

function parseCookies(header = '') {
  const result = Object.create(null);
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

function safeText(value, field, min, max) {
  if (typeof value !== 'string') throw new HttpError(400, `Invalid ${field}.`);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) throw new HttpError(400, `Invalid ${field}.`);
  return normalized;
}

function safeNumber(value, field, min, max) {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) throw new HttpError(400, `Invalid ${field}.`);
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new HttpError(400, `Invalid ${field}.`);
  return number;
}

function validateEmail(value) {
  const email = safeText(value, 'email address', 5, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  return email;
}

function validatePassword(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128) {
    throw new HttpError(400, 'Password must contain between 12 and 128 characters.');
  }
  return value;
}

function validateBranch(value) {
  const branch = safeText(value, 'branch', 2, 80);
  if (!BRANCHES.includes(branch)) throw new HttpError(400, 'Select a valid branch.');
  return branch;
}

function validateRegistration(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Invalid request body.');
  if (input.privacyAcknowledged !== true) throw new HttpError(400, 'Read and acknowledge the privacy notice before creating an account.');
  const studentCode = safeText(input.studentCode, 'student ID', 3, 24).replace(/\s/g, '');
  if (!/^[a-zA-Z0-9-]+$/.test(studentCode)) throw new HttpError(400, 'Student ID may contain only letters, numbers and hyphens.');
  return {
    fullName: safeText(input.fullName, 'full name', 2, 80),
    email: validateEmail(input.email),
    password: validatePassword(input.password),
    studentCode,
    branch: validateBranch(input.branch),
    cgpa: safeNumber(input.cgpa, 'CGPA', 0, 10),
    graduationYear: safeNumber(input.graduationYear, 'graduation year', 2020, 2040),
    skills: typeof input.skills === 'string' ? input.skills.trim().slice(0, 500) : ''
  };
}

function validateJob(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Invalid request body.');
  if (!Array.isArray(input.eligibleBranches) || input.eligibleBranches.length < 1 || input.eligibleBranches.length > BRANCHES.length) {
    throw new HttpError(400, 'Select at least one eligible branch.');
  }
  const branches = [...new Set(input.eligibleBranches.map(validateBranch))];
  return {
    title: safeText(input.title, 'job title', 3, 100),
    company: safeText(input.company, 'company name', 2, 100),
    description: safeText(input.description, 'job description', 20, 3000),
    location: safeText(input.location, 'job location', 2, 100),
    minCgpa: safeNumber(input.minCgpa, 'minimum CGPA', 0, 10),
    eligibleBranches: branches
  };
}

function validateProfile(input) {
  return {
    fullName: safeText(input.fullName, 'full name', 2, 80),
    branch: validateBranch(input.branch),
    cgpa: safeNumber(input.cgpa, 'CGPA', 0, 10),
    graduationYear: safeNumber(input.graduationYear, 'graduation year', 2020, 2040),
    skills: typeof input.skills === 'string' ? input.skills.trim().slice(0, 500) : ''
  };
}

function validateDate(value) {
  const date = safeText(value, 'joining date', 10, 10);
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00.000Z`) : new Date(NaN);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new HttpError(400, 'Joining date must be a valid YYYY-MM-DD date.');
  }
  return date;
}

function publicStudent(row) {
  if (!row) return null;
  return {
    id: row.user_id,
    fullName: row.full_name,
    studentCode: row.student_code,
    branch: row.branch,
    cgpa: row.cgpa,
    graduationYear: row.graduation_year,
    skills: row.skills
  };
}

function userSummary(row) {
  return { id: row.id, email: row.email, role: row.role };
}

function createRateLimiter({ windowMs, limit }) {
  const entries = new Map();
  let lastCleanup = 0;
  return (key) => {
    const now = Date.now();
    if (now - lastCleanup > windowMs || entries.size > 5000) {
      for (const [entryKey, value] of entries) if (value.resetAt <= now) entries.delete(entryKey);
      lastCleanup = now;
    }
    const entry = entries.get(key);
    if (!entry || entry.resetAt <= now) {
      entries.set(key, { count: 1, resetAt: now + windowMs });
      return false;
    }
    entry.count += 1;
    return entry.count > limit;
  };
}

async function createTalentHubServer(options = {}) {
  const env = options.env || process.env;
  const db = options.db || openDatabase(options.databasePath || env.DATABASE_PATH || './data/talent-hub.sqlite');
  if (options.seed !== false) await seedDemoData(db, env);
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  const dummyHash = await hashPassword(SCRYPT_DUMMY_PASSWORD);
  const secureCookie = env.NODE_ENV === 'production';
  const appOrigin = env.APP_ORIGIN || 'http://localhost:3000';
  const loginBlocked = createRateLimiter({ windowMs: 15 * 60 * 1000, limit: env.NODE_ENV === 'test' ? 1000 : 10 });
  const registerBlocked = createRateLimiter({ windowMs: 60 * 60 * 1000, limit: env.NODE_ENV === 'test' ? 1000 : 5 });

  function audit(actorId, action, targetType, targetId = null) {
    db.prepare(`INSERT INTO audit_logs (id, actor_id, action, target_type, target_id) VALUES (?, ?, ?, ?, ?)`)
      .run(crypto.randomUUID(), actorId || null, action, targetType, targetId);
  }

  function sessionCookie(token, clear = false) {
    const parts = ['talent_hub.sid=' + (clear ? '' : token), 'Path=/', 'HttpOnly', 'SameSite=Lax'];
    if (secureCookie) parts.push('Secure');
    parts.push(clear ? 'Max-Age=0' : `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
    return parts.join('; ');
  }

  function loadSession(req) {
    const token = parseCookies(req.headers.cookie || '')['talent_hub.sid'];
    if (!token || !/^[A-Za-z0-9_-]{40,50}$/.test(token)) return null;
    const sidHash = hashToken(token);
    const row = db.prepare(`SELECT s.sid_hash, s.csrf_token, s.expires_at, s.user_id, u.email, u.role
      FROM sessions s LEFT JOIN users u ON u.id = s.user_id WHERE s.sid_hash = ?`).get(sidHash);
    if (!row || row.expires_at <= Date.now()) {
      if (row) db.prepare('DELETE FROM sessions WHERE sid_hash = ?').run(sidHash);
      return null;
    }
    db.prepare('UPDATE sessions SET expires_at = ? WHERE sid_hash = ?').run(Date.now() + SESSION_TTL_MS, sidHash);
    return { sidHash, csrfToken: row.csrf_token, user: row.user_id ? { id: row.user_id, email: row.email, role: row.role } : null };
  }

  function createSession(userId, res) {
    const token = newOpaqueToken();
    const csrfToken = newOpaqueToken();
    const now = Date.now();
    db.prepare('INSERT INTO sessions (sid_hash, user_id, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(hashToken(token), userId, csrfToken, now + SESSION_TTL_MS, now);
    res.setHeader('Set-Cookie', sessionCookie(token));
    return { sidHash: hashToken(token), csrfToken, user: userId ? db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(userId) : null };
  }

  function destroySession(ctx, res) {
    if (ctx.session) db.prepare('DELETE FROM sessions WHERE sid_hash = ?').run(ctx.session.sidHash);
    res.setHeader('Set-Cookie', sessionCookie('', true));
  }

  function checkOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return;
    const host = req.headers.host;
    const acceptable = new Set([appOrigin, `http://${host}`, `https://${host}`]);
    if (!acceptable.has(origin)) throw new HttpError(403, 'Cross-origin request rejected.');
  }

  function requireAuth(ctx) {
    if (!ctx.session || !ctx.session.user) throw new HttpError(401, 'Authentication required.');
    return ctx.session.user;
  }

  function allowRoles(user, ...roles) {
    if (!roles.includes(user.role)) throw new HttpError(403, 'You do not have permission to perform this action.');
  }

  async function readJson(req) {
    const contentLength = Number(req.headers['content-length'] || 0);
    if (contentLength > MAX_BODY_BYTES) throw new HttpError(413, 'Request body is too large.');
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body is too large.');
      chunks.push(chunk);
    }
    if (size === 0) return {};
    const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/json') throw new HttpError(415, 'Content-Type must be application/json.');
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected an object');
      return parsed;
    } catch {
      throw new HttpError(400, 'Malformed JSON request body.');
    }
  }

  function canManageJob(user, job) {
    return Boolean(job && (user.role === 'admin' || (user.role === 'recruiter' && job.recruiter_id === user.id)));
  }

  async function apiHandler(req, res, url) {
    let ctx = { session: loadSession(req) };
    const method = req.method.toUpperCase();
    const pathname = url.pathname;
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(method);

    if (unsafe) {
      checkOrigin(req);
      if (!ctx.session || !constantTimeEqual(req.headers['x-csrf-token'], ctx.session.csrfToken)) {
        throw new HttpError(403, 'CSRF validation failed. Refresh the page and try again.');
      }
    }

    if (method === 'GET' && pathname === '/api/health') return json(res, 200, { status: 'ok', service: 'Talent Hub' });

    if (method === 'GET' && pathname === '/api/csrf') {
      if (!ctx.session) ctx.session = createSession(null, res);
      return json(res, 200, { csrfToken: ctx.session.csrfToken });
    }

    if (method === 'POST' && pathname === '/api/register') {
      const ip = req.socket.remoteAddress || 'unknown';
      if (registerBlocked(ip)) throw new HttpError(429, 'Registration limit reached. Please try again later.');
      const input = validateRegistration(await readJson(req));
      const userId = crypto.randomUUID();
      const passwordHash = await hashPassword(input.password);
      try {
        db.exec('BEGIN IMMEDIATE');
        db.prepare('INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)')
          .run(userId, input.email, passwordHash, 'student');
        db.prepare(`INSERT INTO students (user_id, full_name, student_code, branch, cgpa, graduation_year, skills)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(userId, input.fullName, input.studentCode, input.branch, input.cgpa, input.graduationYear, input.skills);
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
        if (/UNIQUE constraint failed/i.test(error.message)) throw new HttpError(409, 'Could not create the account with the supplied details. Check the entries or contact the administrator.');
        throw error;
      }
      if (ctx.session) db.prepare('DELETE FROM sessions WHERE sid_hash = ?').run(ctx.session.sidHash);
      ctx.session = createSession(userId, res);
      audit(userId, 'account.registered', 'user', userId);
      return json(res, 201, { user: { id: userId, email: input.email, role: 'student' }, csrfToken: ctx.session.csrfToken });
    }

    if (method === 'POST' && pathname === '/api/login') {
      const ip = req.socket.remoteAddress || 'unknown';
      if (loginBlocked(ip)) throw new HttpError(429, 'Too many sign-in attempts. Please try again later.');
      const input = await readJson(req);
      const email = validateEmail(input.email);
      const password = validatePassword(input.password);
      const account = db.prepare('SELECT id, email, password_hash, role FROM users WHERE email = ?').get(email);
      const passwordMatches = await verifyPassword(password, account ? account.password_hash : dummyHash);
      if (!account || !passwordMatches) throw new HttpError(401, 'Invalid email or password.');
      if (ctx.session) db.prepare('DELETE FROM sessions WHERE sid_hash = ?').run(ctx.session.sidHash);
      ctx.session = createSession(account.id, res);
      audit(account.id, 'auth.login', 'user', account.id);
      return json(res, 200, { user: userSummary(account), csrfToken: ctx.session.csrfToken });
    }

    if (method === 'POST' && pathname === '/api/logout') {
      const user = requireAuth(ctx);
      await readJson(req);
      audit(user.id, 'auth.logout', 'user', user.id);
      destroySession(ctx, res);
      return json(res, 200, { message: 'Signed out successfully.' });
    }

    if (method === 'GET' && pathname === '/api/me') {
      const user = requireAuth(ctx);
      const profile = user.role === 'student' ? publicStudent(db.prepare('SELECT * FROM students WHERE user_id = ?').get(user.id)) : null;
      return json(res, 200, { user, profile });
    }

    if (method === 'GET' && pathname === '/api/dashboard') {
      const user = requireAuth(ctx);
      let data;
      if (user.role === 'student') {
        data = {
          openJobs: db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status = 'open'").get().count,
          myApplications: db.prepare('SELECT COUNT(*) AS count FROM applications WHERE student_id = ?').get(user.id).count,
          myOffers: db.prepare('SELECT COUNT(*) AS count FROM offers WHERE student_id = ?').get(user.id).count,
          recentApplications: db.prepare(`SELECT a.id, a.status, a.created_at, j.title, j.company
            FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.student_id = ? ORDER BY a.created_at DESC LIMIT 5`).all(user.id)
        };
      } else if (user.role === 'recruiter') {
        data = {
          myJobs: db.prepare('SELECT COUNT(*) AS count FROM jobs WHERE recruiter_id = ?').get(user.id).count,
          applicants: db.prepare(`SELECT COUNT(*) AS count FROM applications a JOIN jobs j ON j.id = a.job_id WHERE j.recruiter_id = ?`).get(user.id).count,
          openJobs: db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE recruiter_id = ? AND status = 'open'").get(user.id).count,
          recentApplications: db.prepare(`SELECT a.id, a.status, a.created_at, j.title, j.company, s.full_name
            FROM applications a JOIN jobs j ON j.id = a.job_id JOIN students s ON s.user_id = a.student_id
            WHERE j.recruiter_id = ? ORDER BY a.created_at DESC LIMIT 5`).all(user.id)
        };
      } else {
        data = {
          students: db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'student'").get().count,
          recruiters: db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'recruiter'").get().count,
          jobs: db.prepare('SELECT COUNT(*) AS count FROM jobs').get().count,
          applications: db.prepare('SELECT COUNT(*) AS count FROM applications').get().count
        };
      }
      return json(res, 200, data);
    }

    if (method === 'GET' && pathname === '/api/jobs') {
      const query = typeof url.searchParams.get('q') === 'string' ? (url.searchParams.get('q') || '').trim().slice(0, 80) : '';
      const branch = (url.searchParams.get('branch') || '').trim().slice(0, 80);
      const status = url.searchParams.get('status') === 'closed' ? 'closed' : 'open';
      const like = `%${query}%`;
      const jobs = db.prepare(`SELECT j.id, j.title, j.company, j.description, j.location, j.min_cgpa,
        j.eligible_branches, j.status, j.created_at
        FROM jobs j WHERE j.status = ? AND (? = '' OR j.title LIKE ? OR j.company LIKE ? OR j.description LIKE ?)
        ORDER BY j.created_at DESC LIMIT 100`).all(status, query, like, like, like)
        .filter((job) => !branch || JSON.parse(job.eligible_branches).includes(branch))
        .map((job) => ({
          id: job.id, title: job.title, company: job.company, description: job.description,
          location: job.location, min_cgpa: job.min_cgpa,
          eligibleBranches: JSON.parse(job.eligible_branches), status: job.status, created_at: job.created_at
        }));
      return json(res, 200, { jobs });
    }

    if (method === 'POST' && pathname === '/api/jobs') {
      const user = requireAuth(ctx);
      allowRoles(user, 'recruiter', 'admin');
      const input = validateJob(await readJson(req));
      const id = crypto.randomUUID();
      db.prepare(`INSERT INTO jobs (id, recruiter_id, title, company, description, location, min_cgpa, eligible_branches)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, user.id, input.title, input.company, input.description, input.location, input.minCgpa, JSON.stringify(input.eligibleBranches));
      audit(user.id, 'job.created', 'job', id);
      return json(res, 201, { job: { id, ...input, status: 'open' } });
    }

    let match = pathname.match(/^\/api\/jobs\/([0-9a-f-]{36})$/i);
    if (match && method === 'PATCH') {
      const user = requireAuth(ctx);
      allowRoles(user, 'recruiter', 'admin');
      const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(match[1]);
      if (!job) throw new HttpError(404, 'Job not found.');
      if (!canManageJob(user, job)) throw new HttpError(403, 'You cannot modify this job.');
      const input = validateJob(await readJson(req));
      db.prepare(`UPDATE jobs SET title = ?, company = ?, description = ?, location = ?, min_cgpa = ?, eligible_branches = ? WHERE id = ?`)
        .run(input.title, input.company, input.description, input.location, input.minCgpa, JSON.stringify(input.eligibleBranches), job.id);
      audit(user.id, 'job.updated', 'job', job.id);
      return json(res, 200, { message: 'Job updated.' });
    }
    if (match && method === 'DELETE') {
      const user = requireAuth(ctx);
      allowRoles(user, 'recruiter', 'admin');
      const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(match[1]);
      if (!job) throw new HttpError(404, 'Job not found.');
      if (!canManageJob(user, job)) throw new HttpError(403, 'You cannot modify this job.');
      db.prepare("UPDATE jobs SET status = 'closed' WHERE id = ?").run(job.id);
      audit(user.id, 'job.closed', 'job', job.id);
      return json(res, 200, { message: 'Job closed.' });
    }

    if (method === 'GET' && pathname === '/api/students') {
      const user = requireAuth(ctx);
      allowRoles(user, 'recruiter', 'admin');
      const query = (url.searchParams.get('q') || '').trim().slice(0, 80);
      const like = `%${query}%`;
      const rows = db.prepare(`SELECT s.* FROM students s
        WHERE (? = '' OR s.full_name LIKE ? OR s.branch LIKE ? OR s.skills LIKE ? OR s.student_code LIKE ?)
        ORDER BY s.full_name COLLATE NOCASE LIMIT 100`).all(query, like, like, like, like);
      return json(res, 200, { students: rows.map(publicStudent) });
    }

    match = pathname.match(/^\/api\/students\/([0-9a-f-]{36})$/i);
    if (method === 'GET' && match) {
      const user = requireAuth(ctx);
      if (user.role === 'student' && user.id !== match[1]) throw new HttpError(403, 'You cannot access another student profile.');
      const profile = publicStudent(db.prepare('SELECT * FROM students WHERE user_id = ?').get(match[1]));
      if (!profile) throw new HttpError(404, 'Student not found.');
      return json(res, 200, { student: profile });
    }

    if (method === 'PATCH' && pathname === '/api/me/profile') {
      const user = requireAuth(ctx);
      allowRoles(user, 'student');
      const input = validateProfile(await readJson(req));
      db.prepare(`UPDATE students SET full_name = ?, branch = ?, cgpa = ?, graduation_year = ?, skills = ? WHERE user_id = ?`)
        .run(input.fullName, input.branch, input.cgpa, input.graduationYear, input.skills, user.id);
      audit(user.id, 'profile.updated', 'student', user.id);
      return json(res, 200, { profile: publicStudent(db.prepare('SELECT * FROM students WHERE user_id = ?').get(user.id)) });
    }

    match = pathname.match(/^\/api\/eligibility\/([0-9a-f-]{36})$/i);
    if (method === 'GET' && match) {
      const user = requireAuth(ctx);
      allowRoles(user, 'student');
      const profile = db.prepare('SELECT * FROM students WHERE user_id = ?').get(user.id);
      const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(match[1]);
      if (!job) throw new HttpError(404, 'Job not found.');
      const reasons = [];
      if (profile.cgpa < job.min_cgpa) reasons.push(`Minimum CGPA required: ${job.min_cgpa.toFixed(1)}.`);
      if (!JSON.parse(job.eligible_branches).includes(profile.branch)) reasons.push('Your branch is not included in the eligibility criteria.');
      if (job.status !== 'open') reasons.push('This job is closed.');
      return json(res, 200, { eligible: reasons.length === 0, reasons, job: { id: job.id, title: job.title, company: job.company } });
    }

    match = pathname.match(/^\/api\/jobs\/([0-9a-f-]{36})\/apply$/i);
    if (method === 'POST' && match) {
      const user = requireAuth(ctx);
      allowRoles(user, 'student');
      await readJson(req);
      const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(match[1]);
      if (!job) throw new HttpError(404, 'Job not found.');
      const profile = db.prepare('SELECT * FROM students WHERE user_id = ?').get(user.id);
      const eligible = job.status === 'open' && profile.cgpa >= job.min_cgpa && JSON.parse(job.eligible_branches).includes(profile.branch);
      if (!eligible) throw new HttpError(403, 'You are not eligible for this job.');
      const id = crypto.randomUUID();
      try {
        db.prepare('INSERT INTO applications (id, job_id, student_id) VALUES (?, ?, ?)').run(id, job.id, user.id);
      } catch (error) {
        if (/UNIQUE constraint failed/i.test(error.message)) throw new HttpError(409, 'You have already applied for this job.');
        throw error;
      }
      audit(user.id, 'application.created', 'application', id);
      return json(res, 201, { application: { id, jobId: job.id, status: 'applied' } });
    }

    if (method === 'GET' && pathname === '/api/applications') {
      const user = requireAuth(ctx);
      let rows;
      if (user.role === 'student') {
        rows = db.prepare(`SELECT a.id, a.status, a.created_at, j.id AS job_id, j.title, j.company, j.location
          FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.student_id = ? ORDER BY a.created_at DESC`).all(user.id);
      } else if (user.role === 'recruiter') {
        rows = db.prepare(`SELECT a.id, a.status, a.created_at, j.id AS job_id, j.title, j.company,
          s.user_id AS student_id, s.full_name, s.branch, s.cgpa, s.skills
          FROM applications a JOIN jobs j ON j.id = a.job_id JOIN students s ON s.user_id = a.student_id
          WHERE j.recruiter_id = ? ORDER BY a.created_at DESC`).all(user.id);
      } else {
        rows = db.prepare(`SELECT a.id, a.status, a.created_at, j.id AS job_id, j.title, j.company,
          s.user_id AS student_id, s.full_name, s.branch, s.cgpa, s.skills
          FROM applications a JOIN jobs j ON j.id = a.job_id JOIN students s ON s.user_id = a.student_id
          ORDER BY a.created_at DESC LIMIT 250`).all();
      }
      return json(res, 200, { applications: rows });
    }

    match = pathname.match(/^\/api\/applications\/([0-9a-f-]{36})\/status$/i);
    if (method === 'PATCH' && match) {
      const user = requireAuth(ctx);
      allowRoles(user, 'recruiter', 'admin');
      const input = await readJson(req);
      if (!['shortlisted', 'rejected'].includes(input.status)) throw new HttpError(400, 'Invalid application status.');
      const application = db.prepare(`SELECT a.*, j.recruiter_id FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.id = ?`).get(match[1]);
      if (!application) throw new HttpError(404, 'Application not found.');
      if (user.role !== 'admin' && application.recruiter_id !== user.id) throw new HttpError(403, 'You cannot update an application for another recruiter’s job.');
      db.prepare('UPDATE applications SET status = ? WHERE id = ?').run(input.status, application.id);
      audit(user.id, 'application.status_updated', 'application', application.id);
      return json(res, 200, { message: 'Application status updated.' });
    }

    if (method === 'POST' && pathname === '/api/offers') {
      const user = requireAuth(ctx);
      allowRoles(user, 'recruiter', 'admin');
      const input = await readJson(req);
      const applicationId = safeText(input.applicationId, 'application ID', 36, 36);
      if (!/^[0-9a-f-]{36}$/i.test(applicationId)) throw new HttpError(400, 'Invalid application ID.');
      const salaryLpa = safeNumber(input.salaryLpa, 'salary', 0.01, 1000);
      const joiningDate = validateDate(input.joiningDate);
      const message = typeof input.message === 'string' ? input.message.trim().slice(0, 1000) : '';
      const application = db.prepare(`SELECT a.*, j.recruiter_id FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.id = ?`).get(applicationId);
      if (!application) throw new HttpError(404, 'Application not found.');
      if (user.role !== 'admin' && application.recruiter_id !== user.id) throw new HttpError(403, 'You cannot create an offer for another recruiter’s job.');
      if (application.status !== 'shortlisted') throw new HttpError(409, 'Only shortlisted applications can receive an offer.');
      const id = crypto.randomUUID();
      try {
        db.prepare(`INSERT INTO offers (id, application_id, student_id, job_id, salary_lpa, joining_date, message)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(id, application.id, application.student_id, application.job_id, salaryLpa, joiningDate, message);
      } catch (error) {
        if (/UNIQUE constraint failed/i.test(error.message)) throw new HttpError(409, 'An offer already exists for this application.');
        throw error;
      }
      db.prepare("UPDATE applications SET status = 'offered' WHERE id = ?").run(application.id);
      audit(user.id, 'offer.created', 'offer', id);
      return json(res, 201, { offer: { id, applicationId: application.id, salaryLpa, joiningDate } });
    }

    if (method === 'GET' && pathname === '/api/offers') {
      const user = requireAuth(ctx);
      let offers;
      if (user.role === 'student') {
        offers = db.prepare(`SELECT o.id, o.salary_lpa, o.joining_date, o.message, o.created_at, j.title, j.company
          FROM offers o JOIN jobs j ON j.id = o.job_id WHERE o.student_id = ? ORDER BY o.created_at DESC`).all(user.id);
      } else if (user.role === 'recruiter') {
        offers = db.prepare(`SELECT o.id, o.salary_lpa, o.joining_date, o.created_at, j.title, j.company, s.full_name
          FROM offers o JOIN jobs j ON j.id = o.job_id JOIN students s ON s.user_id = o.student_id
          WHERE j.recruiter_id = ? ORDER BY o.created_at DESC`).all(user.id);
      } else {
        offers = db.prepare(`SELECT o.id, o.salary_lpa, o.joining_date, o.created_at, j.title, j.company, s.full_name
          FROM offers o JOIN jobs j ON j.id = o.job_id JOIN students s ON s.user_id = o.student_id ORDER BY o.created_at DESC`).all();
      }
      return json(res, 200, { offers });
    }

    match = pathname.match(/^\/api\/offers\/([0-9a-f-]{36})\/download$/i);
    if (method === 'GET' && match) {
      const user = requireAuth(ctx);
      const offer = db.prepare(`SELECT o.*, j.title, j.company, s.full_name, s.branch
        FROM offers o JOIN jobs j ON j.id = o.job_id JOIN students s ON s.user_id = o.student_id WHERE o.id = ?`).get(match[1]);
      if (!offer) throw new HttpError(404, 'Offer not found.');
      if (user.role !== 'admin' && user.id !== offer.student_id) throw new HttpError(403, 'You are not authorized to download this offer.');
      const body = [
        'TALENT HUB - OFFER LETTER',
        '--------------------------',
        `Candidate: ${offer.full_name}`,
        `Branch: ${offer.branch}`,
        `Company: ${offer.company}`,
        `Position: ${offer.title}`,
        `Compensation: INR ${offer.salary_lpa.toFixed(2)} LPA`,
        `Joining date: ${offer.joining_date}`,
        '', offer.message, '',
        'This is a demonstration document generated by the local Talent Hub application.'
      ].join('\n');
      audit(user.id, 'offer.downloaded', 'offer', offer.id);
      return text(res, 200, body, {
        'Content-Disposition': `attachment; filename="offer-letter-${offer.id}.txt"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff'
      });
    }

    if (method === 'GET' && pathname === '/api/audit-logs') {
      const user = requireAuth(ctx);
      allowRoles(user, 'admin');
      const logs = db.prepare(`SELECT a.id, a.action, a.target_type, a.target_id, a.created_at, u.email AS actor_email
        FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.created_at DESC LIMIT 200`).all();
      return json(res, 200, { logs });
    }

    throw new HttpError(404, 'API endpoint not found.');
  }

  function securityHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
    if (secureCookie) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  async function serveStatic(req, res, url) {
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { return text(res, 400, 'Bad request.'); }
    if (pathname === '/') pathname = '/index.html';
    const requested = path.resolve(PUBLIC_DIR, `.${pathname}`);
    if (!requested.startsWith(PUBLIC_DIR + path.sep) && requested !== PUBLIC_DIR) return text(res, 403, 'Forbidden.');
    let stat;
    try { stat = await fs.promises.stat(requested); } catch { return text(res, 404, 'Not found.'); }
    if (!stat.isFile()) return text(res, 404, 'Not found.');
    const mime = ({ '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' })[path.extname(requested)] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Cache-Control': env.NODE_ENV === 'production' ? 'public, max-age=3600' : 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(requested).pipe(res);
  }

  const sessionCleanupTimer = setInterval(() => {
    try { db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now()); } catch (error) { console.error('[TalentHub:session-cleanup]', error); }
  }, 15 * 60 * 1000);
  sessionCleanupTimer.unref();

  const server = http.createServer((req, res) => {
    securityHeaders(res);
    const host = req.headers.host || 'localhost';
    let url;
    try { url = new URL(req.url, `http://${host}`); } catch { return text(res, 400, 'Bad request.'); }
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST' && req.method !== 'PATCH' && req.method !== 'DELETE') {
      res.setHeader('Allow', 'GET, HEAD, POST, PATCH, DELETE');
      return text(res, 405, 'Method not allowed.');
    }
    if (url.pathname.startsWith('/api/')) {
      apiHandler(req, res, url).catch((error) => {
        if (res.headersSent) return res.destroy();
        if (error instanceof HttpError) return json(res, error.status, { error: error.message, ...(error.details ? { details: error.details } : {}) });
        console.error('[TalentHub]', error && error.stack ? error.stack : error);
        return json(res, 500, { error: 'An unexpected server error occurred.' });
      });
    } else if (url.pathname.startsWith('/api')) {
      json(res, 404, { error: 'API endpoint not found.' });
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(req, res, url).catch((error) => {
        console.error('[TalentHub:static]', error);
        if (!res.headersSent) text(res, 500, 'An unexpected server error occurred.');
      });
    } else {
      text(res, 404, 'Not found.');
    }
  });

  return {
    server,
    db,
    close() {
      clearInterval(sessionCleanupTimer);
      try { server.close(); } catch { /* server already closed */ }
      try { db.close(); } catch { /* database already closed */ }
    }
  };
}

async function start() {
  try { require('node:process').loadEnvFile?.(); } catch { /* .env file is optional */ }
  const port = Number(process.env.PORT || 3000);
  const app = await createTalentHubServer();
  app.server.listen(port, () => {
    console.log(`Talent Hub is running at http://localhost:${port}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    if (process.env.NODE_ENV !== 'production') console.log('Demo credentials are documented in README.md.');
  });
  const shutdown = () => app.server.close(() => { app.db.close(); process.exit(0); });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) start().catch((error) => {
  console.error('[TalentHub:startup]', error);
  process.exit(1);
});

module.exports = { createTalentHubServer, HttpError, BRANCHES };
