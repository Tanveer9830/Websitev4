import type { DatabaseSync } from 'node:sqlite';
import { allRows, oneRow } from '../db.ts';
import type { StaffUser } from './permissions.ts';

export type AuditAction =
  | 'auth.login.success'
  | 'auth.login.failure'
  | 'auth.logout'
  | 'auth.register'
  | 'auth.password_change'
  | 'owner.bootstrap'
  | 'application.submitted'
  | 'application.status_change'
  | 'application.note_add'
  | 'application.message_send'
  | 'application.assign'
  | 'form.create'
  | 'form.update'
  | 'position.create'
  | 'position.update'
  | 'position.close'
  | 'staff.create'
  | 'staff.update'
  | 'staff.permissions'
  | 'staff.deactivate'
  | 'settings.update'
  | 'backup.create'
  | 'backup.download'
  | 'backup.verify';

export function audit(
  db: DatabaseSync,
  actor: { id: number | null; label: string },
  action: AuditAction,
  target: string,
  detail: Record<string, unknown> = {},
  ip?: string,
): void {
  db.prepare(
    'INSERT INTO audit_logs (at, user_id, user_label, action, target, detail, ip) VALUES (?,?,?,?,?,?,?)',
  ).run(
    new Date().toISOString(),
    actor.id,
    actor.label,
    action,
    target,
    JSON.stringify(detail),
    ip ?? null,
  );
}

export function auditAsUser(db: DatabaseSync, user: StaffUser, action: AuditAction, target: string, detail: Record<string, unknown> = {}, ip?: string): void {
  audit(db, { id: user.id, label: `@${user.username}` }, action, target, detail, ip);
}

export interface AuditRow {
  id: number;
  at: string;
  user_id: number | null;
  user_label: string;
  action: string;
  target: string;
  detail: string;
  ip: string | null;
}

export function listAudit(
  db: DatabaseSync,
  opts: { search?: string; action?: string; page: number; perPage: number },
): { rows: AuditRow[]; total: number } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.search) {
    where.push('(user_label LIKE ? OR target LIKE ? OR detail LIKE ?)');
    const s = `%${opts.search}%`;
    params.push(s, s, s);
  }
  if (opts.action) {
    where.push('action = ?');
    params.push(opts.action);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = oneRow<{ c: number }>(db, `SELECT COUNT(*) AS c FROM audit_logs ${whereSql}`, ...params)!.c;
  const rows = allRows<AuditRow>(
    db,
    `SELECT * FROM audit_logs ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
    ...params,
    opts.perPage,
    (opts.page - 1) * opts.perPage,
  );
  return { rows, total };
}
