import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../src/db.ts';
import { startTestServer, makeClient, login, seedUser, seedPosition, type Client, type TestServer } from './helpers.ts';

test('application submission', { concurrency: 1 }, async (t) => {
  const server = await startTestServer();
  let positionId: number;
  try {
    seedUser(server, { username: 'appA', role: 'applicant' });
    seedUser(server, { username: 'appB', role: 'applicant' });
    positionId = seedPosition(server, 'Ops Engineer');
    seedPosition(server, 'Moderator');

    const applyAs = async (client: Client, fields: Record<string, string>) => {
      const { token } = await client.csrf();
      return client.post(`/apply/${positionId}`, { _csrf: token, ...fields });
    };

    await t.test('valid application is accepted with a unique reference number', async () => {
      const c = makeClient(server);
      await login(server, c, 'appA');
      const res = await applyAs(c, { full_name: 'Alice A', why: 'I want the job', color: 'blue', wknd: 'yes' });
      assert.equal(res.status, 200);
      assert.ok(res.body.match(/TC-\d{4}-[0-9A-F]{6}/), 'confirmation page must show the reference number');
      assert.match(res.body, /Application received/);
    });

    await t.test('duplicate active application for the same position is blocked', async () => {
      const c = makeClient(server);
      await login(server, c, 'appA');
      const res = await c.get(`/apply/${positionId}`);
      assert.equal(res.status, 302);
      assert.match(res.headers.get('location') ?? '', /\/account/);
    });

    await t.test('server-side validation rejects missing required fields', async () => {
      const c = makeClient(server);
      await login(server, c, 'appB');
      const res = await applyAs(c, { color: 'red' });
      assert.equal(res.status, 422);
      assert.match(res.body, /This field is required/);
    });

    await t.test('server-side validation rejects an invalid select option', async () => {
      const c = makeClient(server);
      await login(server, c, 'appB');
      const res = await applyAs(c, { full_name: 'Bob B', why: 'reason', color: 'green' });
      assert.equal(res.status, 422);
      assert.match(res.body, /one of the provided options/);
    });

    await t.test('applicant B can submit after fixing errors', async () => {
      const c = makeClient(server);
      await login(server, c, 'appB');
      const res2 = await applyAs(c, { full_name: 'Bob B', why: 'reason', color: 'red' });
      assert.equal(res2.status, 200);
      assert.match(res2.body, /Application received/);
    });

    await t.test('applicant A cannot read applicant B application (IDOR isolation)', async () => {
      const db = getDb(server.cfg);
      const appB = db.prepare(`SELECT id FROM applications WHERE applicant_id = (SELECT id FROM users WHERE username = 'appB') LIMIT 1`).get() as { id: number };
      const c = makeClient(server);
      await login(server, c, 'appA');
      const res = await c.get(`/account/applications/${appB.id}`);
      assert.equal(res.status, 404, "other applicants' applications must be invisible (404, not 403)");
    });

    await t.test('guest cannot access the application flow', async () => {
      const c = makeClient(server);
      const res = await c.get(`/apply/${positionId}`);
      assert.equal(res.status, 302);
      assert.match(res.headers.get('location') ?? '', /\/login/);
    });

    await t.test('application answers are persisted as structured JSON', async () => {
      const db = getDb(server.cfg);
      const row = db.prepare(`SELECT answers_json FROM applications WHERE applicant_id = (SELECT id FROM users WHERE username = 'appA')`).get() as { answers_json: string };
      const parsed = JSON.parse(row.answers_json);
      assert.equal(parsed.full_name, 'Alice A');
      assert.equal(parsed.color, 'blue');
      assert.equal(parsed.wknd, 'yes');
    });
  } finally {
    await server.close();
  }
});

