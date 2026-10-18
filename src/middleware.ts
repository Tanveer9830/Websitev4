import type { NextFunction, Request, Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import type { AppConfig } from './config.ts';
import { effectivePermissions, hasPermission, type Permission } from './services/permissions.ts';
import { SESSION_COOKIE, sessionCookieOptions, type Sessions } from './security/session.ts';
import { log, recordError } from './logger.ts';
import { oneRow } from './db.ts';
import type { StaffUser } from './services/permissions.ts';

export interface AppServices {
  cfg: AppConfig;
  db: DatabaseSync;
  sessions: Sessions;
}

/** Attach session + user to every request. Anonymous visitors get a session
 *  (with a CSRF token) so that every form — including login/register — is
 *  protected. */
export function makeSessionMiddleware(svc: AppServices) {
  const { db, sessions, cfg } = svc;
  return (req: Request, res: Response, next: NextFunction) => {
    let raw = req.cookies?.[SESSION_COOKIE];
    let rec = raw ? sessions.load(raw) : null;
    if (!rec) {
      // New anonymous session (also covers expired/invalid cookies).
      const created = sessions.create(null, req.ip, req.get('user-agent') || undefined);
      raw = created.token;
      rec = {
        token_hash: '',
        user_id: null,
        csrf_token: created.csrf,
        ip: req.ip ?? null,
        user_agent: null,
        created_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
      };
      res.cookie(SESSION_COOKIE, raw, sessionCookieOptions(cfg, false));
    }
    let user: StaffUser | null = null;
    if (rec.user_id) {
      const row = oneRow<StaffUser>(db, 'SELECT * FROM users WHERE id = ?', rec.user_id);
      if (row && row.active) {
        user = row;
      } else {
        if (row) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
        if (raw) sessions.destroy(raw);
        const created = sessions.create(null, req.ip, req.get('user-agent') || undefined);
        raw = created.token;
        rec = {
          token_hash: '',
          user_id: null,
          csrf_token: created.csrf,
          ip: req.ip ?? null,
          user_agent: null,
          created_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
        };
        res.cookie(SESSION_COOKIE, raw, sessionCookieOptions(cfg, false));
      }
    }
    req.sessionRaw = raw;
    req.sessionRec = rec;
    req.user = user;
    req.perms = user ? effectivePermissions(db, user) : new Set<Permission>();
    req.isStaff = !!user && (user.is_super === 1 || user.role === 'admin' || user.role === 'reviewer');
    req.flash = null;
    next();
  };
}

/** CSRF protection: token check on unsafe methods + strict origin check. */
export function csrfProtection(req: Request, res: Response, next: NextFunction) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const host = req.headers.host;
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (!host || new URL(origin).host !== host) {
        res.status(403).type('html').send('<h1>403 — Cross-origin request blocked.</h1>');
        return;
      }
    } catch {
      res.status(403).type('html').send('<h1>403 — Malformed Origin header.</h1>');
      return;
    }
  } else if (req.headers.referer) {
    try {
      const refHost = new URL(req.headers.referer).host;
      if (host && refHost !== host && !host.includes(refHost) && !refHost.includes(host)) {
        res.status(403).type('html').send('<h1>403 — Cross-origin request blocked.</h1>');
        return;
      }
    } catch {
      /* ignore malformed referer */
    }
  }
  const rec = req.sessionRec;
  const token =
    (req.body && typeof req.body === 'object' && (req.body._csrf as string | undefined)) ||
    (req.headers['x-csrf-token'] as string | undefined);
  if (!rec || !token || token !== rec.csrf_token) {
    log('warn', 'csrf check failed', { path: req.path, method: req.method });
    res.status(403).type('html').render('errors/403', {
      message: 'Your form submission was rejected (missing or invalid security token). Go back, refresh the page, and try again.',
    } as never);
    return;
  }
  next();
}

/** Security headers. */
export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "form-action 'self'",
      "base-uri 'self'",
      "frame-ancestors 'self'",
      "object-src 'none'",
    ].join('; '),
  );
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
}

