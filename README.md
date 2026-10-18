# TOP CLOUD — Staff Recruitment Portal

**Made by Tanveer**

A complete staff recruitment portal: a public recruitment website with dynamic,
per-position application forms, an applicant account area, a staff review
console at `/admin`, and a Super Owner console at `/admin/owner` for managing
positions, forms, staff, permissions, analytics, audit logs, health and
backups — in one Node.js + SQLite deployment.

---

## Contents

- [Features](#features)
- [Tech stack](#tech-stack)
- [Quick start (development)](#quick-start-development)
- [Production install (one command)](#production-install-one-command)
- [Updating an existing installation](#updating-an-existing-installation)
- [Configuration](#configuration)
- [Super Owner bootstrap](#super-owner-bootstrap)
- [Roles & permissions](#roles--permissions)
- [Testing](#testing)
- [Security](#security)
- [Backups & health](#backups--health)
- [Project layout](#project-layout)

---

## Features

**Public website (no login required)**

- Landing page with live, open-positions list (no fake statistics).
- Position details with eligibility, duties and the exact application form.
- Eligibility page.
- Application forms are **dynamically built per position**: the owner configures
  fields (text, email, textarea, number, select, date, radio, checkbox) in the
  dashboard, and applicants see exactly those fields, server-side validated.
- Application confirmation with a unique reference number (`TC-YYYY-XXXXXX`).
- One application per position per account (duplicates are rejected cleanly).

**Applicant area (`/account`)**

- Registration, login (password policy: 10–200 chars, letter + digit), logout.
- Dashboard: own applications with live status timeline.
- Application status history and owner/reviewer **messages** (separate channel
  from internal notes — applicants never see internal notes).
- Forced password change on first login when the owner sets a new password.

**Staff console (`/admin`)**

- Review queue with filters (status, position, search, date range).
- Assign a reviewer, update status (submitted → reviewing → approved /
  rejected / withdrawn), add internal notes (never applicant-visible) and send
  applicant-visible messages.
- Staff can switch to the owner console **only if they have owner access**.

**Super Owner console (`/admin/owner`)**

- Manage positions (create/edit/close, per-position dynamic form builder).
- Manage staff accounts (create, reset password, enable/disable) and
  fine-grained permissions (9 permissions, per-user overrides).
- Applications overview, analytics (real counts only), audit log.
- Health panel (config summary, DB, service), manual backup creation/verify/
  download with retention.
- Settings (organisation profile, contact details shown on the public site).

**Single Super Owner** — one bootstrap-created super owner account (no
hardcoded credentials anywhere; the password is generated once at install and
shown/saved exactly once). Super Owner cannot be demoted or removed by anyone
other than themselves, and there is no self-promotion path for applicants or
regular admins.

---

## Tech stack

| Layer      | Choice                                          |
| ---------- | ----------------------------------------------- |
| Runtime    | Node.js ≥ 22.5 (uses built-in `node:sqlite`)    |
| Language   | TypeScript (run via `tsx`, type-checked by `tsc`) |
| Web        | Express 4 + EJS server-rendered views           |
| Database   | SQLite (WAL mode) via built-in `node:sqlite`    |
| Sessions   | HMAC-signed opaque session tokens (HttpOnly, SameSite=Lax) |
| No native deps, no CDN — installs cleanly on a bare Ubuntu/Debian VPS. |

---

## Quick start (development)

```bash
git clone <repo-url> && cd Websitev4
npm install

# 1. Create .env (the app refuses to start with a clear message if missing):
cat > .env <<'EOF'
PORT=8080
HOST=127.0.0.1
DATABASE_URL=file:./data/topcloud.db
SESSION_SECRET=change-me-to-at-least-32-random-characters
OWNER_USERNAME=tanveer
EOF
mkdir -p data

# 2. Apply migrations (safe to rerun):
npm run migrate

# 3. Bootstrap the Super Owner (generates a one-time password; idempotent):
npm run bootstrap-owner

# 4. (Optional) seed demo data: 3 positions + demo staff/applicant accounts.
#    Demo credentials are printed to the console ONLY during seeding.
DEMO_SEED=1 npm run seed:demo

# 5. Run:
npm start
```

Open http://localhost:8080. Log in with the owner credentials from step 3
(force-password-change on first login).

Other scripts: `npm run dev` (tsx watch), `npm run migrate:status`,
`npm run build` / `npm run lint` (tsc), `npm test`.

---

## Production install (one command)

Prerequisites: Ubuntu 20.04+/Debian 11+ with `sudo`, internet access, and
Node.js ≥ 22.5 if you don't want the installer to install it.

```bash
git clone <repo-url> top-cloud-src && cd top-cloud-src
sudo bash install.sh
```

What the installer does:

1. Installs missing prerequisites (curl, openssl; Node.js via NodeSource if
   needed).
2. Clones the app into **`/opt/top-cloud`**.
3. Creates a dedicated system user **`top-cloud`** and data dir
   **`/var/lib/top-cloud`** (database + backups).
4. Creates **`/etc/top-cloud/.env`** (mode 600). On rerun it **preserves every
   existing key** — only missing keys are added, and `SESSION_SECRET` is
   generated once and never changed afterwards.
5. `npm ci` (lockfile-pinned) + `tsc` type-check gate.
6. Runs migrations and validates configuration **as the service user**.
7. Runs the Super Owner bootstrap (prints the one-time owner password and
   saves it to `/etc/top-cloud/owner-credentials.txt`, mode 600 — delete after
   first login).
8. Installs a hardened systemd unit (`top-cloud`): `NoNewPrivileges`,
   `PrivateTmp`, `ProtectSystem=strict`, `ProtectHome`, read-write only for
   the data dir.
9. **Health-gates success** on `GET /health` — if the service is not healthy,
   the installer exits non-zero with the recent log tail. It never prints
   success while the app is down, never deletes data, and never resets
   credentials on rerun.

Container/CI (no systemd): `TOP_CLOUD_NO_SYSTEMD=1 sudo bash install.sh`
starts the app directly (pid/log under `/etc/top-cloud/`).
Preview-only: `sudo bash install.sh --dry-run`.

After install: `systemctl status top-cloud`, log in at `http://<server>/` as
the owner, then **change the password** and delete the credentials file.

## Updating an existing installation

```bash
cd /opt/top-cloud && sudo git pull && sudo bash install.sh
```

Config, database, users, sessions and backups are preserved. Migrations are
idempotent; the owner bootstrap is a no-op when an owner exists.

---

## Configuration

Environment variable resolution (first match wins per key):

1. Process environment.
2. If `TOP_CLOUD_ENV_FILE` is set → **only** that file.
3. Otherwise `/etc/top-cloud/.env`, then `./.env`.

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `DATABASE_URL` | **yes** | — | Absolute SQLite path, e.g. `file:/var/lib/top-cloud/topcloud.db`. Clear, actionable error if missing/relative. |
| `SESSION_SECRET` | **yes** | — | ≥ 32 random chars (`openssl rand -base64 48`). Never printed by the app. |
| `PORT` | no | `8080` | Integer 1–65535. |
| `HOST` | no | `0.0.0.0` | Bind address. |
| `OWNER_USERNAME` | no | `owner` | Username for the bootstrap Super Owner. |
| `BACKUP_DIR` | no | `/var/lib/top-cloud/backups` | Must be writable by the service user. |
| `SECURE_COOKIES` | no | `auto` | `auto` = secure cookies when NODE_ENV=production. |
| `TRUST_PROXY` | no | off | Set `1` behind a reverse proxy (affects rate-limit keys). |
| `NODE_ENV` | no | `development` | `production` enables secure-cookie default. |
| `DEMO_SEED` | no | off | `1` = `npm run seed:demo` also seeds demo data (development only). |

Missing required config produces a specific, actionable error (which variable,
what value it expects, where to set it) — the app never starts on guesses.

---

## Super Owner bootstrap

- `src/bootstrap-owner.ts` creates **exactly one** super owner (username from
  `OWNER_USERNAME`, default `owner`).
- On a fresh install it generates a strong random password, **prints it once**,
  writes `/etc/top-cloud/owner-credentials.txt` (root:root, 600) and logs.
- Idempotent: if a super owner exists it does nothing (no overwrite, no
  second super owner, no demotion of the existing one).
- The owner is forced to change the password on first login.
- No owner credentials are hardcoded in code, views, migrations or seeds
  (demo seeds use clearly-labelled demo accounts for local development only).

---

## Roles & permissions

| Role | Scope |
| --- | --- |
| `applicant` | Own applications, messages, profile. Never another applicant's data, never staff pages. |
| `reviewer` | View/review assigned applications (default), applicant-visible messages. |
| `admin` | Reviewer defaults + manage positions & forms, staff dashboard. |
| `owner` | Everything, including `/admin/owner`: staff & permissions, settings, analytics, audit, backups. |

- 9 fine-grained permissions with per-user overrides (grant/deny) managed in
  the owner console.
- Every protected route re-checks role + permission **server-side** on each
  request; the UI merely mirrors it.
- Applicant data access is scoped by applicant id — IDOR between applicants is
  impossible by construction (server looks up the row by the *session* user).
- Internal notes and applicant-visible messages are separate tables/columns
  and separate endpoints.
- Rate limiting: 6 logins / 15 min per user+IP, 5 registrations / 15 min per IP.
- No self-promotion, no demotion/removal of the Super Owner by non-super-owner
  code paths.

---

## Testing

```bash
npm test
```

56 tests (node:test, no framework) against a real ephemeral server + real
SQLite database:

- **migrations** — fresh apply, idempotent rerun, schema assertions.
- **auth** — registration, login/logout, password policy, forced change,
  session/CSRF behaviour, rate limiting.
- **applications** — full public flow (dynamic form validation incl. exact
  select values, reference number, duplicate rejection, applicant dashboard,
  messages).
- **permissions** — role gating for every console, IDOR attempts between
  applicants, reviewer assignment, staff management.
- **security** — SQLi/XSS payloads through real endpoints, CSRF enforcement,
  authz matrix, security headers.

All tests pass; they bind an ephemeral port and use throwaway databases, so
they never touch production data.

---

## Security

- Parameterised SQL everywhere (no string interpolation into queries).
- HTML-escaped EJS rendering; no `unsafe` HTML sinks for user data.
- Per-session CSRF tokens; all state-changing requests require a valid token
  **and** a same-host Origin/Referer.
- scrypt password hashing (N=16384, r=8, p=1), salted per user.
- Sessions: HMAC-SHA256 tokens, HttpOnly, SameSite=Lax, 12 h idle / 7 d
  absolute, per-session CSRF token, max 10 live sessions per user, IP+UA
  recorded.
- Headers: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: strict-origin-when-cross-origin`, CSP, HSTS in production.
- Security-relevant actions (login, status change, permission change, backup)
  are written to a tamper-evident audit log shown in the owner console.
- systemd unit hardening for the production service (see installer).

---

## Backups & health

- `GET /health` — JSON: service status, database reachability, version,
  uptime. Used by the installer's success gate.
- Manual backups from `/admin/owner` → Backups: `VACUUM INTO` snapshot named
  `topcloud-YYYYMMDD-HHMMSS.db`, integrity verified (`PRAGMA integrity_check`),
  downloadable; retention keeps the 10 most recent.
- Audit log of backup creation/verification.

---

## Project layout

```
install.sh                  one-command Ubuntu/Debian installer (systemd)
migrations/0001_init.sql    schema (idempotent, safe to rerun)
src/
  index.ts                  entrypoint (bind, listen, graceful shutdown)
  app.ts                    express app assembly
  config.ts                 env loading + validation (actionable errors)
  env.ts                    env-file resolution (process > TOP_CLOUD_ENV_FILE > /etc > .env)
  db.ts                     node:sqlite connection + helpers
  migrate.ts                migration runner
  bootstrap-owner.ts        one-time Super Owner bootstrap (idempotent)
  seed-demo.ts              optional demo data (development)
  middleware.ts             auth, permissions, flash, rate limits
  routes/                   public.ts, account.ts, admin.ts, owner.ts
  services/                 applications, positions, forms, permissions,
                            sessions, backups, audit, analytics
  security/                 csrf, passwords, headers, rate-limit
  public/                   css/js assets (no CDN)
views/                      EJS templates (public/, account/, admin/, owner/)
tests/                      56 node:test cases (5 suites)
```

---

**Made by Tanveer** | Discord: tanveer5637
