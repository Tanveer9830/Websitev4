import type { DatabaseSync } from 'node:sqlite';
import { allRows, oneRow } from '../db.ts';
import { getFormForPosition } from './forms.ts';

export interface Position {
  id: number;
  title: string;
  department: string;
  summary: string;
  description: string;
  eligibility: string;
  open: number;
  created_at: string;
  updated_at: string;
  applications_count?: number;
}

export interface PositionInput {
  title: string;
  department: string;
  summary: string;
  description: string;
  eligibility: string;
  open: boolean;
}

export function validatePositionInput(input: Partial<PositionInput>): Record<string, string> {
  const errors: Record<string, string> = {};
  const title = (input.title ?? '').trim();
  const department = (input.department ?? '').trim() || 'General';
  if (!title) errors.title = 'Title is required.';
  else if (title.length > 120) errors.title = 'Title must be at most 120 characters.';
  if (department.length > 80) errors.department = 'Department must be at most 80 characters.';
  if ((input.summary ?? '').trim().length > 300) errors.summary = 'Summary must be at most 300 characters.';
  if ((input.description ?? '').trim().length > 6000) errors.description = 'Description must be at most 6000 characters.';
  if ((input.eligibility ?? '').trim().length > 2000) errors.eligibility = 'Eligibility requirements must be at most 2000 characters.';
  return errors;
}

export function listPositions(db: DatabaseSync, opts: { openOnly?: boolean; page: number; perPage: number; search?: string }) {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.openOnly) where.push('open = 1');
  if (opts.search) {
    where.push('(title LIKE ? OR department LIKE ?)');
    params.push(`%${opts.search}%`, `%${opts.search}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = oneRow<{ c: number }>(db, `SELECT COUNT(*) AS c FROM positions ${whereSql}`, ...params)!.c;
  const rows = allRows<Position>(
    db,
    `SELECT p.*, (SELECT COUNT(*) FROM applications a WHERE a.position_id = p.id) AS applications_count
       FROM positions p ${whereSql} ORDER BY p.open DESC, p.created_at DESC LIMIT ? OFFSET ?`,
    ...params,
    opts.perPage,
    (opts.page - 1) * opts.perPage,
  );
  return { rows, total };
}

export function getPosition(db: DatabaseSync, id: number): Position | null {
  return oneRow<Position>(db, 'SELECT * FROM positions WHERE id = ?', id) ?? null;
}

export function createPosition(db: DatabaseSync, input: PositionInput): number {
  const info = db
    .prepare('INSERT INTO positions (title, department, summary, description, eligibility, open) VALUES (?,?,?,?,?,?)')
    .run(input.title.trim(), input.department.trim() || 'General', input.summary.trim(), input.description, input.eligibility, input.open ? 1 : 0);
  const id = Number(info.lastInsertRowid);
  getFormForPosition(db, id); // ensure a form exists for every position
  return id;
}

export function updatePosition(db: DatabaseSync, id: number, input: Partial<PositionInput>): void {
  const p = getPosition(db, id);
  if (!p) return;
  db.prepare(
    'UPDATE positions SET title = ?, department = ?, summary = ?, description = ?, eligibility = ?, open = ?, updated_at = ? WHERE id = ?',
  ).run(
    (input.title ?? p.title).trim(),
    (input.department ?? p.department).trim() || 'General',
    (input.summary ?? p.summary).trim(),
    input.description ?? p.description,
    input.eligibility ?? p.eligibility,
    input.open !== undefined ? (input.open ? 1 : 0) : p.open,
    new Date().toISOString(),
    id,
  );
}