interface FlashEntry {
  type: 'success' | 'error' | 'info';
  msg: string;
  ts: number;
}
const flashStore = new Map<string, FlashEntry>();
const FLASH_TTL_MS = 10 * 60 * 1000;

function pruneFlashStore(): void {
  const now = Date.now();
  for (const [k, v] of flashStore) {
    if (now - v.ts > FLASH_TTL_MS) flashStore.delete(k);
  }
}

/**
 * Set a one-shot flash message displayed on the NEXT rendered page.
 * Stored in a bounded in-memory map keyed by the session token so that
 * flash + redirect (the common pattern) survives the extra request.
 */
export function flash(res: Response, type: 'success' | 'error' | 'info', msg: string) {
  const raw = res.req?.sessionRaw;
  if (!raw) return;
  flashStore.set(raw, { type, msg, ts: Date.now() });
  if (flashStore.size > 2000) pruneFlashStore();
}

/** Read-and-discard the pending flash for a session (called by app locals). */
export function flashStorePeek(raw: string): { type: 'success' | 'error' | 'info'; msg: string } | null {
  const entry = flashStore.get(raw);
  if (!entry) return null;
  if (Date.now() - entry.ts > FLASH_TTL_MS) {
    flashStore.delete(raw);
    return null;
  }
  flashStore.delete(raw);
  return { type: entry.type, msg: entry.msg };
}

/**
 * Authorization guards. Every check is server-side; templates may read
 * req.perms for presentation only.
 */
export function requireUser(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    return;
  }
  if (req.user.must_change_pw && req.path !== '/account/password') {
    res.redirect('/account/password?forced=1');
    return;
  }
  next();
}

export function requireStaff(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    return;
  }
  if (!req.isStaff) {
    res.status(403).render('errors/403', { message: 'This area is restricted to staff.' } as never);
    return;
  }
  next();
}

export function requirePerm(perm: Permission) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !req.isStaff) {
      res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
      return;
    }
    if (!req.perms?.has(perm)) {
      log('warn', 'permission denied', { user: req.user.username, perm, path: req.path });
      res.status(403).render('errors/403', {
        message: `You need the “${perm}” permission to access this.`,
      } as never);
      return;
    }
    next();
  };
}

export function requireOwner(req: Request, res: Response, next: NextFunction) {
  if (!req.user || !req.user.is_super) {
    if (!req.user) {
      res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
      return;
    }
    log('warn', 'owner access denied', { user: req.user.username, path: req.path });
    res.status(403).render('errors/403', { message: 'This area is restricted to the Super Owner.' } as never);
    return;
  }
  next();
}

/** Safe cookie setter for login/logout. */
export function setSessionCookie(res: Response, svc: AppServices, raw: string | null) {
  const opts = sessionCookieOptions(svc.cfg, reqIsSecure(svc.cfg));
  if (raw) {
    res.cookie(SESSION_COOKIE, raw, opts);
  } else {
    res.clearCookie(SESSION_COOKIE, { ...opts, maxAge: undefined });
  }
}

function reqIsSecure(cfg: AppConfig): boolean {
  // With a reverse proxy we trust X-Forwarded-Proto when TRUST_PROXY is on;
  // in development over plain HTTP the cookie stays usable.
  return cfg.secureCookies === 'false' ? false : cfg.secureCookies === 'true' ? true : cfg.env === 'development' ? false : true;
}

/** 404 + central error handler. Users never see stack traces. */
export function notFound(req: Request, res: Response) {
  res.status(404).render('errors/404', {} as never);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const e = err as Error & { status?: number };
  recordError(e?.message || 'Unknown error', e?.stack);
  log('error', e?.message || 'Unknown error', { path: req.path, method: req.method });
  const status = e?.status && e.status >= 400 && e.status < 600 ? e.status : 500;
  res.status(status).render(`errors/${status >= 500 ? '500' : '403'}`, {
    message: status >= 500 ? 'Something went wrong on our side. The team has been notified.' : undefined,
  } as never);
}
