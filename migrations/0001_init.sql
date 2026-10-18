-- TOP CLOUD — Staff Recruitment Portal
-- Migration 0001: initial schema
-- All statements are idempotent (IF NOT EXISTS) so the migration is safe to rerun.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  username        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash   TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'applicant'
                  CHECK (role IN ('owner','admin','reviewer','applicant')),
  is_super        INTEGER NOT NULL DEFAULT 0 CHECK (is_super IN (0,1)),
  active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  must_change_pw  INTEGER NOT NULL DEFAULT 0 CHECK (must_change_pw IN (0,1)),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_login_at   TEXT
);

CREATE TABLE IF NOT EXISTS user_permissions (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  granted    INTEGER NOT NULL DEFAULT 1 CHECK (granted IN (0,1)),
  PRIMARY KEY (user_id, permission)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
  csrf_token   TEXT NOT NULL,
  ip           TEXT,
  user_agent   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS positions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  department  TEXT NOT NULL DEFAULT 'General',
  summary     TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  eligibility TEXT NOT NULL DEFAULT '',
  open        INTEGER NOT NULL DEFAULT 1 CHECK (open IN (0,1)),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS application_forms (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id  INTEGER NOT NULL UNIQUE REFERENCES positions(id) ON DELETE CASCADE,
  instructions TEXT NOT NULL DEFAULT '',
  fields_json  TEXT NOT NULL DEFAULT '[]',
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS applications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  reference     TEXT NOT NULL UNIQUE,
  applicant_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position_id   INTEGER NOT NULL REFERENCES positions(id) ON DELETE RESTRICT,
  form_id       INTEGER REFERENCES application_forms(id) ON DELETE SET NULL,
  answers_json  TEXT NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','reviewing','under_consideration','approved','rejected','on_hold')),
  reviewer_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_app_applicant ON applications(applicant_id);
CREATE INDEX IF NOT EXISTS idx_app_status ON applications(status);
CREATE INDEX IF NOT EXISTS idx_app_position ON applications(position_id);
CREATE INDEX IF NOT EXISTS idx_app_reviewer ON applications(reviewer_id);
CREATE INDEX IF NOT EXISTS idx_app_created ON applications(created_at);

CREATE TABLE IF NOT EXISTS status_history (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  from_status    TEXT,
  to_status      TEXT NOT NULL,
  changed_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  note           TEXT NOT NULL DEFAULT '',
  at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_status_history_app ON status_history(application_id);

CREATE TABLE IF NOT EXISTS internal_notes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  author_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body           TEXT NOT NULL,
  at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_internal_notes_app ON internal_notes(application_id);

CREATE TABLE IF NOT EXISTS applicant_messages (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  sender_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body           TEXT NOT NULL,
  at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_app_messages_app ON applicant_messages(application_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_label TEXT NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT NOT NULL DEFAULT '',
  detail     TEXT NOT NULL DEFAULT '{}',
  ip         TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_logs(at);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key        TEXT NOT NULL,
  at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts(key, at);
