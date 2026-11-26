'use strict';

const state = { user: null, profile: null, csrfToken: null, jobs: [], page: 'dashboard' };
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function initials(value = 'Talent Hub') {
  return String(value).split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join('');
}
function toast(message, isError = false) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.toggle('error', isError);
  node.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove('show'), 3300);
}

async function refreshCsrf() {
  const response = await fetch('/api/csrf', { credentials: 'same-origin' });
  const data = await response.json();
  state.csrfToken = data.csrfToken;
}

async function api(url, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const headers = { ...(options.headers || {}) };
  if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    if (!state.csrfToken) await refreshCsrf();
    headers['X-CSRF-Token'] = state.csrfToken;
  }
  const response = await fetch(url, { ...options, method, headers, credentials: 'same-origin' });
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 403 && String(data.error || '').includes('CSRF')) {
        state.csrfToken = null;
      }
      throw new Error(data.error || 'Request failed.');
    }
    if (data.csrfToken) state.csrfToken = data.csrfToken;
    return data;
  }
  if (!response.ok) throw new Error('Request failed.');
  return response;
}

function showAuth(mode = 'login') {
  $('#auth-view').classList.remove('hidden');
  $('#app-view').classList.add('hidden');
  const registering = mode === 'register';
  $('#login-form').classList.toggle('hidden', registering);
  $('#register-form').classList.toggle('hidden', !registering);
  $('#show-login').classList.toggle('active', !registering);
  $('#show-register').classList.toggle('active', registering);
  $('#auth-eyebrow').textContent = registering ? 'YOUR NEXT CHAPTER STARTS HERE' : 'WELCOME BACK';
  $('#auth-title').textContent = registering ? 'Create your student account' : 'Sign in to your space';
  $('#auth-subtitle').textContent = registering ? 'Build your profile and discover opportunities.' : 'Pick up where your career journey left off.';
}

function showApp() {
  $('#auth-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  const displayName = state.profile?.fullName || state.user?.email?.split('@')[0] || 'Member';
  $('#user-name').textContent = displayName;
  $('#user-role').textContent = state.user.role;
  $('#avatar').textContent = initials(displayName);
  $('#today-label').textContent = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' }).format(new Date());
  buildNavigation();
  navigate('dashboard');
}

function navigationItems() {
  const role = state.user.role;
  const items = [
    { id: 'dashboard', label: 'Overview', icon: '⌂' },
    { id: 'jobs', label: 'Explore jobs', icon: '⌕' },
    { id: 'applications', label: 'Applications', icon: '▤' },
    { id: 'offers', label: 'Offer letters', icon: '✧' }
  ];
  if (role === 'student') items.push({ id: 'profile', label: 'My profile', icon: '◉' });
  if (role === 'recruiter' || role === 'admin') {
    items.push({ id: 'post-job', label: 'Post a job', icon: '+' });
    items.push({ id: 'students', label: 'Find students', icon: '◎' });
  }
  if (role === 'admin') items.push({ id: 'audit', label: 'Audit trail', icon: '⌁' });
  return items;
}

function buildNavigation() {
  $('#side-nav').innerHTML = navigationItems().map((item) => `
    <button class="nav-link ${state.page === item.id ? 'active' : ''}" data-page="${item.id}" type="button">
      <span class="nav-icon">${item.icon}</span><span>${item.label}</span>
    </button>`).join('');
  $$('.nav-link').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.page)));
}

function pageHead(kicker, title, subtitle, action = '') {
  return `<div class="page-head"><div><p class="eyebrow">${kicker}</p><h1>${title}</h1><p>${subtitle}</p></div>${action ? `<div class="page-actions">${action}</div>` : ''}</div>`;
}
function metric(label, value, caption, icon) {
  return `<article class="metric-card"><div class="metric-top"><span>${label}</span><span class="metric-icon">${icon}</span></div><div class="metric-number">${value}</div><div class="metric-caption">${caption}</div></article>`;
}
function statusBadge(status) {
  return `<span class="status ${escapeHtml(status)}">${escapeHtml(status)}</span>`;
}
function emptyState(message) { return `<div class="empty-state">${escapeHtml(message)}</div>`; }

