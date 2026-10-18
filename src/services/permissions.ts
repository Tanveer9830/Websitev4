import type { DatabaseSync } from 'node:sqlite';
import { allRows } from '../db.ts';

export const PERMISSIONS = [
  'applications.view',
  'applications.review',
  'forms.manage',
  'positions.manage',
  'staff.manage',
  'settings.manage',
  'audit.view',
  'backups.manage',
  'system.view',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ALL_PERMISSIONS: Permission[] = [...PERMISSIONS];

export interface StaffUser {
  id: number;
  username: string;
  email: string;
  password_hash: string;
  display_name: string;
  role: 'owner' | 'admin' | 'reviewer' | 'applicant';
  is_super: 0 | 1;
  active: 0 | 1;
  must_change_pw: 0 | 1;
  created_at: string;
  last_login_at: string | null;
}

export const ROLE_DEFAULTS: Record<string, Permission[]> = {
  owner: [...PERMISSIONS],
  admin: ['applications.view', 'applications.review', 'forms.manage', 'positions.manage'],
  reviewer: ['applications.view', 'applications.review'],
  applicant: [],
};

const roleDefaultsCache = new Map<number, Set<Permission>>();

/**
 * Effective permissions for a staff user:
 *   owner (is_super)  -> everything, always.
 *   otherwise         -> role defaults ∪ explicit grants ∖ explicit denies.
 * The Super Owner's permission row can never be removed (checked at write time).
 */
export function effectivePermissions(db: DatabaseSync, user: StaffUser): Set<Permission> {
  if (user.is_super) return new Set(ALL_PERMISSIONS);
  let set = roleDefaultsCache.get(user.id);
  if (!set) {
    const base = new Set<Permission>(ROLE_DEFAULTS[user.role] ?? []);
    const rows = allRows<{ permission: string; granted: 0 | 1 }>(db, 'SELECT permission, granted FROM user_permissions WHERE user_id = ?', user.id);
    for (const r of rows) {
      if (!(PERMISSIONS as readonly string[]).includes(r.permission)) continue;
      if (r.granted) base.add(r.permission as Permission);
      else base.delete(r.permission as Permission);
    }
    set = base;
    roleDefaultsCache.set(user.id, set);
  }
  return set;
}

/** Invalidate the cache after permission/role changes. */
export function invalidatePermissionCache(userId?: number): void {
  if (userId === undefined) roleDefaultsCache.clear();
  else roleDefaultsCache.delete(userId);
}

export function hasPermission(db: DatabaseSync, user: StaffUser | null, perm: Permission): boolean {
  if (!user || !user.active) return false;
  if (user.is_super) return true;
  if (user.role === 'applicant') return false;
  return effectivePermissions(db, user).has(perm);
}

/** Can this user modify another staff user's role/permissions/active state? */
export function canManageUser(db: DatabaseSync, actor: StaffUser, target: StaffUser): boolean {
  if (!actor.active) return false;
  if (actor.is_super) return true;
  if (!hasPermission(db, actor, 'staff.manage')) return false;
  // Staff managers may not touch the Super Owner, or users at/above their own level.
  if (target.is_super) return false;
  if (target.role === 'owner') return false;
  return true;
}

export function setPermissions(db: DatabaseSync, actor: StaffUser, target: StaffUser, perms: Partial<Record<Permission, boolean>>): void {
  if (!canManageUser(db, actor, target)) {
    throw new Error('You do not have permission to modify this user.');
  }
  const upsert = db.prepare(
    'INSERT INTO user_permissions (user_id, permission, granted) VALUES (?,?,?) ' +
      'ON CONFLICT(user_id, permission) DO UPDATE SET granted = excluded.granted',
  );
  const del = db.prepare('DELETE FROM user_permissions WHERE user_id = ? AND permission = ?');
  db.exec('BEGIN');
  try {
    for (const [perm, granted] of Object.entries(perms)) {
      if (!(PERMISSIONS as readonly string[]).includes(perm)) continue;
      const defaults = ROLE_DEFAULTS[target.role] ?? [];
      const isDefault = defaults.includes(perm as Permission);
      if (granted && isDefault) {
        // Match role default: clear any stored override.
        del.run(target.id, perm);
      } else if (granted) {
        upsert.run(target.id, perm, 1);
      } else if (!granted && isDefault) {
        upsert.run(target.id, perm, 0); // explicit deny of a role default
      } else {
        del.run(target.id, perm); // matches the non-default false state
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  invalidatePermissionCache(target.id);
}
