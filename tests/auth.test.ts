import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, makeClient, login } from './helpers.ts';

test('authentication', { concurrency: 1 }, async (t) => {
  const server = await startTestServer();
  try {
    await t.test('registration validates input (weak password rejected)', async () => {
      const c = makeClient(server);
      const { token } = await c.csrf();
      const res = await c.post('/register', {
        _csrf: token,
        username: 'newbie',
        email: 'newbie@test.local',
        display_name: 'Newbie',
        password: 'short',
        password2: 'short',
      });
      assert.equal(res.status, 422);
      assert.match(res.body, /at least 10 characters/);
    });

    await t.test('registration rejects duplicate usernames', async () => {
      const c1 = makeClient(server);
      const t1 = await c1.csrf();
      await c1.post('/register', {
        _csrf: t1.token,
        username: 'taken.user',
        email: 'taken@test.local',
        display_name: 'Taken',
        password: 'Passw0rd-For-Tests!',
        password2: 'Passw0rd-For-Tests!',
      });
      const c2 = makeClient(server);
      const t2 = await c2.csrf();
      const res = await c2.post('/register', {
        _csrf: t2.token,
        username: 'taken.user',
        email: 'other@test.local',
        display_name: 'Other',
        password: 'Passw0rd-For-Tests!',
        password2: 'Passw0rd-For-Tests!',
      });
      assert.equal(res.status, 422);
      assert.match(res.body, /already taken/);
    });

    await t.test('successful registration logs the user in (redirect to /positions)', async () => {
      const c = makeClient(server);
      const { token } = await c.csrf();
      const res = await c.post('/register', {
        _csrf: token,
        username: 'fresh.user',
        email: 'fresh@test.local',
        display_name: 'Fresh User',
        password: 'Passw0rd-For-Tests!',
        password2: 'Passw0rd-For-Tests!',
      });
      assert.equal(res.status, 302);
      assert.match(res.headers.get('location') ?? '', /\/positions/);
      const dash = await c.get('/account');
      assert.equal(dash.status, 200);
    });

    await t.test('login with wrong password fails and does not leak account existence', async () => {
      const c = makeClient(server);
      const { token } = await c.csrf();
      const res = await c.post('/login', {
        _csrf: token,
        username: 'fresh.user',
        password: 'Wrong-Password-1',
      });
      assert.equal(res.status, 401);
      assert.match(res.body, /Invalid credentials/);
      const dash = await c.get('/account');
      assert.equal(dash.status, 302);
    });

    await t.test('login with correct credentials works (username and email)', async () => {
      const byName = makeClient(server);
      const r1 = await login(server, byName, 'fresh.user');
      assert.equal(r1.status, 302);
      assert.match(r1.headers.get('location') ?? '', /\/account|\/positions/);

      const byEmail = makeClient(server);
      const t = await byEmail.csrf();
      const r2 = await byEmail.post('/login', {
        _csrf: t.token,
        username: 'fresh@test.local',
        password: 'Passw0rd-For-Tests!',
      });
      assert.equal(r2.status, 302);
    });

    await t.test('logout destroys the session', async () => {
      const c = makeClient(server);
      const { token: t2 } = await c.csrf();
      const out = await c.post('/login', { _csrf: t2, username: 'fresh.user', password: 'Passw0rd-For-Tests!' });
      assert.equal(out.status, 302);
      const { token: t3 } = await c.csrf();
      const logout = await c.post('/logout', { _csrf: t3 });
      assert.equal(logout.status, 302);
      const dash = await c.get('/account');
      assert.equal(dash.status, 302);
      assert.match(dash.headers.get('location') ?? '', /\/login/);
    });

    await t.test('brute force is rate limited (repeated failures → 429)', async () => {
      const c = makeClient(server);
      let last = 0;
      for (let i = 0; i < 8; i++) {
        const { token } = await c.csrf();
        last = (await c.post('/login', { _csrf: token, username: 'fresh.user', password: `Nope-Password-${i}` })).status;
      }
      assert.equal(last, 429);
    });

    await t.test('password change requires the current password and updates auth', async () => {
      const reg = makeClient(server);
      const { token } = await reg.csrf();
      const regRes = await reg.post('/register', {
        _csrf: token,
        username: 'pwchange.user' ,
        email: 'pwchange@test.local',
        display_name: 'PW Change',
        password: 'Passw0rd-For-Tests!',
        password2: 'Passw0rd-For-Tests!',
      });
      assert.equal(regRes.status, 302, 'registration must succeed (rate limit not reached)');
      const c = makeClient(server);
      await login(server, c, 'pwchange.user');
      const t1 = await c.csrf();
      const bad = await c.post('/account/password', {
        _csrf: t1.token,
        current: 'Wrong-Current-1',
        next: 'NewPassw0rd-123',
        next2: 'NewPassw0rd-123',
      });
      assert.equal(bad.status, 422);
      assert.match(bad.body, /current password is incorrect/);

      const t2 = await c.csrf();
      const ok = await c.post('/account/password', {
        _csrf: t2.token,
        current: 'Passw0rd-For-Tests!',
        next: 'NewPassw0rd-123',
        next2: 'NewPassw0rd-123',
      });
      assert.equal(ok.status, 302);

      const c2 = makeClient(server);
      const oldPass = await login(server, c2, 'pwchange.user', 'Passw0rd-For-Tests!');
      assert.equal(oldPass.status, 401, 'old password must stop working');
      const newPass = await login(server, c2, 'pwchange.user', 'NewPassw0rd-123');
      assert.equal(newPass.status, 302, 'new password must work');
    });
  } finally {
    await server.close();
  }
});
