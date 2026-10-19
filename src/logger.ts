/**
 * Minimal structured JSON logger (stdout).
 *
 * Conventions:
 * - Never log request bodies, passwords, tokens, or environment secrets.
 * - Error stacks go to the log only; users always see safe error pages.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const levelRank: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel: number =
  (process.env.LOG_LEVEL && levelRank[process.env.LOG_LEVEL as LogLevel]) || (process.env.NODE_ENV === 'production' ? levelRank.info : levelRank.debug);

export function log(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
  if (levelRank[level] < minLevel) return;
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
  };
  if (meta) {
    for (const [k, v] of Object.entries(meta)) {
      if (v !== undefined) entry[k] = v;
    }
  }
  const line = JSON.stringify(entry);
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

/** In-memory ring of recent error entries for the owner's system page. */
export interface ErrorEntry {
  ts: string;
  msg: string;
  stack?: string;
}
const recentErrors: ErrorEntry[] = [];
export const ERROR_RING_SIZE = 100;

export function recordError(msg: string, stack?: string): void {
  recentErrors.push({ ts: new Date().toISOString(), msg, stack });
  if (recentErrors.length > ERROR_RING_SIZE) recentErrors.shift();
}

export function getRecentErrors(): ErrorEntry[] {
  return recentErrors.slice(-50).reverse();
}
