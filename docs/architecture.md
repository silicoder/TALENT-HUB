# Talent Hub - Architecture and Design Notes

## 1. Purpose

Talent Hub is a local campus-placement demonstration application. It connects students, recruiters and administrators through a role-aware workspace. The implementation is intentionally dependency-light and uses Node.js built-in modules and SQLite.

**Data rule:** use dummy records only. This application is not an operational university placement system.

## 2. Technology

- Node.js built-in HTTP server (`node:http`).
- Node.js built-in cryptography (`node:crypto`, including `scrypt` and secure random tokens).
- SQLite through `node:sqlite`.
- Plain HTML, CSS and browser JavaScript.
- Node's built-in test runner (`node:test`).

The built-in `node:sqlite` API is still classified as a release candidate in current Node.js documentation. The project targets Node.js 22.13+ (so `node:sqlite` is available without an experimental CLI flag) and was tested on Node.js 22.16.0. A production version should move to a supported stable database driver and an appropriately managed database.

## 3. Roles and permissions

| Role | Main capabilities | Restricted actions |
|---|---|---|
| Student | Maintain own profile, browse jobs, check eligibility, apply, view own applications/offers | Cannot create or administer jobs; cannot read another student's profile or offer |
| Recruiter | Create and manage own jobs, search limited student profiles, manage applications for own jobs, issue offers for own shortlisted applicants | Cannot modify another recruiter's jobs/applications/offers |
| Administrator | View platform dashboard and audit trail; review all applications/offers; administer placement records | Must be provisioned explicitly; demo seeding is disabled in production |

Public registration always assigns the `student` role. There is no public role selector.

## 4. Request and session flow

1. The browser requests `/api/csrf`. The server creates an anonymous session when needed and returns a random CSRF token.
2. The browser sends the session cookie automatically and includes the CSRF token in every unsafe API request.
3. The server checks same-origin requests, session validity and CSRF token equality.
4. The route applies authentication, role checks and resource-ownership checks before performing a database operation.
5. Data is returned through purpose-built response projections rather than serializing database rows wholesale.

Session IDs are random opaque tokens. Only their SHA-256 digests are stored in SQLite. Session cookies are HttpOnly and SameSite=Lax; the Secure attribute is enabled in production. Sessions expire after four hours and expired records are periodically removed.

## 5. Main data entities

- `users`: account ID, email, password hash and role.
- `students`: student profile and academic attributes linked to a user.
- `jobs`: position details, eligibility criteria, owner recruiter and status.
- `applications`: student-to-job relationship and workflow status.
- `offers`: demonstration offer information for a shortlisted application.
- `sessions`: hashed session ID, CSRF token, expiry and owner.
- `audit_logs`: selected account and placement actions.

IDs for user-created records are generated with `crypto.randomUUID()`.

## 6. Main API surface

| Endpoint | Method | Access | Purpose |
|---|---|---|---|
| `/api/health` | GET | Public | Health check |
| `/api/csrf` | GET | Public/session | Establish browser CSRF context |
| `/api/register` | POST | Anonymous session | Register a student (privacy acknowledgement required) |
| `/api/login` | POST | Anonymous session | Authenticate account |
| `/api/logout` | POST | Authenticated | End session |
| `/api/me` | GET | Authenticated | Current account and own profile |
| `/api/dashboard` | GET | Authenticated | Role-specific dashboard summary |
| `/api/jobs` | GET | Public | Browse jobs |
| `/api/jobs` | POST | Recruiter/Admin | Create a job |
| `/api/jobs/:id` | PATCH/DELETE | Owner recruiter/Admin | Update or close a job |
| `/api/students` | GET | Recruiter/Admin | Search limited student profiles |
| `/api/students/:id` | GET | Authenticated; student self-only | Read a student profile |
| `/api/me/profile` | PATCH | Student | Update own profile |
| `/api/eligibility/:jobId` | GET | Student | Check own eligibility for a job |
| `/api/jobs/:jobId/apply` | POST | Student | Apply to an eligible job |
| `/api/applications` | GET | Authenticated | View role-scoped applications |
| `/api/applications/:id/status` | PATCH | Owning Recruiter/Admin | Shortlist or reject |
| `/api/offers` | GET/POST | Authenticated; creation Recruiter/Admin | View or create role-scoped offers |
| `/api/offers/:id/download` | GET | Offer owner/Admin | Download a demonstration offer letter |
| `/api/audit-logs` | GET | Admin | Review audit events |

## 7. Security design

- Passwords: salted `scrypt` hashes; the original password is not stored.
- Authentication: generic login failure message, session rotation after login, short session lifetime.
- CSRF: per-session random token plus same-origin check for unsafe methods.
- Authorization: role-based checks plus resource ownership checks.
- SQL injection: prepared statements and bound parameters for user-controlled values.
- Sensitive data: search and profile APIs use an explicit public projection; account email and password hash are not part of recruiter search output.
- Browser security: CSP, frame denial, `nosniff`, referrer and permissions policies.
- Abuse protection: request-size limits and in-memory login/registration rate limits.
- Traceability: audit events for key account, job, application and offer actions.
- Input validation: field length, format, range and enum checks.

## 8. Known limits and production work

This project is for controlled local evaluation. It does not implement email verification, password reset, MFA, a self-service data export/deletion flow, automated incident response, durable distributed rate limits, or a full privacy compliance programme. It has no production TLS termination, managed database, backups, deployment monitoring or formal independent penetration test. The in-memory limiter is single-process only. The offer file is a plain-text demonstration document.

Before any real deployment, replace demo data and the experimental SQLite API, require HTTPS, use durable abuse controls, define retention/deletion, implement appropriate data-subject processes, obtain institutional approval for the privacy notice, and complete independent security and legal review.
