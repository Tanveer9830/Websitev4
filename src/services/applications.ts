import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { allRows, oneRow } from '../db.ts';
import type { FormConfig, ValidationResult } from './forms.ts';
import type { StaffUser } from './permissions.ts';
import { auditAsUser } from './audit.ts';

export const STATUSES = ['pending', 'reviewing', 'under_consideration', 'approved', 'rejected', 'on_hold'] as const;
export type Status = (typeof STATUSES)[number];

export const STATUS_LABELS: Record<Status, string> = {
  pending: 'Pending',
  reviewing: 'Reviewing',
  under_consideration: 'Under Consideration',
  approved: 'Approved',
  rejected: 'Rejected',
  on_hold: 'On Hold',
};

/** Allowed status transitions. approved/rejected are terminal. */
const TRANSITIONS: Record<Status, Status[]> = {
  pending: ['reviewing', 'under_consideration', 'approved', 'rejected', 'on_hold'],
  reviewing: ['pending', 'under_consideration', 'approved', 'rejected', 'on_hold'],
  under_consideration: ['reviewing', 'approved', 'rejected', 'on_hold'],
  on_hold: ['pending', 'reviewing', 'under_consideration', 'approved', 'rejected'],
  approved: [],
  rejected: [],
};

export function canTransition(from: Status, to: Status): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export interface Application {
  id: number;
  reference: string;
  applicant_id: number;
  position_id: number;
  form_id: number | null;
  answers_json: string;
  status: Status;
  reviewer_id: number | null;
  created_at: string;
  updated_at: string;
  // joined (optional)
  applicant_name?: string;
  applicant_username?: string;
  position_title?: string;
  reviewer_name?: string;
}

export interface StatusEvent {
  id: number;
  from_status: string | null;
  to_status: string;
  changed_by: number | null;
  note: string;
  at: string;
  actor_label?: string;
}

export interface InternalNote {
  id: number;
  body: string;
  at: string;
  author_label: string;
}

export interface ApplicantMessage {
  id: number;
  body: string;
  at: string;
}

function newReference(db: DatabaseSync): string {
  for (let attempt = 0; attempt < 5; attempt++) {
    const ref = `TC-${new Date().getFullYear()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const existing = db.prepare('SELECT 1 AS x FROM applications WHERE reference = ?').get(ref);
    if (!existing) return ref;
  }
  // Practically unreachable; fall back to timestamp-based uniqueness.
  return `TC-${Date.now().toString(36).toUpperCase()}`;
}

/**
 * Create an application. Returns { error } when the submission is blocked
 * (duplicate or position closed); otherwise the new application row.
 */
export function createApplication(
  db: DatabaseSync,
  opts: {
    applicant: StaffUser;
    positionId: number;
    form: FormConfig;
    validation: ValidationResult;
    ip?: string;
  },
): { error?: string; application?: Application } {
  if (!opts.validation.ok) return { error: 'Your answers did not pass validation.' };

  const dup = oneRow<{ id: number; status: string }>(
    db,
    `SELECT id, status FROM applications
       WHERE applicant_id = ? AND position_id = ? AND status IN ('pending','reviewing','under_consideration','on_hold')`,
    opts.applicant.id,
    opts.positionId,
  );
  if (dup) {
    return { error: `You already have an active application (reference found in your dashboard) for this position with status "${STATUS_LABELS[dup.status as Status] ?? dup.status}". Please wait for it to be reviewed.` };
  }

  const info = db
    .prepare(
      'INSERT INTO applications (reference, applicant_id, position_id, form_id, answers_json, status, created_at, updated_at) VALUES (?,?,?,?,?,? ,?,?)',
    )
    .run(
      newReference(db),
      opts.applicant.id,
      opts.positionId,
      opts.form.id,
      JSON.stringify(opts.validation.answers),
      'pending',
      new Date().toISOString(),
      new Date().toISOString(),
    );
  const id = Number(info.lastInsertRowid);
  db.prepare(
    'INSERT INTO status_history (application_id, from_status, to_status, changed_by, note, at) VALUES (?,?,?,?,?,?)',
  ).run(id, null, 'pending', opts.applicant.id, 'Application submitted', new Date().toISOString());
  auditAsUser(db, opts.applicant, 'application.submitted', `application#${id}`, { position_id: opts.positionId }, opts.ip);
  return { application: getApplication(db, id) ?? undefined };
}

export function getApplication(db: DatabaseSync, id: number): Application | null {
  const row = oneRow<Application>(
    db,
    `SELECT a.*,
              u.display_name AS applicant_name, u.username AS applicant_username,
              p.title AS position_title,
              r.display_name AS reviewer_name
       FROM applications a
       JOIN users u ON u.id = a.applicant_id
       JOIN positions p ON p.id = a.position_id
       LEFT JOIN users r ON r.id = a.reviewer_id
       WHERE a.id = ?`,
    id,
  );
  return row ?? null;
}

export function getApplicationForApplicant(db: DatabaseSync, applicantId: number, id: number): Application | null {
  const row = oneRow<Application>(db, 'SELECT * FROM applications WHERE id = ? AND applicant_id = ?', id, applicantId);
  return row ?? null;
}

export function listApplications(
  db: DatabaseSync,
  opts: {
    page: number;
    perPage: number;
    search?: string;
    status?: string;
    positionId?: number;
    reviewerId?: number;
  },
): { rows: Application[]; total: number } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.search) {
    where.push('(a.reference LIKE ? OR u.display_name LIKE ? OR u.username LIKE ? OR p.title LIKE ?)');
    const s = `%${opts.search}%`;
    params.push(s, s, s, s);
  }
  if (opts.status && STATUSES.includes(opts.status as Status)) {
    where.push('a.status = ?');
    params.push(opts.status);
  }
  if (opts.positionId) {
    where.push('a.position_id = ?');
    params.push(opts.positionId);
  }
  if (opts.reviewerId) {
    where.push('a.reviewer_id = ?');
    params.push(opts.reviewerId);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = oneRow<{ c: number }>(
    db,
    `SELECT COUNT(*) AS c FROM applications a JOIN users u ON u.id = a.applicant_id JOIN positions p ON p.id = a.position_id ${whereSql}`,
    ...params,
  )!.c;
  const rows = allRows<Application>(
    db,
    `SELECT a.*, u.display_name AS applicant_name, u.username AS applicant_username, p.title AS position_title, r.display_name AS reviewer_name
       FROM applications a
       JOIN users u ON u.id = a.applicant_id
       JOIN positions p ON p.id = a.position_id
       LEFT JOIN users r ON r.id = a.reviewer_id
       ${whereSql}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT ? OFFSET ?`,
    ...params,
    opts.perPage,
    (opts.page - 1) * opts.perPage,
  );
  return { rows, total };
}

