process.env.SOLOCART_DB = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSession,
  createUser,
  deleteSession,
  ensureIdentity,
  findUserById,
  hashPassword,
  mergeDeviceData,
  requestSessionUser,
  sessionUser,
  verifyCredentials,
  verifyPassword,
  SESSION_TTL_MS,
} from '../server/auth.mjs';
import { getDb } from '../server/db.mjs';
import { addEvent, createDraft, listOrders } from '../server/orders.mjs';

const req = (cookie = '') => ({ headers: { cookie } });
const draft = {
  currency: 'USD',
  items: [{ name: 'Mug', quantity: 1, unitPrice: 10 }],
  shipping: 0,
  itemTotal: 10,
  total: 10,
  note: '',
};

test('passwords hash with a unique salt and verify in constant time', async () => {
  const a = await hashPassword('correct horse battery staple');
  const b = await hashPassword('correct horse battery staple');
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.hash, b.hash);
  assert.equal(await verifyPassword('correct horse battery staple', a.salt, a.hash), true);
  assert.equal(await verifyPassword('wrong password entirely', a.salt, a.hash), false);
  assert.equal(await verifyPassword('anything', null, null), false);
  assert.equal(await verifyPassword('anything', a.salt, 'deadbeef'), false);
});

test('registration and sign-in round-trip', async () => {
  const user = await createUser({ name: 'Ada', email: 'Ada@Example.com', password: 'long enough passphrase' });
  assert.equal(user.email, 'ada@example.com');
  assert.equal((await verifyCredentials('ada@example.com', 'long enough passphrase')).id, user.id);
  assert.equal(await verifyCredentials('ada@example.com', 'not the password'), null);
  assert.equal(await verifyCredentials('nobody@example.com', 'long enough passphrase'), null);

  await assert.rejects(
    createUser({ name: 'Ada', email: 'ada@example.com', password: 'long enough passphrase' }),
    (error) => error.status === 409,
  );
});

test('sessions expire after 8 hours and are removed when they do', async () => {
  const user = await createUser({ name: 'Sam', email: 'sam@example.com', password: 'another long passphrase' });
  const token = createSession(user.id);
  assert.equal(sessionUser(token).id, user.id);
  assert.equal(requestSessionUser(req(`sc_session=${token}`)).id, user.id);

  // Age the session past its TTL, as the clock would.
  getDb().prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?').run(Date.now() - 1, user.id);
  assert.equal(sessionUser(token), null);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(user.id).n, 0);

  const fresh = createSession(user.id);
  deleteSession(fresh);
  assert.equal(sessionUser(fresh), null);
});

test('session TTL constant is the documented 8 hours', () => {
  assert.equal(SESSION_TTL_MS, 8 * 60 * 60 * 1000);
});

test('the same token cannot be forged by guessing', async () => {
  const user = await createUser({ name: 'Eve', email: 'eve@example.com', password: 'yet another passphrase' });
  createSession(user.id);
  assert.equal(sessionUser('not-a-real-token'), null);
  assert.equal(sessionUser(''), null);
  assert.equal(findUserById(user.id).email, 'eve@example.com');
});

test('a browser without a session gets a transparent device user, stable per cookie', async () => {
  const first = ensureIdentity(req(''));
  assert.equal(first.isNewDevice, true);
  assert.equal(first.user.kind, 'device');

  const again = ensureIdentity(req(`sc_device=${first.user.id}`));
  assert.equal(again.isNewDevice, false);
  assert.equal(again.user.id, first.user.id);

  // A signed-in session wins over the device cookie.
  const local = await createUser({ name: 'Lee', email: 'lee@example.com', password: 'a very long passphrase' });
  const token = createSession(local.id);
  const signedIn = ensureIdentity(req(`sc_session=${token}; sc_device=${first.user.id}`));
  assert.equal(signedIn.user.id, local.id);
  assert.equal(signedIn.isNewDevice, false);
});

test('registering merges the device desk into the real account', async () => {
  const guest = ensureIdentity(req('')).user;
  createDraft(guest.id, draft, 'local');
  addEvent(guest.id, { title: 'Preview opened', amount: 10 });

  const account = await createUser({ name: 'Mia', email: 'mia@example.com', password: 'merging passphrase!' });
  const moved = mergeDeviceData(req(`sc_device=${guest.id}`), account.id);

  assert.ok(moved >= 2, 'orders and events should move');
  assert.equal(findUserById(guest.id), null);
  assert.equal(listOrders(account.id).length, 1);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM events WHERE user_id = ?').get(account.id).n, 1);
});


