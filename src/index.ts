import { loadConfig, ConfigError } from './config.ts';
import { buildApp } from './app.ts';
import { closeDb } from './db.ts';
import { applyMigrations } from './migrate.ts';
import { log } from './logger.ts';

function main(): void {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`FATAL: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }

  // Idempotent, versioned migrations on startup — safe on every boot.
  try {
    const { applied } = applyMigrations();
    if (applied.length) log('info', 'migrations applied', { migrations: applied });
  } catch (e) {
    console.error(`FATAL: database migration failed: ${(e as Error).message}`);
    process.exit(1);
  }

  const { app } = buildApp(cfg);

  const server = app.listen(cfg.port, cfg.host, () => {
    log('info', 'TOP CLOUD server listening', { host: cfg.host, port: cfg.port, env: cfg.env });
    console.log(`\n  TOP CLOUD — Staff Recruitment Portal`);
    console.log(`  →  http://${cfg.host === '0.0.0.0' ? 'localhost' : cfg.host}:${cfg.port}\n`);
  });

  const shutdown = (signal: string) => {
    log('info', 'shutting down', { signal });
    server.close(() => {
      closeDb();
      process.exit(0);
    });
    // Force-exit if connections refuse to drain.
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
