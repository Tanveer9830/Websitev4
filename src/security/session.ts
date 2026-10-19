import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AppConfig } from '../config.ts';

export const SESSION_COOKIE = 'tcsid';
export const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12h sliding
export const SESSION_ABSOLUTE_MAX_MS = 7 * 24 * 60 * 60 * 1000; // 7d
const MAX_SESSIONS_PER_USER = 10;

export interface SessionRecord {
  token_hash: string;
  user_id: number | null;
  csrf_token: string;
  ip: string | null;
  user_agent: string | null;
  expires_at: string;
  created_at: string;
  last_seen_at: string;
}

interface SessionDeps {
  db: DatabaseSync;
  secret: string;
}

function hashToken(raw: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(raw).digest('hex');
}

export class Sessions {
  constructor(private deps: SessionDeps) {}

  private tableReady = false;

  private ensure(): void {
    if (this.tableReady) return;
    this.deps.db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL,
      ip TEXT, user_agent TEXT,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );`);
    this.tableReady = true;
  }

  private createCount = 0;

  /** Create a session bound to a user (or anonymous when userId is null). */
  create(userId: number | null, ip: string | undefined, ua: string | undefined): { token: string; csrf: string } {
    this.ensure();
    const raw = crypto.randomBytes(32).toString('base64url');
    const token = hashToken(raw, this.deps.secret);
    const csrf = crypto.randomBytes(24).toString('base64url');
    const now = Date.now();
    const expires = new Date(now + SESSION_MAX_AGE_MS).toISOString();
    const nowIso = new Date(now).toISOString();
    this.deps.db
      .prepare('INSERT INTO sessions (token_hash, user_id, csrf_token, ip, user_agent, created_at, last_seen_at, expires_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(token, userId, csrf, ip ?? null, ua ?? null, nowIso, nowIso, expires);
    if (userId !== null) this.pruneOld(userId);
    // Bounded cleanup of expired sessions (anonymous + logged out).
    if (++this.createCount % 250 === 0) {
      this.deps.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso);
    }
    return { token: raw, csrf };
  }

  load(raw: string | undefined): SessionRecord | null {
    this.ensure();
    if (!raw) return null;
    const token = hashToken(raw, this.deps.secret);
    const row = this.deps.db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(token) as
      | SessionRecord
      | undefined;
    if (!row) return null;
    if (new Date(row.expires_at).getTime() < Date.now()) {
      this.destroy(raw);
      return null;
    }
    // Sliding expiry (throttled: only touch the row if >60s old).
    if (Date.now() - new Date(row.last_seen_at).getTime() > 60_000) {
      const absoluteMax = new Date(row.created_at).getTime() + SESSION_ABSOLUTE_MAX_MS;
      if (absoluteMax < Date.now()) {
        this.destroy(raw);
        return null;
      }
      this.deps.db
        .prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?')
        .run(new Date().toISOString(), new Date(Date.now() + SESSION_MAX_AGE_MS).toISOString(), token);
    }
    return row;
  }

  bindUser(raw: string, userId: number): void {
    this.ensure();
    const token = hashToken(raw, this.deps.secret);
    this.deps.db.prepare('UPDATE sessions SET user_id = ? WHERE token_hash = ?').run(userId, token);
    this.pruneOld(userId);
  }

  /** Issue a fresh token for the same user (privilege-change protection). */
  rotate(raw: string): { token: string; csrf: string } | null {
    this.ensure();
    const row = this.load(raw);
    if (!row || row.user_id === null) return null;
    this.destroy(raw);
    return this.create(row.user_id, undefined, undefined);
  }

  destroy(raw: string): void {
    this.ensure();
    if (!raw) return;
    this.deps.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(raw, this.deps.secret));
  }

  destroyAllForUser(userId: number): void {
    this.ensure();
    this.deps.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  private pruneOld(userId: number): void {
    const rows = this.deps.db
      .prepare('SELECT token_hash, last_seen_at FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT ?')
      .all(userId, MAX_SESSIONS_PER_USER) as { token_hash: string; last_seen_at: string }[];
    const keep = new Set(rows.map((r) => r.token_hash));
    const del = this.deps.db.prepare('DELETE FROM sessions WHERE token_hash = ?');
    const all = this.deps.db.prepare('SELECT token_hash FROM sessions WHERE user_id = ?').all(userId) as { token_hash: string }[];
    for (const r of all) if (!keep.has(r.token_hash)) del.run(r.token_hash);
  }
}

/** Cookie attributes based on config + request security. */
export function sessionCookieOptions(
  cfg: Pick<AppConfig, 'secureCookies' | 'env'>,
  reqIsSecure: boolean,
): { httpOnly: boolean; sameSite: 'lax' | 'strict'; secure: boolean; maxAge: number; path: string } {
  const secure =
    cfg.secureCookies === 'false' ? false : cfg.secureCookies === 'true' ? true : reqIsSecure;
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: Math.floor(SESSION_MAX_AGE_MS / 1000),
    path: '/',
  };
}
