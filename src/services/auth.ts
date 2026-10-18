import type { DatabaseSync } from 'node:sqlite';
import type { Sessions } from '../security/session.ts';
import { hashPassword, passwordPolicyError, verifyPassword } from '../security/password.ts';
import { audit } from './audit.ts';
import type { StaffUser } from './permissions.ts';
import { oneRow } from '../db.ts';

export interface AuthResult {
  error?: string;
  user?: StaffUser;
  token?: string;
  csrf?: string;
}

export function authenticate(
  db: DatabaseSync,
  sessions: Sessions,
  opts: { identifier: string; password: string; ip?: string; ua?: string },
): AuthResult {
  const identifier = opts.identifier.trim();
  if (!identifier) return { error: 'Enter your username or email.' };
  const row = oneRow<StaffUser>(db, 'SELECT * FROM users WHERE username = ? OR email = ?', identifier.toLowerCase(), identifier.toLowerCase());
  // Always run a scrypt verification (constant time) even when the user is
  // missing, so response timing does not reveal whether an account exists.
  const hash = row?.password_hash ?? 'scrypt$16384$8$1$' + '0'.repeat(64) + '$' + '0'.repeat(128);
  const ok = verifyPassword(opts.password, hash);
  if (!row || !ok) {
    audit(db, { id: row?.id ?? null, label: row ? `@${row.username}` : identifier }, 'auth.login.failure', 'auth', {}, opts.ip);
    return { error: 'Invalid credentials. Please check and try again.' };
  }
  if (!row.active) return { error: 'This account has been deactivated. Contact an administrator.' };
  const { token, csrf } = sessions.create(row.id, opts.ip, opts.ua);
  sessions.bindUser(token, row.id);
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
  audit(db, { id: row.id, label: `@${row.username}` }, 'auth.login.success', 'auth', { role: row.role }, opts.ip);
  return { user: row, token, csrf };
}

export function registerApplicant(
  db: DatabaseSync,
  sessions: Sessions,
  opts: { username: string; email: string; display_name: string; password: string; ip?: string; ua?: string },
): AuthResult {
  const username = opts.username.trim().toLowerCase();
  const email = opts.email.trim().toLowerCase();
  const display_name = opts.display_name.trim();
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    return { error: 'Username must be 3–32 characters: letters, numbers, dot, dash or underscore.' };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 200) {
    return { error: 'Please enter a valid email address.' };
  }
  if (display_name.length < 2 || display_name.length > 80) {
    return { error: 'Display name must be 2–80 characters.' };
  }
  const pwErr = passwordPolicyError(opts.password);
  if (pwErr) return { error: pwErr };
  const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email);
  if (existing) return { error: 'That username or email is already taken.' };

  const info = db
    .prepare('INSERT INTO users (username, email, password_hash, display_name, role) VALUES (?,?,?,?,\'applicant\')')
    .run(username, email, hashPassword(opts.password), display_name);
  const user = oneRow<StaffUser>(db, 'SELECT * FROM users WHERE id = ?', Number(info.lastInsertRowid))!;
  const { token, csrf } = sessions.create(user.id, opts.ip, opts.ua);
  sessions.bindUser(token, user.id);
  audit(db, { id: user.id, label: `@${user.username}` }, 'auth.register', 'auth', { role: 'applicant' }, opts.ip);
  return { user, token, csrf };
}

export function changePassword(
  db: DatabaseSync,
  sessions: Sessions,
  opts: { user: StaffUser; current: string; next: string; ip?: string },
): { error?: string } {
  if (!verifyPassword(opts.current, opts.user.password_hash)) {
    return { error: 'Your current password is incorrect.' };
  }
  const pwErr = passwordPolicyError(opts.next);
  if (pwErr) return { error: pwErr };
  db.prepare('UPDATE users SET password_hash = ?, must_change_pw = 0 WHERE id = ?').run(
    hashPassword(opts.next),
    opts.user.id,
  );
  // Invalidate every session except the most recent one (the current one).
  db.prepare(
    `DELETE FROM sessions WHERE user_id = ? AND token_hash != (
       SELECT token_hash FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT 1
     )`,
  ).run(opts.user.id, opts.user.id);
  audit(db, { id: opts.user.id, label: `@${opts.user.username}` }, 'auth.password_change', 'auth', {}, opts.ip);
  return {};
}
