import { Router, type Request, type Response } from 'express';
import type { AppServices } from '../middleware.ts';
import { requireUser, flash } from '../middleware.ts';
import {
  applicantMessages,
  getApplicationForApplicant,
  listApplicantApplications,
  STATUS_LABELS,
  type Status,
} from '../services/applications.ts';
import { changePassword } from '../services/auth.ts';
import { getSettings } from '../services/settings.ts';
import { allRows, oneRow } from '../db.ts';

export function accountRouter(svc: AppServices): Router {
  const r = Router();
  const { db, sessions } = svc;

  r.use(requireUser);
  r.use((req: Request, res: Response, next) => {
    if (!req.user || req.user.role !== 'applicant') {
      // Staff members should not be in the applicant area.
      res.redirect(req.isStaff ? '/admin' : '/');
      return;
    }
    next();
  });

  // Dashboard: only this applicant's applications (enforced in SQL).
  r.get('/', (req: Request, res: Response) => {
    const settings = getSettings(db);
    const apps = listApplicantApplications(db, req.user!.id);
    const withMessages = apps.map((a) => ({
      ...a,
      messages: applicantMessages(db, a.id),
    }));
    const unread = withMessages.filter((a) => a.messages.length > 0).length;
    res.render('account/dashboard', {
      title: 'My applications',
      settings,
      apps: withMessages,
      unread,
      statusLabels: STATUS_LABELS,
    });
  });

  // Detail: ownership check via getApplicationForApplicant (WHERE applicant_id = ?).
  r.get('/applications/:id(\\d+)', (req: Request, res: Response) => {
    const settings = getSettings(db);
    const app = getApplicationForApplicant(db, req.user!.id, Number(req.params.id));
    if (!app) {
      res.status(404).render('errors/404', {} as never);
      return;
    }
    const form = oneRow<{ fields_json: string }>(db, 'SELECT fields_json FROM application_forms WHERE id = ?', app.form_id);
    let labels: Record<string, string> = {};
    if (form) {
      try {
        for (const f of JSON.parse(form.fields_json)) {
          if (f && typeof f.key === 'string' && typeof f.label === 'string') labels[f.key] = f.label;
        }
      } catch {
        /* keep empty labels */
      }
    }
    const answerEntries = Object.entries(JSON.parse(app.answers_json || '{}') as Record<string, string>).map(
      ([k, v]) => ({ key: k, label: labels[k] ?? k, value: v }),
    );
    const history = allRows<{ to_status: string; at: string }>(db, 'SELECT to_status, at FROM status_history WHERE application_id = ? ORDER BY id ASC', app.id);
    const messages = applicantMessages(db, app.id);
    res.render('account/application', {
      title: `Application ${app.reference}`,
      settings,
      app,
      answerEntries,
      history,
      messages,
      statusLabels: STATUS_LABELS,
    });
  });

  // Password change.
  r.get('/password', (req: Request, res: Response) => {
    const settings = getSettings(db);
    const forced = req.query.forced === '1';
    res.render('account/password', {
      title: 'Change password',
      settings,
      forced,
      error: undefined as string | undefined,
      success: undefined as string | undefined,
    });
  });

  r.post('/password', (req: Request, res: Response) => {
    const settings = getSettings(db);
    const result = changePassword(db, sessions, {
      user: req.user!,
      current: String(req.body.current || ''),
      next: String(req.body.next || ''),
      ip: req.ip,
    });
    if (result.error) {
      res.status(422).render('account/password', {
        title: 'Change password',
        settings,
        forced: req.user!.must_change_pw,
        error: result.error,
        success: undefined,
      });
      return;
    }
    flash(res, 'success', 'Password updated successfully.');
    res.redirect('/account');
  });

  return r;
}