test('status workflow, notes & messages', { concurrency: 1 }, async (t) => {
  const server = await startTestServer();
  let appId: number;
  let reviewerId: number;
  try {
    seedUser(server, { username: 'wf.applicant', role: 'applicant' });
    seedUser(server, { username: 'wf.owner', role: 'owner', is_super: 1 });
    reviewerId = seedUser(server, { username: 'wf.reviewer', role: 'reviewer' });
    const positionId = seedPosition(server, 'Workflow Role');

    const c = makeClient(server);
    await login(server, c, 'wf.applicant');
    const { token } = await c.csrf();
    const res = await c.post(`/apply/${positionId}`, { _csrf: token, full_name: 'W F', why: 'workflow test', color: 'blue' });
    assert.equal(res.status, 200);
    appId = (getDb(server.cfg).prepare(`SELECT id FROM applications WHERE applicant_id = (SELECT id FROM users WHERE username = 'wf.applicant')`).get() as { id: number }).id;

    await t.test('owner can move pending → reviewing (valid transition)', async () => {
      const oc = makeClient(server);
      await login(server, oc, 'wf.owner');
      const { token } = await oc.csrf();
      const r = await oc.post(`/admin/applications/${appId}/status`, { _csrf: token, status: 'reviewing', note: 'first pass' });
      assert.equal(r.status, 302);
      const status = (getDb(server.cfg).prepare('SELECT status FROM applications WHERE id = ?').get(appId) as { status: string }).status;
      assert.equal(status, 'reviewing');
    });

    await t.test('terminal states cannot be changed (approved → rejected rejected)', async () => {
      const oc = makeClient(server);
      await login(server, oc, 'wf.owner');
      let { token } = await oc.csrf();
      await oc.post(`/admin/applications/${appId}/status`, { _csrf: token, status: 'approved', note: 'yes' });
      const { token: token2 } = await oc.csrf();
      await oc.post(`/admin/applications/${appId}/status`, { _csrf: token2, status: 'rejected', note: 'no' });
      const status = (getDb(server.cfg).prepare('SELECT status FROM applications WHERE id = ?').get(appId) as { status: string }).status;
      assert.equal(status, 'approved', 'terminal states must not change');
    });

    await t.test('status history records every change with an actor', async () => {
      const rows = getDb(server.cfg)
        .prepare('SELECT to_status, (changed_by IS NOT NULL) AS has_actor FROM status_history WHERE application_id = ? ORDER BY id')
        .all(appId) as { to_status: string; has_actor: number }[];
      assert.deepEqual(rows.map((r) => r.to_status), ['pending', 'reviewing', 'approved']);
      assert.ok(rows.every((r) => r.has_actor === 1), 'every history entry must have an actor');
    });

    await t.test('internal notes are added and NOT visible to the applicant', async () => {
      const oc = makeClient(server);
      await login(server, oc, 'wf.owner');
      const { token } = await oc.csrf();
      const r = await oc.post(`/admin/applications/${appId}/notes`, { _csrf: token, body: 'SECRET-NOTE-XYZ only staff should see this' });
      assert.equal(r.status, 302);

      const ac = makeClient(server);
      await login(server, ac, 'wf.applicant');
      const detail = await ac.get(`/account/applications/${appId}`);
      assert.equal(detail.status, 200);
      assert.ok(!detail.body.includes('SECRET-NOTE-XYZ'), 'internal notes must never leak to applicants');
    });

    await t.test('applicant-visible messages ARE delivered to the applicant dashboard', async () => {
      const oc = makeClient(server);
      await login(server, oc, 'wf.owner');
      const { token } = await oc.csrf();
      await oc.post(`/admin/applications/${appId}/messages`, { _csrf: token, body: 'PUBLIC-MSG-CONGRATS congratulations on the decision' });

      const ac = makeClient(server);
      await login(server, ac, 'wf.applicant');
      const detail = await ac.get(`/account/applications/${appId}`);
      assert.equal(detail.status, 200);
      assert.match(detail.body, /PUBLIC-MSG-CONGRATS/);
    });

    await t.test('reviewer can be assigned and the assignment persists', async () => {
      const oc = makeClient(server);
      await login(server, oc, 'wf.owner');
      const { token } = await oc.csrf();
      const r = await oc.post(`/admin/applications/${appId}/assign`, { _csrf: token, reviewer: String(reviewerId) });
      assert.equal(r.status, 302);
      const reviewer = (getDb(server.cfg).prepare('SELECT reviewer_id FROM applications WHERE id = ?').get(appId) as { reviewer_id: number | null }).reviewer_id;
      assert.equal(reviewer, reviewerId);
    });

    await t.test('exactly one super owner exists', () => {
      const count = (getDb(server.cfg).prepare('SELECT COUNT(*) AS c FROM users WHERE is_super = 1').get() as { c: number }).c;
      assert.equal(count, 1);
    });
  } finally {
    await server.close();
  }
});
