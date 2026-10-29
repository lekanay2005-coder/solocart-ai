/**
 * Accounts and sessions, now backed by SQLite.
 *
 * - Passwords: scrypt with a per-user random salt (same format as the old
 *   `data/users.json`, which is migrated on first boot).
 * - Sessions: 32 random bytes, only the SHA-256 hash is stored, 8h expiry.
 * - Identity: when no one is signed in, a transparent per-browser "device"
 *   user owns the desk's rows so orders and activity still live server-side
 *   per user. Registering or signing in merges that device data into the
 *   real account, so nobody loses their desk by not signing in first.
 */
import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { getDb, rootDir } from './db.mjs';
import { getCookie } from './http.mjs';

const scrypt = promisify(scryptCallback);

export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;

export const hashToken = (token) => createHash('sha256').update(token).digest('hex');
export const publicUser = (user) => ({ id: user.id, name: user.name, email: user.email });
export const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * scrypt hash of `password`. Returns the hex digest; `salt` is hex and can be
 * supplied (login) or generated (registration).
 */
export async function hashPassword(password, salt) {
  const usedSalt = salt || randomBytes(16).toString('hex');
  const digest = (await scrypt(String(password).slice(0, PASSWORD_MAX), usedSalt, 64)).toString('hex');
  return { salt: usedSalt, hash: digest };
}

/** Constant-time password check that never throws on malformed stored data. */
export async function verifyPassword(password, salt, expectedHash) {
  if (!salt || !expectedHash) return false;
  const { hash } = await hashPassword(password, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(String(expectedHash), 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** A derivation for unknown accounts, so login timing does not reveal who exists. */
export async function decoyHash(password) {
  return hashPassword(password, '0'.repeat(32));
}

/**
 * Creates a local account.
 * @returns {Promise<{id: string, name: string, email: string}>}
 */
export async function createUser({ name, email, password }) {
  const db = getDb();
  const cleanEmail = normalizeEmail(email);
  const { salt, hash } = await hashPassword(password);
  const user = {
    id: randomUUID(),
    kind: 'local',
    name,
    email: cleanEmail,
    salt,
    password_hash: hash,
    created_at: Date.now(),
  };
  try {
    db.prepare(
      'INSERT INTO users (id, kind, name, email, salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(user.id, user.kind, user.name, user.email, user.salt, user.password_hash, user.created_at);
  } catch (error) {
    if (/UNIQUE constraint failed: users.email/.test(String(error.message))) {
      const conflict = new Error('An account with that email already exists. Try signing in.');
      conflict.status = 409;
      conflict.code = 'email_taken';
      conflict.expose = true;
      throw conflict;
    }
    throw error;
  }
  return user;
}

export function findUserByEmail(email) {
  return getDb().prepare("SELECT * FROM users WHERE email = ? AND kind = 'local'").get(normalizeEmail(email)) || null;
}

export function findUserById(id) {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(String(id || '')) || null;
}

/** Email + password, or null. */
export async function verifyCredentials(email, password) {
  const user = findUserByEmail(email);
  if (!user) {
    await decoyHash(password);
    return null;
  }
  const ok = await verifyPassword(password, user.salt, user.password_hash);
  return ok ? user : null;
}

// --- sessions -------------------------------------------------------------------

/** Issues a session; the raw token is returned once and only its hash is stored. */
export function createSession(userId) {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  getDb()
    .prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(hashToken(token), userId, now, now + SESSION_TTL_MS);
  return token;
}

export function deleteSession(token) {
  if (!token) return;
  getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

/** The signed-in user for a raw session token, or null when absent/expired. */
export function sessionUser(token) {
  if (!token) return null;
  const db = getDb();
  const row = db
    .prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?')
    .get(hashToken(token));
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    return null;
  }
  return findUserById(row.user_id);
}

/** Session user for a request (reads the `sc_session` cookie), or null. */
export function requestSessionUser(request) {
  return sessionUser(getCookie(request, 'sc_session'));
}

/** Clears expired sessions; called on boot. */
export function purgeExpiredSessions() {
  return getDb().prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()).changes;
}

// --- device identity ------------------------------------------------------------

/**
 * Who owns rows for this request: the signed-in account, or a transparent
 * device user (created and cookie'd on first use).
 * @returns {{ user: any, isNewDevice: boolean }}
 */
export function ensureIdentity(request) {
  const sessionUserRow = requestSessionUser(request);
  if (sessionUserRow) return { user: sessionUserRow, isNewDevice: false };
  const deviceId = getCookie(request, 'sc_device');
  const existing = deviceId ? findUserById(deviceId) : null;
  if (existing && existing.kind === 'device') return { user: existing, isNewDevice: false };
  const user = {
    id: randomUUID(),
    kind: 'device',
    name: 'Guest seller',
    email: `device_${randomUUID()}@local.invalid`,
    salt: null,
    password_hash: null,
    created_at: Date.now(),
  };
  getDb()
    .prepare('INSERT INTO users (id, kind, name, email, salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(user.id, user.kind, user.name, user.email, null, null, user.created_at);
  return { user, isNewDevice: true };
}

/**
 * Moves everything a browser accumulated under its device user onto the real
 * account being registered or signed in to, then removes the device user.
 * Idempotent: without a device cookie there is nothing to merge.
 */
export function mergeDeviceData(request, targetUserId) {
  const db = getDb();
  const deviceId = getCookie(request, 'sc_device');
  if (!deviceId || deviceId === targetUserId) return 0;
  const deviceUser = findUserById(deviceId);
  if (!deviceUser || deviceUser.kind !== 'device') return 0;
  let moved = 0;
  for (const table of ['orders', 'events', 'settings']) {
    moved += db
      .prepare(`UPDATE ${table} SET user_id = ? WHERE user_id = ?`)
      .run(targetUserId, deviceId).changes;
  }
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(deviceId);
  db.prepare('DELETE FROM users WHERE id = ?').run(deviceId);
  return moved;
}

// --- legacy migration ------------------------------------------------------------

/**
 * Imports the pre-SQLite `data/users.json` exactly once, so existing local
 * accounts keep their password on upgrade. Returns how many were imported.
 */
export function migrateLegacyUsers(file = join(rootDir, 'data', 'users.json')) {
  const db = getDb();
  const already = db.prepare("SELECT COUNT(*) AS n FROM users WHERE kind = 'local'").get().n;
  if (already > 0) return 0;
  const legacyFile = file;
  if (!existsSync(legacyFile)) return 0;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(legacyFile, 'utf8'));
  } catch {
    return 0;
  }
  if (!Array.isArray(parsed)) return 0;
  let imported = 0;
  const insert = db.prepare(
    'INSERT INTO users (id, kind, name, email, salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const legacy of parsed) {
    if (!legacy || typeof legacy.email !== 'string' || !legacy.passwordHash) continue;
    try {
      insert.run(
        typeof legacy.id === 'string' ? legacy.id : randomUUID(),
        'local',
        String(legacy.name || 'Seller').slice(0, 60),
        normalizeEmail(legacy.email),
        String(legacy.salt || ''),
        String(legacy.passwordHash),
        Date.parse(legacy.createdAt) || Date.now(),
      );
      imported += 1;
    } catch {
      // Skip duplicates rather than failing boot on a malformed legacy file.
    }
  }
  if (imported) console.log(`[boot] imported ${imported} account(s) from data/users.json`);
  return imported;
}
