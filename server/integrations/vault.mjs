/**
 * The key box: AES-GCM encryption for secrets the integrations keep in SQLite
 * (MCP addresses and keys, webhook tokens). Port of Butler's `vault.ts`:
 * HKDF-SHA256 derives an AES-GCM key from `APP_VAULT_KEY`, so changing the
 * key makes every stored secret unreadable — which is the point.
 *
 * Without `APP_VAULT_KEY` nothing is stored at all: `vaultReady()` is false
 * and features that need it say so, instead of silently writing plaintext.
 */

const PREFIX = 'v1:';
const keys = new Map();

/** The secret the vault key is made from, or null when none is set. */
const source = () => process.env.APP_VAULT_KEY || null;

export const vaultReady = () => source() !== null;

async function key() {
  const secret = source();
  if (!secret) throw new Error('Set APP_VAULT_KEY in .env before storing integration secrets.');
  const known = keys.get(secret);
  if (known) return known;
  const raw = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'HKDF', false, ['deriveKey']);
  const made = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode('solocart vault v1') },
    raw,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  keys.set(secret, made);
  return made;
}

const toB64 = (bytes) => btoa(String.fromCharCode(...bytes));
const fromB64 = (text) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

/** `text`, encrypted, as a string safe to store. */
export async function lock(text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(), new TextEncoder().encode(text)));
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv);
  out.set(sealed, iv.length);
  return PREFIX + toB64(out);
}

/** The text `lock` was given. Throws if it was locked with another key or changed since. */
export async function unlock(stored) {
  if (!stored || !stored.startsWith(PREFIX)) throw new Error('not a locked secret');
  const bytes = fromB64(stored.slice(PREFIX.length));
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, await key(), bytes.slice(12));
  return new TextDecoder().decode(plain);
}
