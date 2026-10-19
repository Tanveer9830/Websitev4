import { Router, type Request, type Response } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import type { AppServices } from '../middleware.ts';
import { flash, requireOwner } from '../middleware.ts';
import { dailyCounts, positionCounts, statusCounts, STATUS_LABELS, listApplications } from '../services/applications.ts';
import { auditAsUser, listAudit } from '../services/audit.ts';
import { createBackup, listBackups, verifyBackup } from '../services/backup.ts';
import { listStaff, findStaffById, updateUser } from '../services/staff.ts';
import { PERMISSIONS, setPermissions, effectivePermissions, type Permission } from '../services/permissions.ts';
import { getSettings } from '../services/settings.ts';
import { configSummary } from '../config.ts';
import { getRecentErrors } from '../logger.ts';
import { oneRow } from '../db.ts';

export function ownerRouter(svc: AppServices): Router {
  const r = Router();
  const { db, cfg } = svc;

  r.use(requireOwner);

  // ---------- Overview ----------
  r.get('/', (req: Request, res: Response) => {
    const settings = getSettings(db);
    const counts = statusCounts(db);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const positions = positionCounts(db);
    const daily = dailyCounts(db, 14);
    const staff = listStaff(db);
    const applicants = oneRow<{ c: number }>(db, "SELECT COUNT(*) AS c FROM users WHERE role = 'applicant'")!.c;
    res.render('owner/dashboard', {
      title: 'Owner overview',
      settings,
      counts,
      total,
      positions,
      daily,
      staff,
      applicants,
      statusLabels: STATUS_LABELS,
    });
  });

  // ---------- Analytics ----------
  r.get('/analytics', (req: Request, res: Response) => {
    const settings = getSettings(db);
    const counts = statusCounts(db);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const positions = positionCounts(db);
    const daily = dailyCounts(db, 30);
    res.render('owner/analytics', {
      title: 'Analytics',
      settings,
      counts,
      total,
      positions,
      daily,
      statusLabels: STATUS_LABELS,
    });
  });

  // ---------- Audit log ----------
  r.get('/audit', (req: Request, res: Response) => {
    const settings = getSettings(db);
    const page = Math.max(1, Number(req.query.page) || 1);
    const { rows, total } = listAudit(db, {
      search: typeof req.query.q === 'string' ? req.query.q : undefined,
      action: typeof req.query.action === 'string' ? req.query.action : undefined,
      page,
      perPage: 25,
    });
    const actions = [...new Set(rows.map((x) => x.action))];
    res.render('owner/audit', {
      title: 'Audit log',
      settings,
      rows,
      total,
      page,
      perPage: 25,
      q: typeof req.query.q === 'string' ? req.query.q : '',
      action: typeof req.query.action === 'string' ? req.query.action : '',
      actions,
      reqUrl: req.originalUrl,
    });
  });

  // ---------- Backups ----------
  r.get('/backups', (req: Request, res: Response) => {
    const settings = getSettings(db);
    const backups = listBackups(cfg.backupDir);
    res.render('owner/backups', {
      title: 'Backups',
      settings,
      backups,
      backupDir: cfg.backupDir,
      port: cfg.port,
    });
  });

  r.post('/backups/create', (req: Request, res: Response) => {
    try {
      const b = createBackup(db, cfg.backupDir);
      auditAsUser(db, req.user!, 'backup.create', b.file, { size: b.size }, req.ip);
      flash(res, 'success', `Backup created: ${b.file} (${formatBytes(b.size)})`);
    } catch (e) {
      flash(res, 'error', `Backup failed: ${(e as Error).message}`);
    }
    res.redirect('/admin/owner/backups');
  });

  r.post('/backups/:file/verify', (req: Request, res: Response) => {
    const file = safeBackupName(req.params.file);
    if (!file) {
      flash(res, 'error', 'Invalid backup file name.');
      res.redirect('/admin/owner/backups');
      return;
    }
    const full = path.join(cfg.backupDir, file);
    if (!fs.existsSync(full)) {
      flash(res, 'error', 'Backup file not found.');
      res.redirect('/admin/owner/backups');
      return;
    }
    const result = verifyBackup(full);
    auditAsUser(db, req.user!, 'backup.verify', file, { ok: result.ok }, req.ip);
    flash(
      res,
      result.ok ? 'success' : 'error',
      `Integrity check: ${result.ok ? 'PASSED — backup is consistent.' : 'FAILED — ' + result.message}`,
    );
    res.redirect('/admin/owner/backups');
  });

  r.get('/backups/:file/download', (req: Request, res: Response) => {
    const file = safeBackupName(req.params.file);
    if (!file) {
      res.status(400).end();
      return;
    }
    const full = path.join(cfg.backupDir, file);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      res.status(404).end();
      return;
    }
    auditAsUser(db, req.user!, 'backup.download', file, {}, req.ip);
    res.download(full, file);
  });

  // ---------- System health ----------
  r.get('/system', (req: Request, res: Response) => {
    const settings = getSettings(db);
    let integrity = '—';
    let dbSize = 0;
    try {
      integrity = oneRow<{ integrity_check: string }>(db, 'PRAGMA integrity_check;')!.integrity_check;
      const st = fs.existsSync(cfg.databasePath) ? fs.statSync(cfg.databasePath) : null;
      dbSize = st?.size ?? 0;
    } catch {
      integrity = 'unavailable';
    }
    const pending = oneRow<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM applications WHERE status = ?', 'pending')!.c;
    const recentApplications = listApplications(db, { page: 1, perPage: 5 }).rows;
    res.render('owner/system', {
      title: 'System',
      settings,
      config: configSummary(cfg),
      nodeVersion: process.version,
      uptime: Math.round(process.uptime()),
      integrity,
      dbSize,
      pending,
      recentErrors: getRecentErrors(),
      recentApplications,
      statusLabels: STATUS_LABELS,
    });
  });

  // ---------- Staff (full owner view incl. role changes) ----------
  r.get('/staff', (req: Request, res: Response) => {
    const settings = getSettings(db);
    const staff = listStaff(db);
    const permissionStates = staff.map((u) => ({
      user: u,
      perms: PERMISSIONS.reduce((acc, p) => {
        acc[p] = u.is_super ? true : effectivePermissions(db, u).has(p);
        return acc;
      }, {} as Record<string, boolean>),
    }));
    res.render('owner/staff', {
      title: 'Staff & permissions',
      settings,
      staff,
      permissionStates,
      permissions: PERMISSIONS,
      error: undefined as string | undefined,
    });
  });

  r.post('/staff/:id(\\d+)/update', (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const result = updateUser(
      db,
      req.user!,
      id,
      {
        display_name: req.body.display_name !== undefined ? String(req.body.display_name) : undefined,
        role: req.body.role ? (req.body.role === 'admin' ? 'admin' : req.body.role === 'reviewer' ? 'reviewer' : undefined) : undefined,
        active: req.body.active !== undefined ? req.body.active === '1' : undefined,
      },
      req.ip,
    );
    flash(res, result.error ? 'error' : 'success', result.error ?? 'User updated.');
    res.redirect('/admin/owner/staff');
  });

  r.post('/staff/:id(\\d+)/permissions', (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const target = findStaffById(db, id);
    if (!target) {
      flash(res, 'error', 'User not found.');
      res.redirect('/admin/owner/staff');
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
      flash(res, 'success', `Permissions updated for @${target.username}.`);
    } catch (e) {
      flash(res, 'error', (e as Error).message);
    }
    res.redirect('/admin/owner/staff');
  });

  return r;
}

function safeBackupName(name: string): string | null {
  if (!/^topcloud-\d{8}-\d{6}\.db$/.test(name)) return null;
  return name;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
