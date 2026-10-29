process.env.SOLOCART_DB = ':memory:';

// Its own file: the "import only when no account exists yet" guard must be
// exercised on a database that genuinely has no accounts.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hashPassword, migrateLegacyUsers, verifyCredentials, findUserById } from '../server/auth.mjs';

test('legacy data/users.json imports once, keeping passwords', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'solocart-legacy-'));
  const file = join(dir, 'users.json');
  const { salt, hash } = await hashPassword('legacy password here');
  writeFileSync(file, JSON.stringify([
    { id: 'legacy-1', name: 'Old Seller', email: 'old@example.com', salt, passwordHash: hash, createdAt: new Date().toISOString() },
    { email: 'broken@example.com' }, // malformed row is skipped, not fatal
  ]));
  try {
    assert.equal(migrateLegacyUsers(file), 1);
    const user = await verifyCredentials('old@example.com', 'legacy password here');
    assert.equal(user.id, 'legacy-1');
    assert.equal(findUserById('legacy-1').kind, 'local');
    // A second boot must not import the file again.
    assert.equal(migrateLegacyUsers(file), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing or unreadable legacy file is not fatal', () => {
  assert.equal(migrateLegacyUsers('/nonexistent/users.json'), 0);
  const dir = mkdtempSync(join(tmpdir(), 'solocart-broken-'));
  const file = join(dir, 'users.json');
  writeFileSync(file, 'not json at all');
  try {
    assert.equal(migrateLegacyUsers(file), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
