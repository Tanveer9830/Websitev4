import type { DatabaseSync } from 'node:sqlite';
import { oneRow } from '../db.ts';

/**
 * Dynamic application forms.
 *
 * Field definitions live in the database (application_forms.fields_json),
 * so owners/admins can add and edit questions without touching source code.
 */

export type FieldType = 'text' | 'textarea' | 'select' | 'checkbox';

export interface FormField {
  key: string;
  label: string;
  type: FieldType;
  /** For select fields: the list of options. */
  options?: string[];
  required?: boolean;
  placeholder?: string;
  help?: string;
  order: number;
}

export interface FormConfig {
  id: number;
  position_id: number;
  instructions: string;
  fields: FormField[];
  updated_at: string;
}

const MAX_FIELDS = 40;
const MAX_KEY = 40;
const MAX_LABEL = 120;
const MAX_OPTIONS = 30;
const MAX_OPTION = 120;

const FIELD_TYPES: FieldType[] = ['text', 'textarea', 'select', 'checkbox'];

export function sanitizeFieldsJson(raw: unknown): { fields: FormField[]; error?: string } {
  if (!Array.isArray(raw)) return { fields: [], error: 'fields must be a JSON array' };
  const fields: FormField[] = [];
  const seen = new Set<string>();
  for (const entry of raw.slice(0, MAX_FIELDS)) {
    if (typeof entry !== 'object' || entry === null) return { fields: [], error: 'each field must be an object' };
    const e = entry as Record<string, unknown>;
    const key = typeof e.key === 'string' ? e.key.trim() : '';
    const label = typeof e.label === 'string' ? e.label.trim() : '';
    if (!key || key.length > MAX_KEY || !/^[a-z0-9_]+$/.test(key)) {
      return { fields: [], error: `invalid field key "${key}" — use letters, numbers and underscores` };
    }
    if (seen.has(key)) return { fields: [], error: `duplicate field key "${key}"` };
    if (!label || label.length > MAX_LABEL) return { fields: [], error: `invalid label for field "${key}"` };
    seen.add(key);

    let type: FieldType = 'text';
    if (typeof e.type === 'string' && FIELD_TYPES.includes(e.type as FieldType)) type = e.type as FieldType;
    if (type === 'checkbox' && label.length === 0) continue;

    const field: FormField = {
      key,
      label,
      type,
      required: e.required === true || e.required === 'true' || e.required === '1' || e.required === 1 ? true : false,
      placeholder: typeof e.placeholder === 'string' ? e.placeholder.slice(0, 200) : undefined,
      help: typeof e.help === 'string' ? e.help.slice(0, 300) : undefined,
      order: Number.isInteger(e.order) ? (e.order as number) : fields.length,
    };
    if (type === 'select') {
      const opts = Array.isArray(e.options) ? e.options : [];
      const cleaned = opts
        .filter((o): o is string => typeof o === 'string' && o.trim().length > 0)
        .map((o) => o.trim().slice(0, MAX_OPTION))
        .slice(0, MAX_OPTIONS);
      if (cleaned.length < 2) return { fields: [], error: `select field "${key}" needs at least 2 options` };
      field.options = [...new Set(cleaned)];
    }
    fields.push(field);
  }
  fields.sort((a, b) => a.order - b.order);
  return { fields };
}

export function getFormForPosition(db: DatabaseSync, positionId: number): FormConfig {
  const row = oneRow<Omit<FormConfig, 'fields'> & { fields_json: string }>(db, 'SELECT * FROM application_forms WHERE position_id = ?', positionId);
  if (row) {
    const { fields } = sanitizeFieldsJson(safeParse(row.fields_json));
    return { id: row.id, position_id: row.position_id, instructions: row.instructions, fields, updated_at: row.updated_at };
  }
  // Positions always have a form; default to a sensible base questionnaire
  // that staff can customise from the dashboard.
  const defaultFields: FormField[] = [
    { key: 'full_name', label: 'Full name', type: 'text', required: true, order: 0, placeholder: 'Your full name' },
    { key: 'contact', label: 'How can we reach you outside the portal?', type: 'text', required: true, order: 1, placeholder: 'Email, phone or Discord handle' },
    { key: 'motivation', label: 'Why do you want to join this role?', type: 'textarea', required: true, order: 2, help: 'A short paragraph is perfect.' },
    { key: 'experience', label: 'Do you have prior team or staff experience?', type: 'select', options: ['Yes', 'No', 'Some'], required: true, order: 3 },
    { key: 'available_hours', label: 'How many hours per week can you realistically commit?', type: 'select', options: ['1–5', '6–15', '16–30', '30+'], required: true, order: 4 },
    { key: 'availability_wkends', label: 'Are you available on weekends?', type: 'checkbox', order: 5 },
  ];
  const info = db
    .prepare('INSERT INTO application_forms (position_id, instructions, fields_json) VALUES (?, ?, ?)')
    .run(positionId, 'Answer every question below honestly. Incomplete or inaccurate answers may lead to rejection.', JSON.stringify(defaultFields));
  const id = Number(info.lastInsertRowid);
  return { id, position_id: positionId, instructions: 'Answer every question below honestly.', fields: defaultFields, updated_at: new Date().toISOString() };
}

export function updateForm(db: DatabaseSync, positionId: number, instructions: string, fields: FormField[]): void {
  db.prepare(
    'UPDATE application_forms SET instructions = ?, fields_json = ?, updated_at = ? WHERE position_id = ?',
  ).run(instructions, JSON.stringify(fields), new Date().toISOString(), positionId);
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return [];
  }
}

export interface FieldError {
  key: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: FieldError[];
  answers: Record<string, string>;
}

/**
 * Server-side validation of submitted answers against a form definition.
 * The returned `answers` object contains only sanitized, validated values —
 * it is the only form of answers that may be persisted or rendered.
 */
export function validateAnswers(fields: FormField[], submitted: Record<string, unknown>): ValidationResult {
  const errors: FieldError[] = [];
  const answers: Record<string, string> = {};
  const MAX_TEXT = 2000;

  for (const f of fields) {
    const raw = submitted[f.key];
    if (f.type === 'checkbox') {
      const checked = raw === true || raw === 'on' || raw === '1' || raw === 'true' || raw === 'yes' || raw === 'Yes';
      answers[f.key] = checked ? 'yes' : 'no';
      continue;
    }
    const value = typeof raw === 'string' ? raw.trim() : raw === undefined || raw === null ? '' : String(raw).trim();
    if (f.required && value === '') {
      errors.push({ key: f.key, message: 'This field is required.' });
      continue;
    }
    if (value === '') continue;
    if (f.type === 'select') {
      if (!f.options?.includes(value)) {
        errors.push({ key: f.key, message: 'Please choose one of the provided options.' });
        continue;
      }
    }
    if (value.length > MAX_TEXT) {
      errors.push({ key: f.key, message: `Answer must be at most ${MAX_TEXT} characters.` });
      continue;
    }
    answers[f.key] = value;
  }
  return { ok: errors.length === 0, errors, answers };
}