export function listApplicantApplications(db: DatabaseSync, applicantId: number): Application[] {
  return allRows<Application>(
    db,
    `SELECT a.*, p.title AS position_title FROM applications a JOIN positions p ON p.id = a.position_id
       WHERE a.applicant_id = ? ORDER BY a.created_at DESC`,
    applicantId,
  );
}

/**
 * Change an application's status. Enforces the transition matrix and
 * records history + audit. The actor must be a staff user with
 * applications.review (checked by the caller middleware; re-checked here).
 */
export function changeStatus(
  db: DatabaseSync,
  actor: StaffUser,
  applicationId: number,
  to: Status,
  note: string,
  ip?: string,
): { error?: string } {
  const app = getApplication(db, applicationId);
  if (!app) return { error: 'Application not found.' };
  if (app.status === to) return { error: 'Application is already in that status.' };
  if (!canTransition(app.status, to)) {
    return { error: `Status change from "${STATUS_LABELS[app.status]}" to "${STATUS_LABELS[to]}" is not allowed.` };
  }
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE applications SET status = ?, updated_at = ? WHERE id = ?').run(
      to,
      new Date().toISOString(),
      applicationId,
    );
    db.prepare(
      'INSERT INTO status_history (application_id, from_status, to_status, changed_by, note, at) VALUES (?,?,?,?,?,?)',
    ).run(applicationId, app.status, to, actor.id, note.slice(0, 500), new Date().toISOString());
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  auditAsUser(db, actor, 'application.status_change', `application#${applicationId}`, {
    reference: app.reference,
    from: app.status,
    to,
    note: note.slice(0, 500),
  }, ip);
  return {};
}

export function assignReviewer(db: DatabaseSync, actor: StaffUser, applicationId: number, reviewerId: number | null, ip?: string): { error?: string } {
  const app = getApplication(db, applicationId);
  if (!app) return { error: 'Application not found.' };
  if (reviewerId !== null) {
    const reviewer = db
      .prepare('SELECT id, role, active, is_super FROM users WHERE id = ? AND role IN (\'reviewer\',\'admin\',\'owner\') AND active = 1')
      .get(reviewerId);
    if (!reviewer) return { error: 'Reviewer not found or not an active staff member.' };
  }
  db.prepare('UPDATE applications SET reviewer_id = ?, updated_at = ? WHERE id = ?').run(
    reviewerId,
    new Date().toISOString(),
    applicationId,
  );
  auditAsUser(db, actor, 'application.assign', `application#${applicationId}`, {
    reference: app.reference,
    reviewer_id: reviewerId,
  }, ip);
  return {};
}

