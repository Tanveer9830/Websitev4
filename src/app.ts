import express, { type Express } from 'express';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import { REPO_ROOT, type AppConfig } from './config.ts';
import { getDb } from './db.ts';
import { Sessions } from './security/session.ts';
import { csrfProtection, errorHandler, flashStorePeek, makeSessionMiddleware, notFound, securityHeaders, type AppServices } from './middleware.ts';
import { publicRouter } from './routes/public.ts';
import { accountRouter } from './routes/account.ts';
import { adminRouter } from './routes/admin.ts';
import { ownerRouter } from './routes/owner.ts';
import './types.ts';

export interface BuiltApp {
  app: Express;
  svc: AppServices;
}

export function buildApp(cfg: AppConfig): BuiltApp {
  const db = getDb(cfg);
  const sessions = new Sessions({ db, secret: cfg.sessionSecret });
  const svc: AppServices = { cfg, db, sessions };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', cfg.trustProxy);
  app.set('view engine', 'ejs');
  app.set('views', path.join(REPO_ROOT, 'src', 'views'));

  app.use(securityHeaders);
  app.use(express.urlencoded({ extended: true, limit: '256kb' }));
  app.use(express.json({ limit: '64kb' }));
  app.use(cookieParser());
  app.use(makeSessionMiddleware(svc));
  app.use(csrfProtection);

  // Shared locals for templates.
  app.use((req, res, next) => {
    res.locals.settings = null; // set per route (lazy to avoid a query on static assets)
    res.locals.csrfToken = req.sessionRec?.csrf_token ?? '';
    res.locals.user = req.user ?? null;
    res.locals.isStaff = req.isStaff ?? false;
    res.locals.isSuper = req.user?.is_super === 1 || false;
    // Consume a pending flash message from the previous request.
    res.locals.flash = null;
    if (req.sessionRaw) {
      const pending = flashStorePeek(req.sessionRaw);
      if (pending) res.locals.flash = pending;
    }
    res.locals.appTitle = 'TOP CLOUD';
    next();
  });

  app.use(express.static(path.join(REPO_ROOT, 'src', 'public'), { maxAge: '1h' }));

  app.use('/', publicRouter(svc));
  app.use('/account', accountRouter(svc));
  app.use('/admin/owner', ownerRouter(svc));
  app.use('/admin', adminRouter(svc));

  app.use(notFound);
  app.use(errorHandler);

  return { app, svc };
}
