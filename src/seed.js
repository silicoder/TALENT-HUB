'use strict';

const crypto = require('node:crypto');
const { hashPassword } = require('./security');

async function seedDemoData(db, env = process.env) {
  // Demo identities have public sample credentials. Never create them in production.
  if (env.NODE_ENV === 'production') return;
  const accounts = [
    { email: env.DEMO_ADMIN_EMAIL || 'admin@talenthub.local', password: env.DEMO_ADMIN_PASSWORD || 'AdminDemo!ChangeThis2026', role: 'admin' },
    { email: env.DEMO_RECRUITER_EMAIL || 'recruiter@talenthub.local', password: env.DEMO_RECRUITER_PASSWORD || 'RecruiterDemo!ChangeThis2026', role: 'recruiter' },
    { email: env.DEMO_STUDENT_EMAIL || 'student@talenthub.local', password: env.DEMO_STUDENT_PASSWORD || 'StudentDemo!ChangeThis2026', role: 'student' }
  ];
  const insertUser = db.prepare('INSERT OR IGNORE INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)');
  const findUser = db.prepare('SELECT id FROM users WHERE email = ?');
  for (const account of accounts) {
    insertUser.run(crypto.randomUUID(), account.email.toLowerCase(), await hashPassword(account.password), account.role);
  }
  const studentId = findUser.get(accounts[2].email).id;
  db.prepare(`INSERT OR IGNORE INTO students (user_id, full_name, student_code, branch, cgpa, graduation_year, skills)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(studentId, 'Aarav Sharma', 'TH-DEMO-001', 'Computer Science (AI)', 8.4, 2027, 'Node.js, Python, SQL, REST APIs');
  const recruiterId = findUser.get(accounts[1].email).id;
  const exists = db.prepare('SELECT 1 FROM jobs WHERE recruiter_id = ? LIMIT 1').get(recruiterId);
  if (!exists) {
    const addJob = db.prepare(`INSERT INTO jobs (id, recruiter_id, title, company, description, location, min_cgpa, eligible_branches)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    addJob.run(crypto.randomUUID(), recruiterId, 'Graduate Software Engineer', 'Northstar Technologies',
      'Build reliable backend services, collaborate with product teams, and learn modern cloud-native engineering practices.',
      'Bengaluru / Hybrid', 7.0, JSON.stringify(['Computer Science', 'Computer Science (AI)', 'Information Science']));
    addJob.run(crypto.randomUUID(), recruiterId, 'Associate Data Analyst', 'Meridian Analytics',
      'Work with structured datasets, create clear reporting, and communicate actionable insights to business teams.',
      'Pune / Hybrid', 7.5, JSON.stringify(['Computer Science', 'Computer Science (AI)', 'Data Science']));
  }
}

module.exports = { seedDemoData };
