import { Router, type Request, type Response } from 'express';
import type { AppServices } from '../middleware.ts';
import { flash, requirePerm, requireStaff } from '../middleware.ts';
import {
  addInternalNote,
  assignReviewer,
  changeStatus,
  getApplication,
  internalNotes,
  listApplications,
  sendApplicantMessage,
  STATUSES,
  statusCounts,
  STATUS_LABELS,
  statusHistory,
  type Status,
} from '../services/applications.ts';
import { getFormForPosition, sanitizeFieldsJson, updateForm, type FormField } from '../services/forms.ts';
import { createPosition, listPositions, getPosition, updatePosition, validatePositionInput } from '../services/positions.ts';
import { createUser, findStaffById, listStaff, updateUser } from '../services/staff.ts';
import { effectivePermissions, PERMISSIONS, setPermissions, type Permission } from '../services/permissions.ts';
import { getSettings, updateSettings } from '../services/settings.ts';
import { auditAsUser } from '../services/audit.ts';
import { log } from '../logger.ts';
import { allRows, oneRow } from '../db.ts';

const PAGE_SIZE = 15;

function pageParam(req: Request): number {
  const n = Number(req.query.page);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

export function adminRouter(svc: AppServices): Router {
  const r = Router();
  const { db } = svc;

  r.use(requireStaff);

  // ---------- Admin dashboard ----------
  r.get('/', requirePerm('applications.view'), (req: Request, res: Response) => {
    const settings = getSettings(db);
    const counts = statusCounts(db);
    const recent = listApplications(db, { page: 1, perPage: 8 }).rows;
    const myQueue = listApplications(db, { page: 1, perPage: 8, reviewerId: req.user!.id }).rows;
    res.render('admin/dashboard', {
      title: 'Admin dashboard',
      settings,
      counts,
      recent,
      myQueue,
      statusLabels: STATUS_LABELS,
    });
  });

  // ---------- Application list ----------
  r.get('/applications', requirePerm('applications.view'), (req: Request, res: Response) => {
    const settings = getSettings(db);
    const q = {
      page: pageParam(req),
      perPage: PAGE_SIZE,
      search: str(req.query.q),
      status: str(req.query.status),
      positionId: num(req.query.position),
      reviewerId: num(req.query.reviewer),
    };
    const { rows, total } = listApplications(db, q);
    const positions = listPositions(db, { page: 1, perPage: 200 }).rows;
    const reviewers = listStaff(db);
    res.render('admin/applications', {
      title: 'Applications',
      settings,
      rows,
      total,
      page: q.page,
      perPage: PAGE_SIZE,
      q,
      statuses: STATUSES,
      statusLabels: STATUS_LABELS,
      positions,
      reviewers,
      reqUrl: req.originalUrl,
    });
  });

  // JSON endpoint for the live search box (GET only, view-permission gated).
  r.get('/applications.json', requirePerm('applications.view'), (req: Request, res: Response) => {
    const { rows, total } = listApplications(db, {
      page: pageParam(req),
      perPage: PAGE_SIZE,
      search: str(req.query.q),
      status: str(req.query.status),
    });
    res.json({
      total,
      rows: rows.map((a) => ({
        id: a.id,
        reference: a.reference,
        applicant: a.applicant_name,
        position: a.position_title,
        status: a.status,
        reviewer: a.reviewer_name ?? null,
        created_at: a.created_at,
      })),
    });
  });

  // ---------- Application detail ----------
  r.get('/applications/:id(\\d+)', requirePerm('applications.view'), (req: Request, res: Response) => {
    const app = getApplication(db, Number(req.params.id));
    if (!app) {
      res.status(404).render('errors/404', {} as never);
      return;
    }
    const settings = getSettings(db);
    const form = oneRow<{ fields_json: string }>(db, 'SELECT fields_json FROM application_forms WHERE id = ?', app.form_id);
    const labels: Record<string, string> = {};
    if (form) {
      try {
        for (const f of JSON.parse(form.fields_json)) {
          if (f && typeof f.key === 'string' && typeof f.label === 'string') labels[f.key] = f.label;
        }
      } catch {
        /* ignore */
      }
    }
    const answerEntries = Object.entries(JSON.parse(app.answers_json || '{}') as Record<string, string>).map(
      ([k, v]) => ({ key: k, label: labels[k] ?? k, value: v }),
    );
    const messages = allRows<{ id: number; body: string; at: string; sender: string }>(
      db,
      `SELECT m.id, m.body, m.at, u.display_name AS sender
         FROM applicant_messages m JOIN users u ON u.id = m.sender_id
         WHERE m.application_id = ? ORDER BY m.id ASC`,
      app.id,
    );
    res.render('admin/application', {
      title: `Application ${app.reference}`,
      settings,
      app,
      answerEntries,
      history: statusHistory(db, app.id),
      notes: internalNotes(db, app.id),
      messages,
      reviewers: listStaff(db),
      canReview: hasPerm(req, 'applications.review'),
      statusLabels: STATUS_LABELS,
      statuses: STATUSES,
    });
  });

  // ---------- Staff actions ----------
  r.post('/applications/:id(\\d+)/status', requirePerm('applications.review'), (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const to = str(req.body.status) as Status;
    if (!STATUSES.includes(to)) {
      flash(res, 'error', 'Unknown status.');
      res.redirect(`/admin/applications/${id}`);
      return;
    }
    const result = changeStatus(db, req.user!, id, to, str(req.body.note), req.ip);
    if (result.error) {
      log('warn', 'status change rejected', { user: req.user!.username, app: id, to, reason: result.error });
      flash(res, 'error', result.error);
    } else {
      flash(res, 'success', `Status updated to “${STATUS_LABELS[to]}”.`);
    }
    res.redirect(`/admin/applications/${id}`);
  });

  r.post('/applications/:id(\\d+)/assign', requirePerm('applications.review'), (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const reviewerId = num(req.body.reviewer);
    const result = assignReviewer(db, req.user!, id, reviewerId ?? null, req.ip);
    flash(res, result.error ? 'error' : 'success', result.error ?? 'Reviewer updated.');
    res.redirect(`/admin/applications/${id}`);
  });

  r.post('/applications/:id(\\d+)/notes', requirePerm('applications.review'), (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const result = addInternalNote(db, req.user!, id, str(req.body.body), req.ip);
    flash(res, result.error ? 'error' : 'success', result.error ?? 'Internal note added (staff-only).');
    res.redirect(`/admin/applications/${id}`);
  });

  r.post('/applications/:id(\\d+)/messages', requirePerm('applications.review'), (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const result = sendApplicantMessage(db, req.user!, id, str(req.body.body), req.ip);
    flash(res, result.error ? 'error' : 'success', result.error ?? 'Message sent to the applicant.');
    res.redirect(`/admin/applications/${id}`);
  });

  // ---------- Positions ----------
  r.get('/positions', requirePerm('positions.manage'), (req: Request, res: Response) => {
    const settings = getSettings(db);
    const { rows, total } = listPositions(db, { page: pageParam(req), perPage: PAGE_SIZE, search: str(req.query.q) });
    res.render('admin/positions', { title: 'Positions', settings, rows, total, page: pageParam(req), perPage: PAGE_SIZE, reqUrl: req.originalUrl });
  });

  r.get('/positions/new', requirePerm('positions.manage'), (req: Request, res: Response) => {
    const settings = getSettings(db);
    res.render('admin/position-form', {
      title: 'New position',
      settings,
      position: null,
      values: { title: '', department: '', summary: '', description: '', eligibility: '', open: true },
      errors: {} as Record<string, string>,
    });
  });

  r.post('/positions', requirePerm('positions.manage'), (req: Request, res: Response) => {
    const values = positionValues(req);
    const errors = validatePositionInput(values);
    if (Object.keys(errors).length) {
      flash(res, 'error', 'Please fix the highlighted fields.');
      res.status(422).render('admin/position-form', {
        title: 'New position',
        settings: getSettings(db),
        position: null,
        values,
        errors,
      });
      return;
    }
    const id = createPosition(db, { ...values, open: values.open });
    auditAsUser(db, req.user!, 'position.create', `position#${id}`, { title: values.title }, req.ip);
    flash(res, 'success', 'Position created.');
    res.redirect(`/admin/positions`);
  });

  r.get('/positions/:id(\\d+)/edit', requirePerm('positions.manage'), (req: Request, res: Response) => {
    const position = getPosition(db, Number(req.params.id));
    if (!position) {
      res.status(404).render('errors/404', {} as never);
      return;
    }
    res.render('admin/position-form', {
      title: `Edit — ${position.title}`,
      settings: getSettings(db),
      position,
      values: {
        title: position.title,
        department: position.department,
        summary: position.summary,
        description: position.description,
        eligibility: position.eligibility,
        open: !!position.open,
      },
      errors: {} as Record<string, string>,
    });
  });

  r.post('/positions/:id(\\d+)', requirePerm('positions.manage'), (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const values = positionValues(req);
    const errors = validatePositionInput(values);
    if (Object.keys(errors).length) {
      const position = getPosition(db, id);
      flash(res, 'error', 'Please fix the highlighted fields.');
      res.status(422).render('admin/position-form', {
        title: `Edit — ${position?.title ?? ''}`,
        settings: getSettings(db),
        position: position,
        values,
        errors,
      });
      return;
    }
    updatePosition(db, id, values);
    auditAsUser(db, req.user!, 'position.update', `position#${id}`, { title: values.title }, req.ip);
    flash(res, 'success', 'Position updated.');
    res.redirect('/admin/positions');
  });

  // ---------- Forms ----------
  r.get('/forms', requirePerm('forms.manage'), (req: Request, res: Response) => {
    const settings = getSettings(db);
    const positions = listPositions(db, { page: 1, perPage: 200 }).rows;
    const withForms = positions.map((p) => {
      const f = oneRow<{ id: number; instructions: string; fields_json: string; updated_at: string }>(
        db,
        'SELECT id, instructions, fields_json, updated_at FROM application_forms WHERE position_id = ?',
        p.id,
      );
      let fieldCount = 0;
      try {
        fieldCount = f ? (JSON.parse(f.fields_json) as unknown[]).length : 0;
      } catch {
        fieldCount = 0;
      }
      return { ...p, form: f ? { id: f.id, updated_at: f.updated_at, fieldCount } : null };
    });
    res.render('admin/forms', { title: 'Application forms', settings, positions: withForms });
  });

  r.get('/forms/:positionId(\\d+)', requirePerm('forms.manage'), (req: Request, res: Response) => {
    const position = getPosition(db, Number(req.params.positionId));
    if (!position) {
      res.status(404).render('errors/404', {} as never);
      return;
    }
    const form = getFormForPosition(db, position.id);
    res.render('admin/form-edit', {
      title: `Form — ${position.title}`,
      settings: getSettings(db),
      position,
      form,
      error: undefined as string | undefined,
      rawFields: form.fields,
    });
  });

  r.post('/forms/:positionId(\\d+)', requirePerm('forms.manage'), (req: Request, res: Response) => {
    const position = getPosition(db, Number(req.params.positionId));
    if (!position) {
      res.status(404).render('errors/404', {} as never);
      return;
    }
    const parsed = sanitizeFieldsJson(parseJsonArray(req.body.fields_json));
    if (parsed.error) {
      const form = getFormForPosition(db, position.id);
      res.status(422).render('admin/form-edit', {
        title: `Form — ${position.title}`,
        settings: getSettings(db),
        position,
        form,
        error: parsed.error,
        rawFields: form.fields,
      });
      return;
    }
    updateForm(db, position.id, str(req.body.instructions), parsed.fields);
    auditAsUser(db, req.user!, 'form.update', `position#${position.id}`, { fields: parsed.fields.length }, req.ip);
    flash(res, 'success', 'Form saved. It is live for new applicants immediately.');
    res.redirect('/admin/forms');
  });

  // ---------- Staff management ----------
  r.get('/staff', requirePerm('staff.manage'), (req: Request, res: Response) => {
    const settings = getSettings(db);
    const staff = listStaff(db);
    const permissionStates = staff.map((u) => ({
      user: u,
      perms: PERMISSIONS.reduce((acc, p) => {
        acc[p] = hasPermForUser(db, u, p);
        return acc;
      }, {} as Record<string, boolean>),
    }));
    res.render('admin/staff', {
      title: 'Staff',
      settings,
      staff,
      permissionStates,
      permissions: PERMISSIONS,
      error: undefined as string | undefined,
    });
  });

  r.post('/staff', requirePerm('staff.manage'), (req: Request, res: Response) => {
    const settings = getSettings(db);
    const result = createUser(
      db,
      req.user!,
      {
        username: str(req.body.username),
        email: str(req.body.email),
        display_name: str(req.body.display_name),
        password: String(req.body.password || ''),
        role: (req.body.role === 'admin' ? 'admin' : 'reviewer') as 'admin' | 'reviewer',
      },
      req.ip,
    );
    if (result.error) {
      flash(res, 'error', result.error);
      res.redirect('/admin/staff');
      return;
    }
    flash(res, 'success', `Staff account created for @${result.user!.username}. Share the initial password securely and ask them to change it after first login.`);
    res.redirect('/admin/staff');
  });

  r.post('/staff/:id(\\d+)/update', requirePerm('staff.manage'), (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const result = updateUser(
      db,
      req.user!,
      id,
      {
        display_name: req.body.display_name !== undefined ? str(req.body.display_name) : undefined,
        role: req.body.role ? (req.body.role === 'admin' ? 'admin' : 'reviewer') : undefined,
        active: req.body.active !== undefined ? req.body.active === '1' : undefined,
      },
      req.ip,
    );
    flash(res, result.error ? 'error' : 'success', result.error ?? 'User updated.');
    res.redirect('/admin/staff');
  });

  r.post('/staff/:id(\\d+)/permissions', requirePerm('staff.manage'), (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const target = findStaffById(db, id);
    if (!target) {
      flash(res, 'error', 'User not found.');
      res.redirect('/admin/staff');
      return;
    }
    const perms: Partial<Record<Permission, boolean>> = {};
    for (const p of PERMISSIONS) {
      const v = req.body[`perm_${p}`];
      const granted = v === '1' || (Array.isArray(v) && v.includes('1'));
      const denied = v === '0' || (Array.isArray(v) && !v.includes('1'));
      if (granted) perms[p] = true;
      else if (denied) perms[p] = false;
    }
    try {
      setPermissions(db, req.user!, target, perms);
      auditAsUser(db, req.user!, 'staff.permissions', `user#${id}`, { username: target.username }, req.ip);
      flash(res, 'success', `Permissions updated for @${target.username}.`);
    } catch (e) {
      flash(res, 'error', (e as Error).message);
    }
    res.redirect('/admin/staff');
  });

  // ---------- Settings ----------
  r.get('/settings', requirePerm('settings.manage'), (req: Request, res: Response) => {
    res.render('admin/settings', {
      title: 'Settings',
      settings: getSettings(db),
      error: undefined as string | undefined,
    });
  });

  r.post('/settings', requirePerm('settings.manage'), (req: Request, res: Response) => {
    const s = getSettings(db);
    updateSettings(db, {
      site_name: str(req.body.site_name) || s.site_name,
      site_tagline: str(req.body.site_tagline) || s.site_tagline,
      applications_open: req.body.applications_open === '1',
      registration_open: req.body.registration_open === '1',
      public_contact: str(req.body.public_contact),
    });
    auditAsUser(db, req.user!, 'settings.update', 'settings', {
      applications_open: req.body.applications_open === '1',
      registration_open: req.body.registration_open === '1',
    }, req.ip);
    flash(res, 'success', 'Settings saved.');
    res.redirect('/admin/settings');
  });

  return r;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function hasPerm(req: Request, p: Permission): boolean {
  return req.user ? (req.user.is_super === 1 || (req.perms?.has(p) ?? false)) : false;
}

function hasPermForUser(
  db: AppServices['db'],
  u: { id: number; role: string; is_super: number; active: number },
  p: Permission,
): boolean {
  if (u.is_super) return true;
  if (u.role === 'applicant' || !u.active) return false;
  return effectivePermissions(db, u as never).has(p);
}

function parseJsonArray(raw: unknown): unknown {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function positionValues(req: Request) {
  return {
    title: str(req.body.title),
    department: str(req.body.department),
    summary: str(req.body.summary),
    description: String(req.body.description || ''),
    eligibility: String(req.body.eligibility || ''),
    open: req.body.open === '1',
  };
}