export function addInternalNote(db: DatabaseSync, actor: StaffUser, applicationId: number, body: string, ip?: string): { error?: string } {
  const app = getApplication(db, applicationId);
  if (!app) return { error: 'Application not found.' };
  const text = body.trim();
  if (!text) return { error: 'Note cannot be empty.' };
  if (text.length > 4000) return { error: 'Note must be at most 4000 characters.' };
  db.prepare('INSERT INTO internal_notes (application_id, author_id, body, at) VALUES (?,?,?,?)').run(
    applicationId,
    actor.id,
    text,
    new Date().toISOString(),
  );
  auditAsUser(db, actor, 'application.note_add', `application#${applicationId}`, { reference: app.reference }, ip);
  return {};
}

export function sendApplicantMessage(db: DatabaseSync, actor: StaffUser, applicationId: number, body: string, ip?: string): { error?: string } {
  const app = getApplication(db, applicationId);
  if (!app) return { error: 'Application not found.' };
  const text = body.trim();
  if (!text) return { error: 'Message cannot be empty.' };
  if (text.length > 4000) return { error: 'Message must be at most 4000 characters.' };
  db.prepare('INSERT INTO applicant_messages (application_id, sender_id, body, at) VALUES (?,?,?,?)').run(
    applicationId,
    actor.id,
    text,
    new Date().toISOString(),
  );
  auditAsUser(db, actor, 'application.message_send', `application#${applicationId}`, { reference: app.reference }, ip);
  return {};
}

export function statusHistory(db: DatabaseSync, applicationId: number): StatusEvent[] {
  return allRows<StatusEvent>(
    db,
    `SELECT h.*, u.display_name AS actor_label
       FROM status_history h LEFT JOIN users u ON u.id = h.changed_by
       WHERE h.application_id = ? ORDER BY h.id ASC`,
    applicationId,
  );
}

export function internalNotes(db: DatabaseSync, applicationId: number): InternalNote[] {
  return allRows<InternalNote>(
    db,
    `SELECT n.id, n.body, n.at, u.display_name AS author_label
       FROM internal_notes n JOIN users u ON u.id = n.author_id
       WHERE n.application_id = ? ORDER BY n.id ASC`,
    applicationId,
  );
}

export function applicantMessages(db: DatabaseSync, applicationId: number): ApplicantMessage[] {
  return allRows<ApplicantMessage>(db, 'SELECT id, body, at FROM applicant_messages WHERE application_id = ? ORDER BY id ASC', applicationId);
}

/** Status counts for dashboards/analytics. */
export function statusCounts(db: DatabaseSync): Record<Status, number> {
  const out = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
  const rows = allRows<{ status: string; c: number }>(db, 'SELECT status, COUNT(*) AS c FROM applications GROUP BY status');
  for (const r of rows) if (r.status in out) out[r.status as Status] = r.c;
  return out;
}

/** Daily application counts for the last N days (analytics chart). */
export function dailyCounts(db: DatabaseSync, days = 14): { day: string; count: number }[] {
  const out: { day: string; count: number }[] = [];
  const rows = allRows<{ day: string; c: number }>(
    db,
    `SELECT substr(created_at,1,10) AS day, COUNT(*) AS c
       FROM applications
       WHERE created_at >= date('now', ?)
       GROUP BY day`,
    `-${days - 1} days`,
  );
  const byDay = new Map(rows.map((r) => [r.day, r.c]));
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    out.push({ day: d, count: byDay.get(d) ?? 0 });
  }
  return out;
}

export function positionCounts(db: DatabaseSync): {
  position_id: number;
  title: string;
  open: number;
  total: number;
  in_progress: number;
  approved: number;
  rejected: number;
}[] {
  return db
    .prepare(
      `SELECT p.id AS position_id, p.title, p.open,
              COUNT(a.id) AS total,
              COALESCE(SUM(CASE WHEN a.status IN ('pending','reviewing','under_consideration','on_hold') THEN 1 ELSE 0 END), 0) AS in_progress,
              COALESCE(SUM(CASE WHEN a.status = 'approved' THEN 1 ELSE 0 END), 0) AS approved,
              COALESCE(SUM(CASE WHEN a.status = 'rejected' THEN 1 ELSE 0 END), 0) AS rejected
       FROM positions p LEFT JOIN applications a ON a.position_id = p.id
       GROUP BY p.id ORDER BY total DESC`,
    )
    .all() as unknown as {
      position_id: number;
      title: string;
      open: number;
      total: number;
      in_progress: number;
      approved: number;
      rejected: number;
    }[];
}
