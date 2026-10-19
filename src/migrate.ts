import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, loadConfig, ConfigError } from './config.ts';
import { allRows, getDb, closeDb } from './db.ts';

/**
 * Versioned, idempotent SQL migration runner.
 *
 * Usage:
 *   npm run migrate            # apply all pending migrations
 *   npm run migrate:status     # show applied/pending without changing anything
 *
 * The runner tracks applied versions in a `schema_migrations` table and only
 * applies files that have not run yet, so it is safe to execute on every
 * startup and after every deploy. Migrations run in file-name order inside a
 * single transaction.
 *
 * Configuration is loaded with the exact same code path as the application
 * runtime (see src/config.ts), so migrations can never target a different
 * database than the app.
 */

interface MigrationFile {
  version: string;
  name: string;
  sql: string;
}

export function listMigrationFiles(dir: string = path.join(REPO_ROOT, 'migrations')): MigrationFile[] {
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
  return files.map((f) => ({
    version: f.slice(0, 4),
    name: f,
    sql: fs.readFileSync(path.join(dir, f), 'utf8'),
  }));
}

export function applyMigrations(): { applied: string[] } {
  const cfg = loadConfig();
  const db = getDb(cfg);
  const files = listMigrationFiles();

  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );`);

  const appliedRows = allRows<{ version: string }>(db, 'SELECT version FROM schema_migrations');
  const appliedSet = new Set(appliedRows.map((r) => r.version));

  const toApply = files.filter((f) => !appliedSet.has(f.version));
  const applied: string[] = [];
  if (toApply.length === 0) return { applied };

  const insert = db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)');
  db.exec('BEGIN');
  try {
    for (const m of toApply) {
      db.exec(m.sql);
      insert.run(m.version, m.name);
      applied.push(m.name);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw new Error(`Migration ${toApply[0].name} failed: ${(e as Error).message}`);
  }
  return { applied };
}

export function migrationStatus(): { applied: string[]; pending: string[] } {
  const cfg = loadConfig();
  const db = getDb(cfg);
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );`);
  const rows = allRows<{ name: string }>(db, 'SELECT name FROM schema_migrations');
  const appliedSet = new Set(rows.map((r) => r.name));
  const files = listMigrationFiles();
  return {
    applied: files.filter((f) => appliedSet.has(f.name)).map((f) => f.name),
    pending: files.filter((f) => !appliedSet.has(f.name)).map((f) => f.name),
  };
}

function main(): void {
  const statusOnly = process.argv.includes('--status');
  try {
    // Fail fast with an actionable message when the database is not configured.
    loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`ERROR: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }
  try {
    if (statusOnly) {
      const { applied, pending } = migrationStatus();
      console.log('Applied:');
      for (const a of applied) console.log(`  ✓ ${a}`);
      console.log('Pending:');
      if (pending.length === 0) console.log('  (none)');
      for (const p of pending) console.log(`  · ${p}`);
    } else {
      const { applied } = applyMigrations();
      if (applied.length === 0) {
        console.log('Migrations already up to date.');
      } else {
        for (const a of applied) console.log(`Applied ${a}`);
      }
    }
  } catch (e) {
    console.error(`ERROR: ${(e as Error).message}`);
    process.exit(1);
  } finally {
    closeDb();
  }
}

// Run as CLI only when executed directly (not when imported by app/tests).
const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) main();
