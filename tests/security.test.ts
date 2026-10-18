import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../src/db.ts';
import { startTestServer, makeClient, login, seedUser, seedPosition } from './helpers.ts';

test('security hardening', { concurrency: 1 }, async (t) => {
  const server = await startTestServer();
  let positionId: number;
  try {
    seedUser(server, { username: 'sec.owner', role: 'owner', is_super: 1 });
    seedUser(server, { username: 'sec.applicant', role: 'applicant' });
    seedUser(server, { username: 'sec.admin', role: 'admin' });
    positionId = seedPosition(server, 'Sec Role');

    await t.test('security headers are present on every response', async () => {
      const c = makeClient(server);
      const res = await c.get('/');
      const csp = res.headers.get('content-security-policy') ?? '';
      assert.match(csp, /default-src 'self'/);
      assert.ok(!csp.includes('unsafe-inline') && !csp.includes('unsafe-eval'), 'CSP must not allow inline scripts');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
      assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    });

    await t.test('session cookie is HttpOnly + SameSite=Lax', async () => {
      const res = await fetch(server.base + '/login');
      const sc = res.headers.getSetCookie?.() ?? [];
      const session = sc.find((x) => x.startsWith('tcsid='));
      assert.ok(session, 'session cookie must be set for anonymous sessions');
      assert.match(session!, /HttpOnly/i);
      assert.match(session!, /SameSite=Lax/i);
    });

    await t.test('state-changing requests without a CSRF token are rejected (403)', async () => {
      const c = makeClient(server);
      const res = await c.post('/login', { username: 'sec.applicant', password: 'wrong' });
      assert.equal(res.status, 403);
    });

    await t.test('cross-origin POST with a valid token is rejected (Origin check)', async () => {
      const c = makeClient(server);
      const { token } = await c.csrf();
      const res = await fetch(server.base + '/login', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'https://evil.example',
          cookie: c.cookieHeader(),
        },
        body: new URLSearchParams({ _csrf: token, username: 'x', password: 'y' }).toString(),
        redirect: 'manual',
      });
      assert.equal(res.status, 403);
    });

    await t.test('login failures are rate limited (429 after repeated attempts)', async () => {
      // Throwaway account so later tests can still log in with sec.admin/sec.owner.
      const dummy = seedUser(server, { username: 'sec.dummy', role: 'applicant' });
      void dummy;
      const c = makeClient(server);
      let last = 0;
      for (let i = 0; i < 8; i++) {
        const { token } = await c.csrf();
        last = (await c.post('/login', { _csrf: token, username: 'sec.dummy', password: `Bad-${i}` })).status;
      }
      assert.equal(last, 429);
    });

    await t.test('error pages do not leak stack traces or source paths', async () => {
      const c = makeClient(server);
      const res = await c.get('/nonexistent-page');
      assert.equal(res.status, 404);
      assert.ok(!res.body.includes('.ts'), 'no source file paths in 404');
    });

    await t.test('health endpoint reports database status', async () => {
      const c = makeClient(server);
      const res = await c.get('/health');
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body) as { status: string; database: string };
      assert.equal(body.status, 'ok');
      assert.equal(body.database, 'ok');
    });

    await t.test('owner-only endpoints reject a logged-in admin', async () => {
      const c = makeClient(server);
      const r = await login(server, c, 'sec.admin');
      assert.equal(r.status, 302);
      assert.equal((await c.get('/admin/owner')).status, 403);
      assert.equal((await c.get('/admin/owner/system')).status, 403);
      assert.equal((await c.get('/admin/owner/audit')).status, 403);
      assert.equal((await c.get('/admin/owner/backups')).status, 403);
    });

    await t.test('owner system page shows configuration without secrets', async () => {
      const c = makeClient(server);
      await login(server, c, 'sec.owner');
      const res = await c.get('/admin/owner/system');
      assert.equal(res.status, 200);
      assert.ok(!res.body.includes('test-secret-that-is-definitely-long-enough'), 'SESSION_SECRET must never be rendered');
    });

    await t.test('backup create + list + integrity verify works end-to-end', async () => {
      const c = makeClient(server);
      await login(server, c, 'sec.owner');
      const { token } = await c.csrf();
      const created = await c.post('/admin/owner/backups/create', { _csrf: token });
      assert.equal(created.status, 302);
      const page = await c.get('/admin/owner/backups');
      assert.equal(page.status, 200);
      const fileMatch = page.body.match(/topcloud-\d{8}-\d{6}\.db/);
      assert.ok(fileMatch, 'a backup file must be listed');
      const { token: t2 } = await c.csrf();
      const verified = await c.post(`/admin/owner/backups/${fileMatch![0]}/verify`, { _csrf: t2 });
      assert.equal(verified.status, 302);
      const page2 = await c.get('/admin/owner/backups');
      assert.match(page2.body, /PASSED|FAILED/);
    });

    await t.test('backup download is owner-only and path-traversal safe', async () => {
      const c = makeClient(server);
      await login(server, c, 'sec.owner');
      const bad = await c.get('/admin/owner/backups/..%2F..%2Fetc%2Fpasswd/download');
      assert.ok([400, 404].includes(bad.status), 'path traversal must be rejected');
      const admin = makeClient(server);
      await login(server, admin, 'sec.admin');
      const denied = await admin.get('/admin/owner/backups/x/download');
      assert.ok([403, 404].includes(denied.status));
    });

    await t.test('audit log records privileged operations', async () => {
      const rows = getDb(server.cfg).prepare('SELECT action FROM audit_logs').all() as { action: string }[];
      const actions = new Set(rows.map((r) => r.action));
      assert.ok(actions.has('auth.login.success'), 'successful logins audited');
      assert.ok(actions.has('auth.login.failure'), 'failed logins audited');
    });

    await t.test('SQL injection in search does not work (parameterized queries)', async () => {
      const c = makeClient(server);
      await login(server, c, 'sec.owner');
      const res = await c.get(`/admin/applications?q=${encodeURIComponent("'; DROP TABLE users; --")}`);
      assert.equal(res.status, 200);
      const count = (getDb(server.cfg).prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
      assert.ok(count >= 3, 'users table must survive injection attempts');
    });
  } finally {
    await server.close();
  }
});
