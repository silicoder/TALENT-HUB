# Talent Hub

A secure campus placement and talent-management portal built with Node.js, SQLite and a responsive browser interface. The project supports three distinct roles: **Student**, **Recruiter** and **Administrator**.

> **Coursework scope:** This is a local, dummy-data demonstration application for the AI-Assisted Software Development Laboratory 7 security-review workflow. It is not a production placement platform and must not be populated with real student records.

## Features

### Student workspace
- Register a student account and sign in.
- Maintain a profile with branch, CGPA, graduation year and skills.
- Browse open roles and filter by search term or eligible branch.
- Check job eligibility before applying.
- Submit applications and track their status.
- Download an offer-letter demonstration document when an offer is issued.

### Recruiter workspace
- Publish job listings with branch and CGPA criteria.
- Search limited student profile information.
- View applications for jobs owned by the signed-in recruiter.
- Shortlist or reject candidates and issue offers to shortlisted applicants.
- Close job listings.

### Administrator workspace
- View platform metrics and a recent audit trail.
- Review all applications and offers.

## Technology

- Node.js built-in HTTP server and cryptography APIs.
- SQLite through the built-in `node:sqlite` module.
- HTML, CSS and browser JavaScript.
- Node.js built-in test runner (`node:test`).

There are no third-party runtime npm packages. This limits the dependency and supply-chain surface and keeps setup simple. The SQLite API is still a release-candidate/experimental Node.js API; see the runtime note below.

## Requirements

- Node.js **22.13 or later** (the project was built and tested with Node.js 22.16.0).
- npm (included with Node.js).

`node:sqlite` was introduced in Node 22.5 and can be used without the `--experimental-sqlite` flag from Node 22.13 onward. In the Node 22.16 runtime used for this project it is still experimental. Newer Node.js documentation marks it as a release candidate. For production, use a stable database driver and a managed database such as PostgreSQL. The app is intended for a controlled local lab environment.

## Run locally

Open PowerShell or a terminal in the project folder:

```bash
npm install
```

Copy `.env.example` to `.env` and review the demo settings. On PowerShell:

```powershell
Copy-Item .env.example .env
```

On macOS/Linux:

```bash
cp .env.example .env
```

Start the app:

```bash
npm start
```

Open **http://localhost:3000**.

For automatic restart while developing:

```bash
npm run dev
```

The SQLite database is created automatically at `data/talent-hub.sqlite`. Do not commit this file; it is excluded by `.gitignore`.

## Demo accounts

These accounts are seeded only in development/test environments. Production mode never seeds demo accounts, even if `SEED_DEMO=true` is set. The credentials below are public sample credentials and must never be used for a real deployment.

| Role | Email | Password |
|---|---|---|
| Administrator | `admin@talenthub.local` | `AdminDemo!ChangeThis2026` |
| Recruiter | `recruiter@talenthub.local` | `RecruiterDemo!ChangeThis2026` |
| Student | `student@talenthub.local` | `StudentDemo!ChangeThis2026` |

Public registration always creates a **student** role. It is not possible to select `recruiter` or `admin` through the registration API. In a controlled production bootstrap, provision the first administrator explicitly with `ADMIN_EMAIL`, `ADMIN_PASSWORD` and `DATABASE_PATH`, then run `node scripts/create-admin.js`; do not enable demo seeding.

## Tests

Run the automated functional and security regression tests:

```bash
npm test
```

The tests cover security headers, CSRF enforcement, role restrictions, student object-level authorization, recruiter job ownership, SQL-injection-style search input, privacy-minimized student search responses, duplicate application prevention, offer download authorization and administrator-only audit access.

## Publish to GitHub

The repository is prepared with its Git history. Create an empty repository on GitHub (do not pre-create a README, .gitignore or licence), then clone the supplied `Talent-Hub.bundle` and push the `main` branch:

```powershell
git clone .\Talent-Hub.bundle talent-hub
cd talent-hub
.\scripts\push-to-github.ps1 -RepositoryUrl "https://github.com/<YOUR-USERNAME>/talent-hub.git"
```

GitHub authentication is handled by your local Git Credential Manager/browser or configured SSH. Do not place a personal access token in the repository URL or commit it.

## Security review commands

```bash
npm audit
semgrep scan --config security/semgrep-rules.yml .
npm test
```

`npm audit` should report no dependency vulnerabilities because the project has no external npm dependencies. Semgrep is an optional external tool and must be installed separately. If it is unavailable in the lab machine, record that honestly in the review rather than marking the scan as passed.

## Security controls implemented

| Control | Implementation |
|---|---|
| Authentication | Passwords hashed using Node.js `scrypt`; generic sign-in errors |
| Session protection | Random 256-bit opaque session ID; only SHA-256 hash stored server-side; session rotates at sign-in |
| Cookie protection | HttpOnly, SameSite=Lax; Secure flag in production |
| CSRF | Per-session random token required for unsafe API requests; same-origin check |
| Authorization | Role checks on recruiter/admin actions; ownership checks for jobs, applications and offer files |
| Student privacy | Student search returns a restricted profile projection, never password hashes or account email |
| SQL injection | SQLite prepared statements and bound parameters for user-controlled values |
| Identifier guessing | UUID v4 identifiers for users, jobs, applications, offers and audit records |
| Browser hardening | Content Security Policy, X-Content-Type-Options, X-Frame-Options, Referrer-Policy and Permissions-Policy |
| Abuse controls | IP-based rate limits on login and registration; request body size limit |
| Accountability | Audit trail for key account, job, application and offer actions |
| Error handling | Generic API error response; detailed exceptions stay in server logs |

## Important limitations

- Use only dummy data. Do not upload real resumes, government IDs, phone numbers, addresses, bank details or other sensitive information.
- The application does not provide email verification, password reset, MFA, automated incident response or a complete DPDPA compliance programme.
- The IP rate limiter is in-memory and suitable only for a single-process local demonstration.
- The offer download is a plain-text demonstration document, not a legally valid signed offer letter.
- Production deployment would require HTTPS termination, a stable database/runtime, durable distributed rate limiting, backups, monitoring, operational access controls and a formal privacy/legal review.

## Repository layout

```text
Talent-Hub/
├── public/                 # Browser interface
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── src/
│   ├── db.js               # SQLite schema and connection
│   ├── security.js         # Password and session token utilities
│   ├── seed.js             # Development demo data
│   └── server.js           # HTTP server, routes and authorization
├── tests/
│   └── security.test.js    # Functional/security regression tests
├── security/
│   └── semgrep-rules.yml   # Local static-analysis rules
├── docs/                   # Design and review documentation
├── reports/                # Lab evidence and analysis results
├── .env.example
├── .gitignore
├── LICENSE
├── package.json
└── README.md
```