async function navigate(page) {
  state.page = page;
  buildNavigation();
  const label = navigationItems().find((item) => item.id === page)?.label || 'Overview';
  $('#page-label').textContent = label;
  const content = $('#content');
  content.innerHTML = '<div class="empty-state">Loading your workspace…</div>';
  try {
    switch (page) {
      case 'dashboard': await renderDashboard(content); break;
      case 'jobs': await renderJobs(content); break;
      case 'applications': await renderApplications(content); break;
      case 'offers': await renderOffers(content); break;
      case 'profile': await renderProfile(content); break;
      case 'post-job': renderPostJob(content); break;
      case 'students': await renderStudents(content); break;
      case 'audit': await renderAudit(content); break;
      default: await renderDashboard(content);
    }
  } catch (error) {
    content.innerHTML = `<div class="notice">${escapeHtml(error.message)}</div>`;
  }
}

async function renderDashboard(root) {
  const data = await api('/api/dashboard');
  const role = state.user.role;
  let metrics = '';
  let recentTitle = 'Your recent applications';
  let recentRows = [];
  let recentHeaders = '<th>Opportunity</th><th>Company</th><th>Status</th><th>Applied</th>';
  if (role === 'student') {
    metrics = metric('Open opportunities', data.openJobs, 'Roles currently accepting applications', '⌕') +
      metric('My applications', data.myApplications, 'Applications submitted', '▤') +
      metric('Offers received', data.myOffers, 'Offer letters waiting for you', '✧') +
      metric('Profile status', 'Live', 'Visible to approved recruiters', '◉');
    recentRows = data.recentApplications.map((item) => `<tr><td class="cell-strong">${escapeHtml(item.title)}</td><td>${escapeHtml(item.company)}</td><td>${statusBadge(item.status)}</td><td>${new Date(item.created_at).toLocaleDateString('en-IN')}</td></tr>`);
  } else if (role === 'recruiter') {
    metrics = metric('My job posts', data.myJobs, 'Opportunities you manage', '▣') +
      metric('Open roles', data.openJobs, 'Actively accepting applications', '↗') +
      metric('Total applicants', data.applicants, 'Across your job posts', '◎') +
      metric('Workspace', 'Active', 'Recruiter access enabled', '◇');
    recentTitle = 'Latest applicants';
    recentHeaders = '<th>Candidate</th><th>Opportunity</th><th>Status</th><th>Received</th>';
    recentRows = data.recentApplications.map((item) => `<tr><td class="cell-strong">${escapeHtml(item.full_name)}</td><td>${escapeHtml(item.title)}</td><td>${statusBadge(item.status)}</td><td>${new Date(item.created_at).toLocaleDateString('en-IN')}</td></tr>`);
  } else {
    metrics = metric('Students', data.students, 'Registered student accounts', '◉') +
      metric('Recruiters', data.recruiters, 'Verified recruiter accounts', '◎') +
      metric('Job listings', data.jobs, 'All posted opportunities', '▣') +
      metric('Applications', data.applications, 'Total submitted applications', '▤');
  }
  const table = recentRows.length ? `<div class="table-wrap"><table class="data-table"><thead><tr>${recentHeaders}</tr></thead><tbody>${recentRows.join('')}</tbody></table></div>` : emptyState('Nothing to show yet. Your activity will appear here.');
  root.innerHTML = `${pageHead('YOUR WORKSPACE', `Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}, ${escapeHtml((state.profile?.fullName || state.user.email.split('@')[0]).split(' ')[0])}.`, 'Here is what is happening across your Talent Hub today.', '<button class="button button-primary" id="dashboard-action">'+(role === 'student' ? 'Explore opportunities →' : role === 'recruiter' ? 'Post a new role →' : 'View audit trail →')+'</button>')}
    <section class="metric-grid">${metrics}</section>
    <section class="dashboard-grid"><article class="panel"><div class="panel-head"><h3>${recentTitle}</h3><button class="text-link" id="view-applications">View all →</button></div>${table}</article>
      <div><article class="quick-card"><p class="eyebrow">${role === 'student' ? 'YOUR NEXT OPPORTUNITY' : 'MAKE THINGS HAPPEN'}</p><h3>${role === 'student' ? 'A good role is closer than you think.' : role === 'recruiter' ? 'Find the right talent, faster.' : 'Keep the platform healthy.'}</h3><p>${role === 'student' ? 'Explore verified openings, check your eligibility and keep every application in one place.' : role === 'recruiter' ? 'Publish a clear role, review eligible candidates and move promising applications forward.' : 'Review platform activity, monitor access and keep data handling accountable.'}</p><button class="button" id="quick-action">${role === 'student' ? 'Browse open roles →' : role === 'recruiter' ? 'Create a job post →' : 'Open audit trail →'}</button></article>
      <article class="panel"><div class="panel-head"><h3>Good practices</h3><span>YOUR CHECKLIST</span></div><div class="tip-list"><div class="tip-item"><span class="tip-bullet">✓</span><div><strong>Keep your profile accurate</strong><span>Current skills and academic details improve matching.</span></div></div><div class="tip-item"><span class="tip-bullet">◇</span><div><strong>Use your own account</strong><span>Never share passwords or active sessions.</span></div></div><div class="tip-item"><span class="tip-bullet">↗</span><div><strong>Review every opportunity</strong><span>Check the role details and eligibility before applying.</span></div></div></div></article></div>
    </section>`;
  const target = role === 'student' ? 'jobs' : role === 'recruiter' ? 'post-job' : 'audit';
  $('#dashboard-action', root).addEventListener('click', () => navigate(target));
  $('#quick-action', root).addEventListener('click', () => navigate(target));
  $('#view-applications', root).addEventListener('click', () => navigate('applications'));
}

