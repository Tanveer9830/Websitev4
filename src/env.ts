import fs from 'node:fs';
import path from 'node:path';

/**
 * Parse a simple KEY=VALUE env file.
 * - Lines starting with '#' and blank lines are ignored.
 * - Surrounding single or double quotes are stripped.
 * - Values are never logged.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

export interface EnvLoadResult {
  /** Ordered list of env files actually found and loaded. */
  loadedFrom: string[];
}

/**
 * Load environment configuration.
 *
 * Precedence (later entries are NOT allowed to override already-set
 * variables, so real environment variables — e.g. injected by systemd's
 * EnvironmentFile — always win):
 *
 *   1. Existing process environment (systemd, shell, CI).
 *   2. If TOP_CLOUD_ENV_FILE is set, ONLY that file is used (explicit
 *      contract — used by tests, scripts and custom deployments).
 *   3. Otherwise: /etc/top-cloud/.env (production, created by install.sh),
 *      then <repo>/.env (local development convenience).
 *
 * This is the SINGLE place where environment files are loaded, so the
 * migration CLI and the application runtime always agree on configuration.
 */
export function loadEnv(repoRoot: string, env = process.env): EnvLoadResult {
  const candidates: string[] = [];
  if (env.TOP_CLOUD_ENV_FILE) {
    candidates.push(path.resolve(env.TOP_CLOUD_ENV_FILE));
  } else {
    // Production location is fixed (created by install.sh, referenced by the
    // systemd unit). Absent on dev machines — harmless.
    candidates.push('/etc/top-cloud/.env');
    candidates.push(path.join(repoRoot, '.env'));
  }

  const loadedFrom: string[] = [];
  const seen = new Set<string>();
  for (const file of candidates) {
    if (seen.has(file)) continue;
    seen.add(file);
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // not present — fine
    }
    for (const [key, value] of Object.entries(parseEnvFile(content))) {
      if (env[key] === undefined || env[key] === '') env[key] = value;
    }
    loadedFrom.push(file);
  }
  return { loadedFrom };
}
