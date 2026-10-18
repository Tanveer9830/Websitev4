import type { DatabaseSync } from 'node:sqlite';
import { allRows, oneRow } from '../db.ts';
import { hashPassword, passwordPolicyError } from '../security/password.ts';
import { auditAsUser } from './audit.ts';
import { canManageUser, invalidatePermissionCache, type StaffUser } from './permissions.ts';

export function listStaff(db: DatabaseSync, role?: string): StaffUser[] {
  if (role) {
    return allRows<StaffUser>(db, "SELECT * FROM users WHERE role = ? AND role != 'applicant' ORDER BY role, username", role);
  }
  return allRows<StaffUser>(db, "SELECT * FROM users WHERE role != 'applicant' ORDER BY role, username");
}

export function findStaffById(db: DatabaseSync, id: number): StaffUser | null {
  return oneRow<StaffUser>(db, 'SELECT * FROM users WHERE id = ?', id) ?? null;
}

export function createUser(
  db: DatabaseSync,
  actor: StaffUser,
  input: { username: string; email: string; display_name: string; password: string; role: 'admin' | 'reviewer' },
  ip?: string,
): { error?: string; user?: StaffUser } {
  const username = input.username.trim().toLowerCase();
  const email = input.email.trim().toLowerCase();
  const display_name = input.display_name.trim();
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) return { error: 'Username must be 3–32 characters: letters, numbers, dot, dash, underscore.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 200) return { error: 'A valid email address is required.' };
  if (display_name.length < 2 || display_name.length > 80) return { error: 'Display name must be 2–80 characters.' };
  const pwErr = passwordPolicyError(input.password);
  if (pwErr) return { error: pwErr };
  if (!['admin', 'reviewer'].includes(input.role)) return { error: 'Role must be admin or reviewer.' };

  const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email);
  if (existing) return { error: 'A user with that username or email already exists.' };

  const info = db
    .prepare(
      'INSERT INTO users (username, email, password_hash, display_name, role, is_super, active) VALUES (?,?,?,?,?,0,1)',
    )
    .run(username, email, hashPassword(input.password), display_name, input.role);
  const user = findStaffById(db, Number(info.lastInsertRowid));
  auditAsUser(db, actor, 'staff.create', `user#${info.lastInsertRowid}`, { username, role: input.role }, ip);
  return { user: user! };
}

export function updateUser(
  db: DatabaseSync,
  actor: StaffUser,
  targetId: number,
  input: { display_name?: string; role?: 'admin' | 'reviewer'; active?: boolean },
  ip?: string,
): { error?: string } {
  const target = findStaffById(db, targetId);
  if (!target) return { error: 'User not found.' };
  if (!canManageUser(db, actor, target)) return { error: 'You cannot modify this user.' };
  if (input.role !== undefined && !['admin', 'reviewer'].includes(input.role)) return { error: 'Role must be admin or reviewer.' };

  const updates: string[] = [];
  const params: (string | number)[] = [];
  if (input.display_name !== undefined) {
    const dn = input.display_name.trim();
    if (dn.length < 2 || dn.length > 80) return { error: 'Display name must be 2–80 characters.' };
    updates.push('display_name = ?');
    params.push(dn);
  }
  if (input.role !== undefined && input.role !== target.role) {
    updates.push('role = ?');
    params.push(input.role);
  }
  if (input.active !== undefined && (input.active ? 1 : 0) !== target.active) {
    if (target.is_super) return { error: 'The Super Owner cannot be deactivated.' };
    updates.push('active = ?');
    params.push(input.active ? 1 : 0);
    if (!input.active) {
      // Deactivation kills all of that user's sessions immediately.
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
    }
  }
  if (updates.length === 0) return {};
  params.push(targetId);
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  invalidatePermissionCache(targetId);
  const kind = !input.active ? 'staff.deactivate' : 'staff.update';
  auditAsUser(db, actor, kind, `user#${targetId}`, { username: target.username, ...input }, ip);
  return {};
}