async function renderJobs(root) {
  const result = await api('/api/jobs');
  state.jobs = result.jobs;
  root.innerHTML = `${pageHead('DISCOVER OPPORTUNITY', 'Explore open roles', 'Find a role that matches your strengths and career direction.')}
    <div class="filter-bar"><div class="search-box"><input id="job-search" placeholder="Search by role, company or keyword…" aria-label="Search jobs"></div><select id="job-branch"><option value="">All eligible branches</option>${['Computer Science','Computer Science (AI)','Information Science','Electronics and Communication','Electrical and Electronics','Mechanical','Civil','Data Science'].map((branch) => `<option>${branch}</option>`).join('')}</select></div>
    <div class="cards-grid" id="job-grid">${renderJobCards(result.jobs)}</div>`;
  $('#job-search', root).addEventListener('input', filterJobs);
  $('#job-branch', root).addEventListener('change', filterJobs);
  // Bind Apply buttons when jobs are first displayed
  bindApplyButtons();
}
}
function renderJobCards(jobs) {
  if (!jobs.length) return emptyState('No roles match your search right now.');
  return jobs.map((job) => `<article class="job-card"><div class="job-company"><div class="company-mark">${escapeHtml(initials(job.company))}</div><div><strong>${escapeHtml(job.company)}</strong><span>${escapeHtml(job.location)}</span></div></div><div class="job-title">${escapeHtml(job.title)}</div><div class="job-meta"><span>◉ Min. CGPA ${Number(job.min_cgpa).toFixed(1)}</span><span>◇ ${job.eligibleBranches.length} eligible branches</span></div><p class="job-description">${escapeHtml(job.description)}</p><div class="tag-row">${job.eligibleBranches.slice(0, 3).map((branch) => `<span class="tag">${escapeHtml(branch)}</span>`).join('')}${job.eligibleBranches.length > 3 ? `<span class="tag">+${job.eligibleBranches.length - 3} more</span>` : ''}</div><div class="job-footer"><small>Posted ${new Date(job.created_at).toLocaleDateString('en-IN')}</small>${state.user.role === 'student' ? `<button class="button button-primary button-small apply-button" data-job="${job.id}">Check & apply →</button>` : `<span class="status open">Open</span>`}</div></article>`).join('');
}
function filterJobs() {
  const q = $('#job-search').value.toLowerCase();
  const branch = $('#job-branch').value;
  const filtered = state.jobs.filter((job) => (!branch || job.eligibleBranches.includes(branch)) && [job.title, job.company, job.description, job.location].join(' ').toLowerCase().includes(q));
  $('#job-grid').innerHTML = renderJobCards(filtered);
  bindApplyButtons();
}
function bindApplyButtons() {
  $$('.apply-button').forEach((button) => button.addEventListener('click', async () => {
    try {
      const eligibility = await api(`/api/eligibility/${button.dataset.job}`);
      if (!eligibility.eligible) return toast(eligibility.reasons.join(' '), true);
      if (!confirm(`You meet the listed criteria for ${eligibility.job.title}. Submit your application?`)) return;
      await api(`/api/jobs/${button.dataset.job}/apply`, { method: 'POST', body: '{}' });
      toast('Application submitted successfully.');
      await navigate('applications');
    } catch (error) { toast(error.message, true); }
  }));
}

