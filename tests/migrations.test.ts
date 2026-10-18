import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeEnvFile(dir: string, withDb: boolean): string {
  const envFile = path.join(dir, '.env');
  const lines = [
    'NODE_ENV=development',
    'PORT=9999',
    withDb ? `DATABASE_URL=file:${path.join(dir, 't.db')}` : '',
    'SESSION_SECRET=test-secret-that-is-definitely-long-enough-32+',
    'SECURE_COOKIES=false',
  ].filter(Boolean);
  fs.writeFileSync(envFile, lines.join('\n'));
  return envFile;
}

function runMigrate(envFile: string, status = false): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(
      process.execPath,
      ['--import', 'tsx', '--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/migrate.ts'), ...(status ? ['--status'] : [])],
      { env: { ...process.env, TOP_CLOUD_ENV_FILE: envFile, DATABASE_URL: '' }, encoding: 'utf8', cwd: ROOT },
    );
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('migrations & environment handling', { concurrency: 1 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topcloud-mig-'));
  try {
    await t.test('migration applies cleanly and records the version', () => {
      const envFile = makeEnvFile(dir, true);
      const first = runMigrate(envFile);
      assert.equal(first.code, 0, first.stderr);
      assert.match(first.stdout, /Applied 0001_init\.sql/);
    });

    await t.test('rerunning migrations is a no-op (safe on every boot)', () => {
      const envFile = path.join(dir, '.env');
      const second = runMigrate(envFile);
      assert.equal(second.code, 0, second.stderr);
      assert.match(second.stdout, /Migrations already up to date/);
    });

    await t.test('--status reports applied and pending', () => {
      const envFile = path.join(dir, '.env');
      const res = runMigrate(envFile, true);
      assert.equal(res.code, 0, res.stderr);
      assert.match(res.stdout, /0001_init\.sql/);
      assert.match(res.stdout, /Pending:\s*\n\s*\(none\)/);
    });

    await t.test('CLI without DATABASE_URL fails fast with an actionable message', () => {
      const noDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topcloud-nodb-'));
      const envFile = makeEnvFile(noDbDir, false);
      const res = runMigrate(envFile);
      assert.ok(res.code !== 0, 'CLI must exit non-zero without DATABASE_URL');
      assert.match(res.stderr, /DATABASE_URL is required/);
      assert.match(res.stderr, /etc\/top-cloud\/\.env|\.env/);
      fs.rmSync(noDbDir, { recursive: true, force: true });
    });

    await t.test('relative/unsupported DATABASE_URL is rejected clearly', () => {
      const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topcloud-baddb-'));
      const envFile = path.join(badDir, '.env');
      fs.writeFileSync(
        envFile,
        ['NODE_ENV=development', 'PORT=9999', 'DATABASE_URL=file:relative/path.db', 'SESSION_SECRET=test-secret-that-is-definitely-long-enough-32+'].join('\n'),
      );
      const res = runMigrate(envFile);
      assert.ok(res.code !== 0);
      assert.match(res.stderr, /absolute file path/);
      fs.rmSync(badDir, { recursive: true, force: true });
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
