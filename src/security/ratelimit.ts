import type { DatabaseSync } from 'node:sqlite';
import type { NextFunction, Request, Response } from 'express';
import { log } from '../logger.ts';
import { oneRow } from '../db.ts';

/**
 * DB-backed sliding-window rate limiter (survives restarts, shared across
 * worker processes). Uses the `login_attempts` table for auth endpoints and
 * an in-memory window for general traffic.
 */

interface SlidingWindowOptions {
  windowMs: number;
  max: number;
}

const memoryWindows = new Map<string, number[]>();
const MEMORY_WINDOW_MAX_KEYS = 20000;

function pruneMemory(): void {
  if (memoryWindows.size < MEMORY_WINDOW_MAX_KEYS) return;
  const now = Date.now();
  for (const [key, hits] of memoryWindows) {
    if (hits.length === 0 || now - hits[hits.length - 1] > 10 * 60 * 1000) memoryWindows.delete(key);
  }
}

export function memoryRateLimit(opts: SlidingWindowOptions) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `ip:${req.ip}`;
    const now = Date.now();
    let hits = memoryWindows.get(key) ?? [];
    hits = hits.filter((t) => now - t < opts.windowMs);
    if (hits.length >= opts.max) {
      res.set('Retry-After', String(Math.ceil(opts.windowMs / 1000)));
      res.status(429).render('errors/429', {} as never);
      return;
    }
    hits.push(now);
    memoryWindows.set(key, hits);
    if (memoryWindows.size % 500 === 0) pruneMemory();
    next();
  };
}

export function dbRateLimit(db: DatabaseSync, opts: SlidingWindowOptions & { key: (req: Request) => string; onBlock?: (req: Request, res: Response) => void }) {
  db.exec(`CREATE TABLE IF NOT EXISTS login_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL,
    at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );`);
  return (req: Request, res: Response, next: NextFunction) => {
    const key = opts.key(req);
    const since = new Date(Date.now() - opts.windowMs).toISOString();
    const row = oneRow<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM login_attempts WHERE key = ? AND at >= ?', key, since)!;
    if (row.c >= opts.max) {
      log('warn', 'rate limit blocked', { key: 'auth', kind: opts.key(req).split(':')[0], attempts: row.c });
      if (opts.onBlock) {
        opts.onBlock(req, res);
        return;
      }
      res.status(429).send('Too many attempts. Try again later.');
      return;
    }
    db.prepare('INSERT INTO login_attempts (key, at) VALUES (?, ?)').run(key, new Date().toISOString());
    // Opportunistic cleanup of old rows (cheap, bounded).
    if (Math.random() < 0.05) {
      db.prepare('DELETE FROM login_attempts WHERE at < ?').run(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    }
    next();
  };
}
