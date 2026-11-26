'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createTalentHubServer } = require('../src/server');
const { hashPassword } = require('../src/security');
const { openDatabase } = require('../src/db');
const { seedDemoData } = require('../src/seed');

let app;
let baseUrl;
let tempDir;

test.before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'talent-hub-test-'));
  app = await createTalentHubServer({
    databasePath: path.join(tempDir, 'test.sqlite'),
    env: { NODE_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1' },
    seed: true
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${app.server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => app.server.close(resolve));
  app.db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function client() {
  let cookie = '';
  let csrf = '';
  async function request(endpoint, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const headers = { ...(options.headers || {}) };
    if (cookie) headers.Cookie = cookie;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && csrf) headers['X-CSRF-Token'] = csrf;
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${baseUrl}${endpoint}`, { ...options, method, headers });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const type = response.headers.get('content-type') || '';
    const payload = type.includes('application/json') ? await response.json() : await response.text();
    if (payload && typeof payload === 'object' && payload.csrfToken) csrf = payload.csrfToken;
    return { status: response.status, payload, headers: response.headers };
  }
  async function initCsrf() {
    const result = await request('/api/csrf');
    csrf = result.payload.csrfToken;
    return result;
  }
  async function login(email, password) {
    await initCsrf();
    return request('/api/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  }
  return { request, initCsrf, login, get csrf() { return csrf; } };
}

const demo = {
  adminEmail: 'admin@talenthub.local',
  adminPassword: 'AdminDemo!ChangeThis2026',
  recruiterEmail: 'recruiter@talenthub.local',
  recruiterPassword: 'RecruiterDemo!ChangeThis2026',
  studentEmail: 'student@talenthub.local',
  studentPassword: 'StudentDemo!ChangeThis2026'
};

async function createStudentAccount(api, suffix) {
  await api.initCsrf();
  return api.request('/api/register', { method: 'POST', body: JSON.stringify({
    fullName: `Second Student ${suffix}`,
    studentCode: `TH-TEST-${suffix}`,
    email: `student-${suffix}@example.test`,
    password: 'StrongStudentPassword!2026',
    branch: 'Computer Science (AI)',
    cgpa: 8.2,
    graduationYear: 2027,
    skills: 'Node.js, SQL, Testing',
    privacyAcknowledged: true
  }) });
}

async function createSecondRecruiter() {
  const id = crypto.randomUUID();
  const passwordHash = await hashPassword('StrongRecruiterPassword!2026');
  app.db.prepare('INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(id, 'other-recruiter@example.test', passwordHash, 'recruiter');
  return { id, email: 'other-recruiter@example.test', password: 'StrongRecruiterPassword!2026' };
}

test('security headers and health endpoint are present', async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'ok');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
});

test('application shell and privacy notice are served', async () => {
  const home = await fetch(`${baseUrl}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/);
  assert.match(await home.text(), /Talent Hub/);
  const privacy = await fetch(`${baseUrl}/privacy.html`);
  assert.equal(privacy.status, 200);
  const notice = await privacy.text();
  assert.match(notice, /Information collected/);
  assert.match(notice, /Use dummy student data only/);
});


test('production mode refuses to seed public demo credentials, even with SEED_DEMO=true', async () => {
  const db = openDatabase(':memory:');
  try {
    await seedDemoData(db, { NODE_ENV: 'production', SEED_DEMO: 'true' });
    const count = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
    assert.equal(count, 0);
  } finally { db.close(); }
});

test('duplicate registration does not disclose whether an email or student ID exists', async () => {
  const api = client();
  await api.login(demo.studentEmail, demo.studentPassword);
  const result = await api.request('/api/register', { method: 'POST', body: JSON.stringify({
    fullName: 'Duplicate Attempt',
    studentCode: 'TH-NEW-DUPLICATE',
    email: demo.studentEmail,
    password: 'AnotherStrongPassword!2026',
    branch: 'Computer Science (AI)',
    cgpa: 8.1,
    graduationYear: 2027,
    skills: 'Security review',
    privacyAcknowledged: true
  }) });
  assert.equal(result.status, 409);
  assert.match(result.payload.error, /Could not create the account/);
  assert.equal(/already registered/i.test(result.payload.error), false);
  assert.equal(/email/i.test(result.payload.error), false);
});


test('registration requires acknowledgement of the privacy notice', async () => {
  const api = client();
  await api.initCsrf();
  const result = await api.request('/api/register', { method: 'POST', body: JSON.stringify({
    fullName: 'No Acknowledgement', studentCode: 'TH-NO-CONSENT', email: 'no-ack@example.test',
    password: 'StrongStudentPassword!2026', branch: 'Computer Science (AI)', cgpa: 8, graduationYear: 2027, skills: ''
  }) });
  assert.equal(result.status, 400);
  assert.match(result.payload.error, /privacy notice/);
});

test('unsafe requests from another origin are rejected', async () => {
  const api = client();
  await api.initCsrf();
  const result = await api.request('/api/logout', { method: 'POST', headers: { Origin: 'https://attacker.example' }, body: '{}' });
  assert.equal(result.status, 403);
  assert.match(result.payload.error, /Cross-origin/);
});

test('CSRF protection blocks unsafe requests without a token', async () => {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: demo.studentEmail, password: demo.studentPassword })
  });
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /CSRF/);
});

