import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AppConfig } from './config.ts';
import { ConfigError } from './config.ts';

let db: DatabaseSync | null = null;

/**
 * Open (and cache) the application database.
 *
 * Uses Node's built-in SQLite engine (node:sqlite) — a real SQLite engine
 * with zero native compilation, so deployments never depend on build
 * toolchains. WAL mode gives safe concurrent reads and crash resistance.
 */
export function getDb(cfg: AppConfig): DatabaseSync {
  if (db) return db;
  try {
    fs.mkdirSync(path.dirname(cfg.databasePath), { recursive: true });
    db = new DatabaseSync(cfg.databasePath);
  } catch (e) {
    throw new ConfigError(
      `Failed to open database at ${cfg.databasePath}: ${(e as Error).message}. ` +
        'Check that the directory exists and is writable by the service user.',
    );
  }
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/** Test helper: replace the cached connection. */
export function setDbForTests(newDb: DatabaseSync | null): void {
  db = newDb;
}

export function nowSql(): string {
  return new Date().toISOString();
}

/** Type-safe row helpers (node:sqlite returns generic row objects). */
export function allRows<T>(db: DatabaseSync, sql: string, ...params: (string | number | null)[]): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

export function oneRow<T>(db: DatabaseSync, sql: string, ...params: (string | number | null)[]): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined;
}
