import { Router, type Request, type Response } from 'express';
import type { AppServices } from '../middleware.ts';
import { dbRateLimit } from '../security/ratelimit.ts';
import { authenticate, registerApplicant } from '../services/auth.ts';
import { createApplication, STATUS_LABELS } from '../services/applications.ts';
import { getFormForPosition, validateAnswers, type FormField } from '../services/forms.ts';
import { listPositions, getPosition } from '../services/positions.ts';
import { getSettings } from '../services/settings.ts';
import { oneRow } from '../db.ts';
import { flash, setSessionCookie } from '../middleware.ts';
import { audit } from '../services/audit.ts';

export function publicRouter(svc: AppServices): Router {
  const r = Router();
  const { db, cfg, sessions } = svc;

  const loginLimiter = dbRateLimit(db, {
    windowMs: 15 * 60 * 1000,
    max: 6,
    key: (req) => `login:${req.ip}:${String(req.body?.username || '').trim().toLowerCase()}`,
  });

  const registerLimiter = dbRateLimit(db, {
    windowMs: 15 * 60 * 1000,
    max: 5,
    key: (req) => `register:${req.ip}`,
  });

  // ---------- Landing ----------
  r.get('/', (req: Request, res: Response) => {
    const settings = getSettings(db);
    const positions = listPositions(db, { openOnly: true, page: 1, perPage: 12 });
    res.render('public/index', { title: 'Home', settings, positions: positions.rows, openCount: positions.total });
  });

  // ---------- Recruitment information ----------
  r.get('/recruitments', (req: Request, res: Response) => {
    const settings = getSettings(db);
    res.render('public/recruitments', { title: 'Recruitment Info', settings });
  });

  // ---------- Positions ----------
  r.get('/positions', (req: Request, res: Response) => {
    const settings = getSettings(db);
    const page = Math.max(1, Number(req.query.page) || 1);
    const { rows, total } = listPositions(db, { openOnly: true, page, perPage: 12 });
    res.render('public/positions', {
      title: 'Open Positions',
      settings,
      positions: rows,
      page,
      perPage: 12,
      total,
      reqUrl: req.originalUrl,
    });
  });

  r.get('/positions/:id(\\d+)', (req: Request, res: Response) => {
    const settings = getSettings(db);
    const position = getPosition(db, Number(req.params.id));
    if (!position) {
      res.status(404).render('errors/404', {} as never);
      return;
    }
    let applied = false;
    if (req.user) {
      const dup = oneRow<{ id: number }>(
        db,
        `SELECT id FROM applications WHERE applicant_id = ? AND position_id = ?
           AND status IN ('pending','reviewing','under_consideration','on_hold')`,
        req.user.id,
        position.id,
      );
      applied = !!dup;
    }
    res.render('public/position', { title: position.title, settings, position, applied });
  });

  // ---------- Apply (dynamic form from database) ----------
  r.get('/apply/:id(\\d+)', (req: Request, res: Response) => {
    if (!req.user) {
      res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
      return;
    }
    const settings = getSettings(db);
    if (!settings.applications_open) {
      flash(res, 'error', 'Applications are currently closed. Please check back later.');
      res.redirect('/positions');
      return;
    }
    const position = getPosition(db, Number(req.params.id));
    if (!position || !position.open) {
      flash(res, 'error', 'This position is no longer accepting applications.');
      res.redirect('/positions');
      return;
    }
    if (req.user.role !== 'applicant') {
      flash(res, 'error', 'Staff accounts cannot submit applications.');
      res.redirect(req.isStaff ? '/admin' : '/account');
      return;
    }
    const dup = oneRow<{ id: number; status: string }>(
      db,
      `SELECT id, status FROM applications WHERE applicant_id = ? AND position_id = ?
         AND status IN ('pending','reviewing','under_consideration','on_hold')`,
      req.user.id,
      position.id,
    );
    if (dup) {
      flash(res, 'error', `You already have an application for this position (status: ${STATUS_LABELS[dup.status as keyof typeof STATUS_LABELS] ?? dup.status}). You can track it from your dashboard.`);
      res.redirect('/account');
      return;
    }
    const form = getFormForPosition(db, position.id);
    res.render('public/apply', {
      title: `Apply — ${position.title}`,
      settings,
      position,
      form,
      fieldErrors: {} as Record<string, string>,
      values: {} as Record<string, string>,
    });
  });

  r.post('/apply/:id(\\d+)', (req: Request, res: Response) => {
    if (!req.user) {
      res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
      return;
    }
    const settings = getSettings(db);
    if (!settings.applications_open) {
      flash(res, 'error', 'Applications are currently closed.');
      res.redirect('/positions');
      return;
    }
    const position = getPosition(db, Number(req.params.id));
    if (!position || !position.open) {
      flash(res, 'error', 'This position is no longer accepting applications.');
      res.redirect('/positions');
      return;
    }
    if (req.user.role !== 'applicant') {
      flash(res, 'error', 'Staff accounts cannot submit applications.');
      res.redirect(req.isStaff ? '/admin' : '/account');
      return;
    }
    const form = getFormForPosition(db, position.id);
    const validation = validateAnswers(form.fields, req.body);
    if (!validation.ok) {
      res.status(422).render('public/apply', {
        title: `Apply — ${position.title}`,
        settings,
        position,
        form,
        fieldErrors: Object.fromEntries(validation.errors.map((e) => [e.key, e.message])),
        values: validationAnswersAsValues(form.fields, req.body),
      });
      return;
    }
    const { error, application } = createApplication(db, {
      applicant: req.user,
      positionId: position.id,
      form,
      validation,
      ip: req.ip,
    });
    if (error || !application) {
      flash(res, 'error', error || 'Could not submit the application.');
      res.redirect(`/apply/${position.id}`);
      return;
    }
    res.render('public/confirmation', {
      title: 'Application received',
      settings,
      application,
      position,
    });
  });

  // ---------- Login / Register / Logout ----------
  r.get('/login', (req: Request, res: Response) => {
    if (req.user) {
      res.redirect('/admin');
      return;
    }
    const settings = getSettings(db);
    res.render('public/login', {
      title: 'Sign in',
      settings,
      next: typeof req.query.next === 'string' ? req.query.next : '',
      error: undefined as string | undefined,
    });
  });

  r.post('/login', loginLimiter, (req: Request, res: Response) => {
    const settings = getSettings(db);
    const next = typeof req.query.next === 'string' ? req.query.next : '';
    const { error, user, token } = authenticate(db, sessions, {
      identifier: String(req.body.username || ''),
      password: String(req.body.password || ''),
      ip: req.ip,
      ua: req.get('user-agent') || undefined,
    });
    if (error || !user || !token) {
      res.status(401).render('public/login', {
        title: 'Sign in',
        settings,
        next,
        error,
      });
      return;
    }
    setSessionCookie(res, svc, token);
    if (user.must_change_pw) {
      res.redirect('/account/password?forced=1');
      return;
    }
    // Only allow internal redirects; sensible default landing per role.
    const wanted = safeNext(next);
    res.redirect(wanted !== '/' ? wanted : user.role !== 'applicant' ? '/admin' : '/account');
  });

  r.get('/register', (req: Request, res: Response) => {
    if (req.user) {
      res.redirect('/admin');
      return;
    }
    const settings = getSettings(db);
    if (!settings.registration_open) {
      flash(res, 'error', 'New registrations are currently closed.');
      res.redirect('/login');
      return;
    }
    res.render('public/register', {
      title: 'Create account',
      settings,
      error: undefined as string | undefined,
      values: {} as Record<string, string>,
    });
  });

  r.post('/register', registerLimiter, (req: Request, res: Response) => {
    const settings = getSettings(db);
    if (!settings.registration_open) {
      flash(res, 'error', 'New registrations are currently closed.');
      res.redirect('/login');
      return;
    }
    const values = {
      username: String(req.body.username || ''),
      email: String(req.body.email || ''),
      display_name: String(req.body.display_name || ''),
    };
    const { error, user, token } = registerApplicant(db, sessions, {
      ...values,
      password: String(req.body.password || ''),
      ip: req.ip,
      ua: req.get('user-agent') || undefined,
    });
    if (error || !user || !token) {
      res.status(422).render('public/register', {
        title: 'Create account',
        settings,
        error,
        values,
      });
      return;
    }
    setSessionCookie(res, svc, token);
    flash(res, 'success', 'Welcome to TOP CLOUD! Your account is ready.');
    res.redirect('/positions');
  });

  r.post('/logout', (req: Request, res: Response) => {
    if (req.sessionRaw) {
      if (req.user) {
        audit(db, { id: req.user.id, label: `@${req.user.username}` }, 'auth.logout', 'auth', {}, req.ip);
      }
      sessions.destroy(req.sessionRaw);
      setSessionCookie(res, svc, null);
    }
    res.redirect('/');
  });

  r.get('/health', (req: Request, res: Response) => {
    let dbOk = false;
    try {
      db.prepare('SELECT 1 AS ok').get();
      dbOk = true;
    } catch {
      dbOk = false;
    }
    const status = dbOk ? 200 : 503;
    res.status(status).json({
      status: dbOk ? 'ok' : 'degraded',
      database: dbOk ? 'ok' : 'error',
      version: '1.0.0',
      uptime_s: Math.round(process.uptime()),
    });
  });

  return r;
}

function safeNext(next: string): string {
  if (next && next.startsWith('/') && !next.startsWith('//')) return next;
  return '/';
}

function validationAnswersAsValues(fields: FormField[], body: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const raw = body[f.key];
    out[f.key] = f.type === 'checkbox' ? (raw ? 'yes' : '') : typeof raw === 'string' ? raw : '';
  }
  return out;
}