test('public registration always creates a student, never an elevated role', async () => {
  const api = client();
  const result = await createStudentAccount(api, 'ROLE');
  assert.equal(result.status, 201);
  assert.equal(result.payload.user.role, 'student');
  assert.equal(result.payload.user.isAdmin, undefined);
});

test('students cannot create job listings or view another student profile', async () => {
  const studentOne = client();
  const login = await studentOne.login(demo.studentEmail, demo.studentPassword);
  assert.equal(login.status, 200);
  const self = await studentOne.request('/api/me');
  const studentTwo = client();
  const created = await createStudentAccount(studentTwo, 'IDOR');
  assert.equal(created.status, 201);
  const profileAccess = await studentOne.request(`/api/students/${created.payload.user.id}`);
  assert.equal(profileAccess.status, 403);
  const createJob = await studentOne.request('/api/jobs', { method: 'POST', body: JSON.stringify({}) });
  assert.equal(createJob.status, 403);
  assert.equal(self.payload.user.role, 'student');
});

test('recruiters cannot manage jobs owned by another recruiter', async () => {
  const other = await createSecondRecruiter();
  const recruiterA = client();
  assert.equal((await recruiterA.login(other.email, other.password)).status, 200);
  const job = app.db.prepare('SELECT id FROM jobs LIMIT 1').get();
  const result = await recruiterA.request(`/api/jobs/${job.id}`, { method: 'DELETE', body: '{}' });
  assert.equal(result.status, 403);
});

test('student search uses parameterized input and exposes no credentials', async () => {
  const recruiter = client();
  assert.equal((await recruiter.login(demo.recruiterEmail, demo.recruiterPassword)).status, 200);
  const injection = await recruiter.request('/api/students?q=%25%27%20OR%201%3D1%20--');
  assert.equal(injection.status, 200);
  assert.deepEqual(injection.payload.students, []);
  const all = await recruiter.request('/api/students');
  assert.equal(all.status, 200);
  assert.ok(all.payload.students.length >= 1);
  assert.equal('email' in all.payload.students[0], false);
  assert.equal('password_hash' in all.payload.students[0], false);
});

test('student application lifecycle works and duplicate applications are blocked', async () => {
  const student = client();
  assert.equal((await student.login(demo.studentEmail, demo.studentPassword)).status, 200);
  const jobs = await student.request('/api/jobs');
  assert.ok(jobs.payload.jobs.length >= 1);
  const jobId = jobs.payload.jobs[0].id;
  const eligibility = await student.request(`/api/eligibility/${jobId}`);
  assert.equal(eligibility.payload.eligible, true);
  const first = await student.request(`/api/jobs/${jobId}/apply`, { method: 'POST', body: '{}' });
  assert.equal(first.status, 201);
  const duplicate = await student.request(`/api/jobs/${jobId}/apply`, { method: 'POST', body: '{}' });
  assert.equal(duplicate.status, 409);
});

test('offer download is restricted to its student owner or an administrator', async () => {
  const student = client();
  await student.login(demo.studentEmail, demo.studentPassword);
  const applications = await student.request('/api/applications');
  const application = applications.payload.applications[0];
  assert.ok(application);

  const recruiter = client();
  await recruiter.login(demo.recruiterEmail, demo.recruiterPassword);
  const shortlist = await recruiter.request(`/api/applications/${application.id}/status`, {
    method: 'PATCH', body: JSON.stringify({ status: 'shortlisted' })
  });
  assert.equal(shortlist.status, 200);
  const offer = await recruiter.request('/api/offers', {
    method: 'POST', body: JSON.stringify({ applicationId: application.id, salaryLpa: 9.5, joiningDate: '2027-07-01', message: 'Welcome aboard.' })
  });
  assert.equal(offer.status, 201);

  const otherStudent = client();
  await createStudentAccount(otherStudent, 'OFFER');
  const intruderDownload = await otherStudent.request(`/api/offers/${offer.payload.offer.id}/download`);
  assert.equal(intruderDownload.status, 403);
  const ownerDownload = await student.request(`/api/offers/${offer.payload.offer.id}/download`);
  assert.equal(ownerDownload.status, 200);
  assert.match(ownerDownload.payload, /OFFER LETTER/);
});

test('audit trail is administrator-only', async () => {
  const student = client();
  await student.login(demo.studentEmail, demo.studentPassword);
  const forbidden = await student.request('/api/audit-logs');
  assert.equal(forbidden.status, 403);
  const admin = client();
  await admin.login(demo.adminEmail, demo.adminPassword);
  const allowed = await admin.request('/api/audit-logs');
  assert.equal(allowed.status, 200);
  assert.ok(Array.isArray(allowed.payload.logs));
});
