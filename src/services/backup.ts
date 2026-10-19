import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface BackupInfo {
  file: string;
  path: string;
  size: number;
  mtime: string;
}

const MAX_BACKUPS = 10;

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Create a consistent online backup using SQLite's VACUUM INTO, then enforce
 * retention. Returns the created file name.
 */
export function createBackup(db: DatabaseSync, backupDir: string): BackupInfo {
  fs.mkdirSync(backupDir, { recursive: true });
  const file = `topcloud-${timestamp()}.db`;
  const target = path.join(backupDir, file);
  // SQL string literal: single quotes, embedded quotes doubled.
  const literal = `'${target.replace(/'/g, "''")}'`;
  db.exec(`VACUUM INTO ${literal}`);
  enforceRetention(backupDir);
  return statBackup(backupDir, file)!;
}

export function listBackups(backupDir: string): BackupInfo[] {
  if (!fs.existsSync(backupDir)) return [];
  return fs
    .readdirSync(backupDir)
    .filter((f) => /^topcloud-.*\.db$/.test(f))
    .map((f) => statBackup(backupDir, f))
    .filter((b): b is BackupInfo => b !== null)
    .sort((a, b) => b.file.localeCompare(a.file));
}

function statBackup(backupDir: string, file: string): BackupInfo | null {
  try {
    const st = fs.statSync(path.join(backupDir, file));
    return { file, path: path.join(backupDir, file), size: st.size, mtime: st.mtime.toISOString() };
  } catch {
    return null;
  }
}

/** Run integrity_check against a backup file (opens it read-only). */
export function verifyBackup(backupPath: string): { ok: boolean; message: string } {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(backupPath, { readOnly: true });
    const row = db.prepare('PRAGMA integrity_check;').get() as { integrity_check: string };
    const ok = row.integrity_check === 'ok';
    return { ok, message: row.integrity_check };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  } finally {
    db?.close();
  }
}

function enforceRetention(backupDir: string): void {
  const all = listBackups(backupDir);
  const excess = all.slice(MAX_BACKUPS);
  for (const b of excess) {
    try {
      fs.rmSync(b.path);
    } catch {
      /* best effort */
    }
  }
}
