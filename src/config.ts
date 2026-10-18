import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.ts';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface AppConfig {
  env: string; // development | production
  host: string;
  port: number;
  databasePath: string;
  databaseUrl: string;
  sessionSecret: string;
  ownerUsername: string;
  backupDir: string;
  secureCookies: 'auto' | 'true' | 'false';
  trustProxy: boolean;
  loadedFrom: string[];
}

export class ConfigError extends Error {}

/**
 * Resolve the SQLite path from DATABASE_URL.
 * Only file-backed databases are supported by this deployment.
 */
export function parseDatabaseUrl(url: string): string {
  let p = url.trim();
  if (p.startsWith('file:')) p = p.slice('file:'.length);
  // Drop query/fragment and any leading `?mode=...` sqlite option.
  const q = p.search(/[?#]/);
  if (q >= 0) p = p.slice(0, q);
  if (!p) throw new ConfigError('DATABASE_URL has no database path.');
  if (!p.startsWith('/')) {
    throw new ConfigError(
      `DATABASE_URL must be an absolute file path (got a relative path). Use e.g. file:/var/lib/top-cloud/topcloud.db`,
    );
  }
  return p;
}

export function loadConfig(): AppConfig {
  const env = process.env;
  const { loadedFrom } = loadEnv(REPO_ROOT, env);

  const nodeEnv = env.NODE_ENV === 'production' ? 'production' : 'development';
  const portRaw = env.PORT ? Number(env.PORT) : 8080;
  if (!Number.isInteger(portRaw) || portRaw < 1 || portRaw > 65535) {
    throw new ConfigError(`PORT must be an integer between 1 and 65535 (got: ${env.PORT})`);
  }

  const databaseUrl = env.DATABASE_URL || '';
  let databasePath = '';
  if (!databaseUrl) {
    throw new ConfigError(
      'DATABASE_URL is required to run the application. Set it in your environment file ' +
        '(e.g. /etc/top-cloud/.env for production, ./.env for development) using a form like ' +
        'DATABASE_URL=file:/var/lib/top-cloud/topcloud.db',
    );
  }
  try {
    databasePath = parseDatabaseUrl(databaseUrl);
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    throw new ConfigError(`Invalid DATABASE_URL: ${(e as Error).message}`);
  }

  const sessionSecret = env.SESSION_SECRET || '';
  if (sessionSecret.length < 32) {
    throw new ConfigError(
      'SESSION_SECRET must be at least 32 random characters. Generate one with: openssl rand -base64 48. ' +
        '(The installer does this automatically on a fresh VPS.)',
    );
  }

  const secureRaw = (env.SECURE_COOKIES || 'auto').toLowerCase();
  if (!['auto', 'true', 'false'].includes(secureRaw)) {
    throw new ConfigError('SECURE_COOKIES must be one of: auto, true, false');
  }

  return {
    env: nodeEnv,
    host: env.HOST || '0.0.0.0',
    port: portRaw,
    databasePath,
    databaseUrl,
    sessionSecret,
    ownerUsername: env.OWNER_USERNAME || 'owner',
    backupDir: env.BACKUP_DIR || '/var/lib/top-cloud/backups',
    secureCookies: secureRaw as AppConfig['secureCookies'],
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    loadedFrom,
  };
}

/** Configuration that is safe to display (never includes secrets). */
export function configSummary(cfg: AppConfig): Record<string, string> {
  return {
    environment: cfg.env,
    listen: `${cfg.host}:${cfg.port}`,
    database: cfg.databasePath,
    backup_dir: cfg.backupDir,
    owner_username: cfg.ownerUsername,
    secure_cookies: cfg.secureCookies,
    env_files: cfg.loadedFrom.join(', ') || '(none — using process environment only)',
  };
}
