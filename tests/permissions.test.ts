import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../src/db.ts';
import { startTestServer, makeClient, login, seedUser, seedPosition } from './helpers.ts';

test('roles & permissions', { concurrency: 1 }, async (t) => {
  const server = await startTestServer();
  let ownerId: number;
  let adminId: number;
  let reviewerId: number;
  let applicantId: number;
  let positionId: number;

  const as = async (user: string) => {
    const c = makeClient(server);
    await login(server, c, user);
    return c;
  };

  try {
    ownerId = seedUser(server, { username: 'perm.owner', role: 'owner', is_super: 1 });
    adminId = seedUser(server, { username: 'perm.admin', role: 'admin' });
    reviewerId = seedUser(server, { username: 'perm.reviewer', role: 'reviewer' });
    applicantId = seedUser(server, { username: 'perm.applicant', role: 'applicant' });
    positionId = seedPosition(server, 'Perm Role');

    await t.test('owner can access BOTH dashboards without re-login', async () => {
      const c = await as('perm.owner');
      const admin = await c.get('/admin');
      assert.equal(admin.status, 200);
      assert.match(admin.body, /Admin dashboard/);
      const owner = await c.get('/admin/owner');
      assert.equal(owner.status, 200);
      assert.match(owner.body, /Owner overview/);
      const again = await c.get('/admin');
      assert.equal(again.status, 200, 'switching back must not require re-login');
    });

    await t.test('admin (role defaults) can review but NOT manage staff/settings/owner', async () => {
      const c = await as('perm.admin');
      assert.equal((await c.get('/admin')).status, 200);
      assert.equal((await c.get('/admin/applications')).status, 200);
      assert.equal((await c.get('/admin/positions')).status, 200);
      assert.equal((await c.get('/admin/forms')).status, 200);
      assert.equal((await c.get('/admin/staff')).status, 403);
      assert.equal((await c.get('/admin/settings')).status, 403);
      assert.equal((await c.get('/admin/owner')).status, 403);
      assert.equal((await c.get('/admin/owner/backups')).status, 403);
    });

    await t.test('owner can grant admin the staff.manage permission — it then works', async () => {
      const owner = await as('perm.owner');
      const { token } = await owner.csrf();
      const res = await owner.post(`/admin/owner/staff/${adminId}/permissions`, {
        _csrf: token,
        'perm_applications.view': '1',
        'perm_applications.review': '1',
        'perm_forms.manage': '1',
        'perm_positions.manage': '1',
        'perm_staff.manage': '1',
      });
      assert.equal(res.status, 302);
      const admin = await as('perm.admin');
      assert.equal((await admin.get('/admin/staff')).status, 200, 'granted permission must take effect');
      assert.equal((await admin.get('/admin/settings')).status, 403, 'non-granted permissions stay denied');
    });

    await t.test('owner can revoke the permission again', async () => {
      const owner = await as('perm.owner');
      const { token } = await owner.csrf();
      await owner.post(`/admin/owner/staff/${adminId}/permissions`, {
        _csrf: token,
        'perm_applications.view': '1',
        'perm_applications.review': '1',
        'perm_forms.manage': '1',
        'perm_positions.manage': '1',
        'perm_staff.manage': '0',
        'perm_settings.manage': '0',
        'perm_audit.view': '0',
        'perm_backups.manage': '0',
        'perm_system.view': '0',
      });
      const admin = await as('perm.admin');
      assert.equal((await admin.get('/admin/staff')).status, 403);
    });

    await t.test('reviewer can review applications but cannot manage positions/forms/staff', async () => {
      const c = await as('perm.reviewer');
      assert.equal((await c.get('/admin')).status, 200);
      assert.equal((await c.get('/admin/applications')).status, 200);
      assert.equal((await c.get('/admin/positions')).status, 403);
      assert.equal((await c.get('/admin/forms')).status, 403);
      assert.equal((await c.get('/admin/staff')).status, 403);
      assert.equal((await c.get('/admin/owner')).status, 403);
    });

    await t.test('reviewer can perform review actions (status change) via the UI', async () => {
      const applicant = makeClient(server);
      await login(server, applicant, 'perm.applicant');
      const { token: t1 } = await applicant.csrf();
      const applied = await applicant.post(`/apply/${positionId}`, {
        _csrf: t1,
        full_name: 'Perm Applicant',
        why: 'to be reviewed',
        color: 'red',
      });
      assert.equal(applied.status, 200);
      const appId = (getDb(server.cfg).prepare(`SELECT id FROM applications WHERE applicant_id = ?`).get(applicantId) as { id: number }).id;

      const reviewer = await as('perm.reviewer');
      const { token } = await reviewer.csrf();
      const res = await reviewer.post(`/admin/applications/${appId}/status`, { _csrf: token, status: 'under_consideration', note: 'thinking' });
      assert.equal(res.status, 302);
      const status = (getDb(server.cfg).prepare('SELECT status FROM applications WHERE id = ?').get(appId) as { status: string }).status;
      assert.equal(status, 'under_consideration');
    });

    await t.test('applicant is fully blocked from /admin and /admin/owner', async () => {
      const c = await as('perm.applicant');
      assert.equal((await c.get('/admin')).status, 403);
      assert.equal((await c.get('/admin/applications')).status, 403);
      assert.equal((await c.get('/admin/owner')).status, 403);
    });

    await t.test('Super Owner cannot be deactivated or demoted through the API', async () => {
      // Grant the admin staff.manage so it can even attempt tampering.
      const owner = await as('perm.owner');
      const { token: ot } = await owner.csrf();
      await owner.post(`/admin/owner/staff/${adminId}/permissions`, {
        _csrf: ot,
        'perm_applications.view': '1',
        'perm_applications.review': '1',
        'perm_forms.manage': '1',
        'perm_positions.manage': '1',
        'perm_staff.manage': '1',
      });
      const freshAdmin = await as('perm.admin');

      const { token: at1 } = await freshAdmin.csrf();
      await freshAdmin.post(`/admin/staff/${ownerId}/update`, { _csrf: at1, active: '0' });
      let ownerRow = getDb(server.cfg).prepare('SELECT active, role, is_super FROM users WHERE id = ?').get(ownerId) as { active: number; role: string; is_super: number };
      assert.equal(ownerRow.active, 1, 'super owner cannot be deactivated');
      assert.equal(ownerRow.is_super, 1, 'super owner cannot be demoted');

      const { token: at2 } = await freshAdmin.csrf();
      await freshAdmin.post(`/admin/staff/${ownerId}/update`, { _csrf: at2, role: 'reviewer' });
      ownerRow = getDb(server.cfg).prepare('SELECT active, role, is_super FROM users WHERE id = ?').get(ownerId) as { active: number; role: string; is_super: number };
      assert.equal(ownerRow.role, 'owner');
      assert.equal(ownerRow.is_super, 1);
    });

    await t.test('deactivated staff cannot sign in', async () => {
      const db = getDb(server.cfg);
      db.prepare('INSERT OR REPLACE INTO user_permissions (user_id, permission, granted) VALUES (?,?,1)').run(adminId, 'staff.manage');
      const victim = seedUser(server, { username: 'perm.victim', role: 'reviewer' });
      const admin = await as('perm.admin');
      const { token } = await admin.csrf();
      await admin.post(`/admin/staff/${victim}/update`, { _csrf: token, active: '0' });
      const c = makeClient(server);
      const res = await login(server, c, 'perm.victim');
      assert.equal(res.status, 401);
      assert.match(res.body, /deactivated/);
    });
  } finally {
    await server.close();
  }
});
