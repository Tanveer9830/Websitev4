import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Express } from 'express';
import { loadConfig, type AppConfig } from '../src/config.ts';
import { applyMigrations } from '../src/migrate.ts';
import { buildApp } from '../src/app.ts';
import { closeDb, getDb } from '../src/db.ts';
import { hashPassword } from '../src/security/password.ts';

export interface TestServer {
  app: Express;
  server: Server;
  base: string;
  cfg: AppConfig;
  close: () => Promise<void>;
}

export const TEST_PASSWORD = 'Passw0rd-For-Tests!';

/** Start the real app against a throwaway SQLite database. */
export async function startTestServer(): Promise<TestServer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topcloud-test-'));
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(
    envFile,
    [
      'NODE_ENV=development',
      'HOST=127.0.0.1',
      // Port is irrelevant: the test server binds to an ephemeral port via app.listen(0).
      'PORT=9999',
      `DATABASE_URL=file:${path.join(dir, 'test.db')}`,
      'SESSION_SECRET=test-secret-that-is-definitely-long-enough-32+',
      'OWNER_USERNAME=testowner',
      `BACKUP_DIR=${path.join(dir, 'backups')}`,
      'SECURE_COOKIES=false',
    ].join('\n'),
  );
  process.env.TOP_CLOUD_ENV_FILE = envFile;
  const cfg = loadConfig();
  applyMigrations();
  const { app } = buildApp(cfg);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    app,
    server,
    base: `http://127.0.0.1:${port}`,
    cfg,
    close: () =>
      new Promise<void>((resolve) => {
        // undici (global fetch) keeps sockets alive; force-close them so
        // server.close() cannot hang the test process.
        server.close(() => {
          closeDb();
          try {
            fs.rmSync(dir, { recursive: true, force: true });
          } catch {
            /* best effort */
          }
          resolve();
        });
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      }),
  };
}

/** Minimal cookie-jar fetch client. */
export class Client {
  private cookies = new Map<string, string>();

  constructor(private base: string) {}

  async get(path: string, opts: { follow?: boolean } = {}): Promise<{ status: number; headers: Headers; body: string }> {
    return this.request('GET', path, undefined, opts);
  }

  async post(
    path: string,
    data: Record<string, string>,
    opts: { follow?: boolean } = {},
  ): Promise<{ status: number; headers: Headers; body: string }> {
    const body = new URLSearchParams(data).toString();
    return this.request('POST', path, body, opts, 'application/x-www-form-urlencoded');
  }

  private async request(
    method: string,
    path: string,
    body?: string,
    opts: { follow?: boolean } = {},
    contentType?: string,
  ): Promise<{ status: number; headers: Headers; body: string }> {
    const headers: Record<string, string> = { accept: 'text/html' };
    if (body !== undefined) headers['content-type'] = contentType ?? 'application/x-www-form-urlencoded';
    const cookie = [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;
    const res = await fetch(this.base + path, { method, headers, body, redirect: 'manual' });
    const setCookies = res.headers.getSetCookie?.() ?? [];
    for (const c of setCookies) {
      const [pair] = c.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '' || /expires=Thu, 01 Jan 1970/i.test(c)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text };
  }

  /** Current cookie header value (for raw fetch calls). */
  cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  /** Get a fresh anonymous session + its CSRF token by loading a page. */
  async csrf(): Promise<{ token: string; cookie: string }> {
    // /login for guests; /account for logged-in clients (login redirects them).
    for (const p of ['/login', '/account', '/']) {
      const res = await this.get(p);
      const m = res.body.match(/name="_csrf" value="([^"]+)"/);
      if (m) return { token: m[1], cookie: [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ') };
    }
    throw new Error('no csrf token found on any page');
  }
}

export function makeClient(t: TestServer): Client {
  return new Client(t.base);
}

/** Insert users directly (known passwords) for role/permission tests. */
export function seedUser(
  t: TestServer,
  input: { username: string; role: 'owner' | 'admin' | 'reviewer' | 'applicant'; is_super?: 0 | 1 },
  password = TEST_PASSWORD,
): number {
  const db = getDb(t.cfg);
  const info = db
    .prepare('INSERT INTO users (username, email, password_hash, display_name, role, is_super, active) VALUES (?,?,?,?,?,?,1)')
    .run(input.username, `${input.username}@test.local`, hashPassword(password), input.username, input.role, input.is_super ?? 0);
  return Number(info.lastInsertRowid);
}

/** Create a position with a fixed 4-field form (2 required text/textarea, required select, checkbox). */
export function seedPosition(t: TestServer, title = 'Test Position', open = 1): number {
  const db = getDb(t.cfg);
  const info = db
    .prepare('INSERT INTO positions (title, department, summary, description, eligibility, open) VALUES (?,?,?,?,?,?)')
    .run(title, 'Test', 'summary', 'description', '- req', open);
  const id = Number(info.lastInsertRowid);
  db.prepare('INSERT INTO application_forms (position_id, instructions, fields_json) VALUES (?, ?, ?)').run(
    id,
    'test',
    JSON.stringify([
      { key: 'full_name', label: 'Full name', type: 'text', required: true, order: 0 },
      { key: 'why', label: 'Why?', type: 'textarea', required: true, order: 1 },
      { key: 'color', label: 'Favorite color', type: 'select', options: ['red', 'blue'], required: true, order: 2 },
      { key: 'wknd', label: 'Weekends ok?', type: 'checkbox', order: 3 },
    ]),
  );
  return id;
}

/** Log in a client with username/password; returns the final status. */
export async function login(t: TestServer, client: Client, username: string, password = TEST_PASSWORD) {
  const { token } = await client.csrf();
  return client.post('/login', { _csrf: token, username, password });
}