async function renderApplications(root) {
  const { applications } = await api('/api/applications');
  const role = state.user.role;
  const rows = applications.map((item) => `<tr><td class="cell-strong">${escapeHtml(role === 'student' ? item.title : item.full_name || 'Candidate')}</td><td>${escapeHtml(role === 'student' ? item.company : item.title)}</td><td>${statusBadge(item.status)}</td><td>${new Date(item.created_at).toLocaleDateString('en-IN')}</td><td>${role === 'student' ? escapeHtml(item.location || '—') : role === 'admin' || role === 'recruiter' ? `<div class="inline-actions"><button class="button button-secondary button-small status-button" data-id="${item.id}" data-status="shortlisted">Shortlist</button><button class="button button-ghost button-small status-button" data-id="${item.id}" data-status="rejected">Reject</button>${item.status === 'shortlisted' ? `<button class="button button-primary button-small offer-button" data-id="${item.id}">Make offer</button>` : ''}</div>` : ''}</td></tr>`).join('');
  root.innerHTML = `${pageHead('TRACK PROGRESS', role === 'student' ? 'My applications' : 'Application pipeline', role === 'student' ? 'Track every opportunity you have applied to.' : 'Review candidates for opportunities you manage.')}
    <article class="panel"><div class="panel-head"><h3>${applications.length} ${applications.length === 1 ? 'application' : 'applications'}</h3><span>RECENT FIRST</span></div>${applications.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>${role === 'student' ? 'Role' : 'Candidate'}</th><th>${role === 'student' ? 'Company' : 'Opportunity'}</th><th>Status</th><th>Date</th><th>${role === 'student' ? 'Location' : 'Actions'}</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState('No applications yet. Start by exploring open roles.')}</article>`;
  $$('.status-button', root).forEach((button) => button.addEventListener('click', async () => {
    try { await api(`/api/applications/${button.dataset.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: button.dataset.status }) }); toast(`Application ${button.dataset.status}.`); renderApplications(root); }
    catch (error) { toast(error.message, true); }
  }));
  $$('.offer-button', root).forEach((button) => button.addEventListener('click', async () => {
    const salaryLpa = Number(prompt('Offer compensation (LPA):', '8'));
    if (!salaryLpa || !Number.isFinite(salaryLpa)) return;
    const joiningDate = prompt('Joining date (YYYY-MM-DD):', '2027-07-01');
    if (!joiningDate) return;
    try { await api('/api/offers', { method: 'POST', body: JSON.stringify({ applicationId: button.dataset.id, salaryLpa, joiningDate, message: 'Congratulations. We are pleased to make you this offer.' }) }); toast('Offer created successfully.'); renderApplications(root); }
    catch (error) { toast(error.message, true); }
  }));
}

async function renderOffers(root) {
  const { offers } = await api('/api/offers');
  const cards = offers.map((offer) => `<article class="offer-card"><div class="job-company"><div class="company-mark">${escapeHtml(initials(offer.company))}</div><div><strong>${escapeHtml(offer.company)}</strong><span>${escapeHtml(offer.title)}</span></div></div><div class="offer-salary">₹${Number(offer.salary_lpa).toFixed(2)} LPA</div><div class="offer-caption">Compensation package</div><div class="offer-actions"><small class="muted">Joining ${escapeHtml(offer.joining_date)}</small><button class="button button-secondary button-small download-offer" data-id="${offer.id}">Download letter ↓</button></div></article>`).join('');
  root.innerHTML = `${pageHead('THE NEXT CHAPTER', 'Offer letters', 'Your formal offers, kept together in one secure place.')}${offers.length ? `<div class="offer-grid">${cards}</div>` : `<article class="panel">${emptyState('No offer letters yet. When an offer is created, it will appear here.')}</article>`}`;
  $$('.download-offer', root).forEach((button) => button.addEventListener('click', async () => {
    try {
      const response = await api(`/api/offers/${button.dataset.id}/download`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = `offer-letter-${button.dataset.id}.txt`; link.click(); URL.revokeObjectURL(url);
    } catch (error) { toast(error.message, true); }
  }));
}

async function renderProfile(root) {
  const { profile } = await api('/api/me');
  state.profile = profile;
  const branches = ['Computer Science','Computer Science (AI)','Information Science','Electronics and Communication','Electrical and Electronics','Mechanical','Civil','Data Science'];
  root.innerHTML = `${pageHead('YOUR PROFESSIONAL IDENTITY', 'My profile', 'Keep your academic profile clear, accurate and up to date.')}
    <div class="profile-grid"><div><div class="profile-intro"><div class="student-avatar">${escapeHtml(initials(profile.fullName))}</div><h2>${escapeHtml(profile.fullName)}</h2><p>${escapeHtml(profile.studentCode)} · ${escapeHtml(profile.branch)}</p></div><article class="panel"><form id="profile-form" class="profile-fields"><div class="form-grid two"><label class="field-label">Full name<input name="fullName" value="${escapeHtml(profile.fullName)}" required maxlength="80"></label><label class="field-label">Student ID<input value="${escapeHtml(profile.studentCode)}" disabled></label></div><div class="form-grid two"><label class="field-label">Branch<select name="branch">${branches.map((branch) => `<option ${branch === profile.branch ? 'selected' : ''}>${branch}</option>`).join('')}</select></label><label class="field-label">CGPA<input type="number" name="cgpa" min="0" max="10" step="0.01" value="${profile.cgpa}" required></label></div><div class="form-grid two"><label class="field-label">Graduation year<input type="number" name="graduationYear" min="2020" max="2040" value="${profile.graduationYear}" required></label><label class="field-label">Skills<input name="skills" maxlength="500" value="${escapeHtml(profile.skills)}"></label></div><button class="button button-primary" type="submit">Save profile changes →</button></form></article></div>
    <aside class="panel"><div class="panel-head"><h3>Profile visibility</h3><span>PRIVACY</span></div><div class="info-note"><strong>What recruiters can see</strong><br>Your name, student ID, branch, CGPA, graduation year and skills may be shown to authenticated recruiters and administrators. Your password and private account credentials are never included in student search responses.</div><div class="profile-gap"></div><div class="info-note"><strong>Keep it current</strong><br>Only provide information relevant to campus hiring. Do not enter government ID numbers, bank details or other unnecessary sensitive information in the skills field.</div></aside></div>`;
  $('#profile-form', root).addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload = Object.fromEntries(form.entries());
    try { const data = await api('/api/me/profile', { method: 'PATCH', body: JSON.stringify(payload) }); state.profile = data.profile; toast('Profile updated.'); showApp(); navigate('profile'); }
    catch (error) { toast(error.message, true); }
  });
}

function renderPostJob(root) {
  const branches = ['Computer Science','Computer Science (AI)','Information Science','Electronics and Communication','Electrical and Electronics','Mechanical','Civil','Data Science'];
  root.innerHTML = `${pageHead('RECRUITER WORKSPACE', 'Publish an opportunity', 'Write a clear role description so the right candidates can find you.')}
    <div class="form-panel"><article class="panel"><h3>Job details</h3><form id="job-form" class="form-stack"><div class="form-grid two"><label class="field-label">Job title<input name="title" required minlength="3" maxlength="100" placeholder="e.g. Graduate Software Engineer"></label><label class="field-label">Company<input name="company" required minlength="2" maxlength="100" placeholder="Company name"></label></div><div class="form-grid two"><label class="field-label">Location<input name="location" required maxlength="100" placeholder="Bengaluru / Hybrid"></label><label class="field-label">Minimum CGPA<input type="number" name="minCgpa" min="0" max="10" step="0.1" required value="7"></label></div><label class="field-label">Role description<textarea name="description" minlength="20" maxlength="3000" required placeholder="Describe responsibilities, required skills and what the candidate will learn..."></textarea></label><div><div class="field-label">Eligible branches</div><div class="checkbox-grid">${branches.map((branch) => `<label class="check-label"><input type="checkbox" name="eligibleBranches" value="${branch}"> ${branch}</label>`).join('')}</div></div><button class="button button-primary" type="submit">Publish job →</button></form></article></div>`;
  $('#job-form', root).addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload = Object.fromEntries(form.entries());
    payload.minCgpa = Number(payload.minCgpa);
    payload.eligibleBranches = form.getAll('eligibleBranches');
    try { await api('/api/jobs', { method: 'POST', body: JSON.stringify(payload) }); toast('Your job is now live.'); navigate('jobs'); }
    catch (error) { toast(error.message, true); }
  });
}

async function renderStudents(root) {
  const { students } = await api('/api/students');
  state.students = students;
  root.innerHTML = `${pageHead('TALENT DIRECTORY', 'Find students', 'Search academic profiles shared with authorized recruiters.')}
    <div class="filter-bar"><div class="search-box"><input id="student-search" placeholder="Search by name, branch, skills or student ID…"></div></div><div class="student-list" id="student-list">${renderStudentCards(students)}</div>`;
  $('#student-search', root).addEventListener('input', () => {
    const term = $('#student-search', root).value.toLowerCase();
    const filtered = state.students.filter((student) => [student.fullName, student.branch, student.skills, student.studentCode].join(' ').toLowerCase().includes(term));
    $('#student-list', root).innerHTML = renderStudentCards(filtered);
  });
}
function renderStudentCards(students) {
  if (!students.length) return emptyState('No matching student profiles found.');
  return students.map((student) => `<article class="student-card"><div class="student-avatar">${escapeHtml(initials(student.fullName))}</div><div class="student-main"><strong>${escapeHtml(student.fullName)}</strong><span>${escapeHtml(student.studentCode)} · ${escapeHtml(student.branch)}</span><div class="tag-row student-skills">${escapeHtml(student.skills).split(',').filter(Boolean).slice(0, 5).map((skill) => `<span class="tag">${escapeHtml(skill.trim())}</span>`).join('')}</div></div><div class="student-stats"><div><b>${Number(student.cgpa).toFixed(2)}</b>CGPA</div><div><b>${student.graduationYear}</b>Graduates</div></div></article>`).join('');
}

async function renderAudit(root) {
  const { logs } = await api('/api/audit-logs');
  const rows = logs.map((log) => `<div class="log-row"><strong>${escapeHtml(log.action)}</strong><span>${escapeHtml(log.actor_email || 'Deleted account')}</span><span>${escapeHtml(log.target_type)} · ${escapeHtml(log.target_id || '—').slice(0, 12)}</span><span>${new Date(log.created_at).toLocaleString('en-IN')}</span></div>`).join('');
  root.innerHTML = `${pageHead('PLATFORM GOVERNANCE', 'Audit trail', 'A record of security-relevant account and platform actions.')}
    <div class="notice">Audit entries help support accountability. They do not replace infrastructure logs, incident response or a formal compliance audit.</div><article class="panel"><div class="panel-head"><h3>Recent activity</h3><span>${logs.length} RECORDS · LATEST FIRST</span></div><div class="log-list">${rows || emptyState('No activity recorded yet.')}</div></article>`;
}

$('#show-login').addEventListener('click', () => showAuth('login'));
$('#show-register').addEventListener('click', () => showAuth('register'));
$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
  try { const data = await api('/api/login', { method: 'POST', body: JSON.stringify(payload) }); state.user = data.user; state.csrfToken = data.csrfToken; await loadMe(); showApp(); }
  catch (error) { toast(error.message, true); }
});
$('#register-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
  payload.cgpa = Number(payload.cgpa); payload.graduationYear = Number(payload.graduationYear);
  payload.privacyAcknowledged = new FormData(event.currentTarget).get('privacyAcknowledged') === 'true';
  try { const data = await api('/api/register', { method: 'POST', body: JSON.stringify(payload) }); state.user = data.user; state.csrfToken = data.csrfToken; await loadMe(); showApp(); toast('Your account is ready.'); }
  catch (error) { toast(error.message, true); }
});
$('#logout-button').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST', body: '{}' }); state.user = null; state.profile = null; state.csrfToken = null; await refreshCsrf(); showAuth('login'); toast('You have signed out.'); }
  catch (error) { toast(error.message, true); }
});

async function loadMe() {
  const data = await api('/api/me');
  state.user = data.user;
  state.profile = data.profile;
}

(async function init() {
  try {
    await refreshCsrf();
    await loadMe();
    showApp();
  } catch {
    showAuth('login');
  }
})();
