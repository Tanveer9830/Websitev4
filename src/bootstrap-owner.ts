import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ConfigError } from './config.ts';
import { getDb, closeDb } from './db.ts';
import { applyMigrations } from './migrate.ts';
import { hashPassword, generateRandomPassword } from './security/password.ts';
import { oneRow } from './db.ts';
import { log } from './logger.ts';

/**
 * Super Owner bootstrap — secure, explicit, idempotent.
 *
 * - Creates exactly ONE super owner account when none exists.
 * - The password is generated from the OS CSPRNG; it is NEVER hardcoded.
 * - The credentials are written to /etc/top-cloud/owner-credentials.txt
 *   (mode 600, root:root) and printed to the console exactly once.
 * - If an owner already exists the command does nothing (rerun-safe).
 *
 * The owner account is protected in code: it cannot be demoted, deactivated
 * or deleted through any API.
 */

const CREDENTIALS_DIR = '/etc/top-cloud';
const CREDENTIALS_FILE = path.join(CREDENTIALS_DIR, 'owner-credentials.txt');

function main(): void {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`ERROR: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }

  const db = getDb(cfg);
  try {
    applyMigrations();
  } catch (e) {
    console.error(`ERROR: migrations failed before bootstrap: ${(e as Error).message}`);
    process.exit(1);
  }

  const existing = oneRow<{ id: number; username: string }>(db, 'SELECT id, username FROM users WHERE is_super = 1');
  if (existing) {
    console.log(`A Super Owner account already exists (@${existing.username}). Bootstrap is a no-op.`);
    return;
  }

  const username = (cfg.ownerUsername || 'owner').trim().toLowerCase() || 'owner';
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    console.error('ERROR: OWNER_USERNAME must be 3-32 characters: letters, numbers, dot, dash, underscore.');
    process.exit(2);
  }
  const clashing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, `${username}@top-cloud.local`);
  if (clashing) {
    console.error(`ERROR: a user with that username or email already exists. Choose a different OWNER_USERNAME.`);
    process.exit(1);
  }

  const password = generateRandomPassword(24);
  const info = db
    .prepare(
      "INSERT INTO users (username, email, password_hash, display_name, role, is_super, active, must_change_pw) VALUES (?,?,?,'Super Owner','owner',1,1,1)",
    )
    .run(username, `${username}@top-cloud.local`, hashPassword(password));
  db.prepare(
    'INSERT INTO audit_logs (at, user_id, user_label, action, target, detail, ip) VALUES (?,?,?,?,?,?,NULL)',
  ).run(
    new Date().toISOString(),
    Number(info.lastInsertRowid),
    `@${username}`,
    'owner.bootstrap',
    `user#${info.lastInsertRowid}`,
    JSON.stringify({ method: 'bootstrap-cli' }),
  );

  let savedTo: string | null = null;
  try {
    fs.mkdirSync(CREDENTIALS_DIR, { recursive: true });
    fs.writeFileSync(
      CREDENTIALS_FILE,
      [
        'TOP CLOUD — Super Owner credentials (created by bootstrap)',
        `Username: ${username}`,
        `Password: ${password}`,
        '',
        'Delete this file after the first login. Keep it secret.',
      ].join('\n'),
      { mode: 0o600 },
    );
    try {
      fs.chownSync(CREDENTIALS_FILE, 0, 0);
    } catch {
      /* non-root environments */
    }
    savedTo = CREDENTIALS_FILE;
  } catch {
    savedTo = null;
  }

  console.log('');
  console.log('==============================================');
  console.log('  SUPER OWNER ACCOUNT CREATED');
  console.log('==============================================');
  console.log(`  Username: ${username}`);
  console.log(`  Password: ${password}`);
  console.log('');
  if (savedTo) {
    console.log(`  Also saved to: ${savedTo} (mode 600)`);
  } else {
    console.log('  NOTE: could not write the credentials file;');
    console.log('  record the password above in your password manager NOW.');
  }
  console.log('  The owner is asked to change the password after first login.');
  console.log('  Delete this credentials file after you have.');
  console.log('==============================================');
  log('info', 'owner bootstrap completed', { username });
}

main();
closeDb();
