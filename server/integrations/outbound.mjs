/**
 * SSRF guard for user-supplied URLs — port of Butler's `outbound.ts`.
 * The server shares its machine with everything else, so it never calls
 * anything private: loopback, RFC1918, link-local (cloud metadata!),
 * carrier-grade NAT, multicast, or this server's own address. Only https,
 * no credentials in the URL, redirects re-checked every hop and never
 * allowed to cross origins (so a vaulted key can't leak to another site).
 */
import { resolve4, resolve6 } from 'node:dns/promises';

/** Whether `ip` is loopback, private, link-local or otherwise not on the public internet. */
export function isPrivateAddress(ip) {
  const v4 = ip.match(/^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/i);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT, Tailscale
      (a === 169 && b === 254) || // link-local, cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19));
  }
  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (!v6.includes(':')) return true; // not an address we understand
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('ff') ||
    v6.startsWith('::ffff:') || v6.startsWith('64:ff9b:');
}

const resolveDns = async (host) => {
  const found = await Promise.all([
    resolve4(host).catch(() => []),
    resolve6(host).catch(() => []),
  ]);
  return found.flat();
};

let ownAddresses = null;

/** This server's own addresses (from APP_BASE_URL), so links can't loop back into it. */
async function ownAddressesOf(resolve) {
  if (!ownAddresses) {
    let host = '';
    try {
      host = new URL(process.env.APP_BASE_URL || '').hostname;
    } catch {
      host = '';
    }
    ownAddresses = host
      ? resolve(host).then((ips) => new Set(ips)).catch(() => new Set())
      : Promise.resolve(new Set());
  }
  return ownAddresses;
}

/** Forgets the addresses learned from APP_BASE_URL (for tests). */
export const forgetOwnAddresses = () => { ownAddresses = null; };

/**
 * The link, checked: https only, no user:password@, and every address the
 * name points at is public and not this server. Throws with a plain reason.
 */
export async function checkUrl(link, resolve = resolveDns) {
  let url;
  try {
    url = new URL(link);
  } catch {
    throw new Error("that isn't a web address");
  }
  if (url.protocol !== 'https:') throw new Error('the address has to start with https://');
  if (url.username || url.password) throw new Error('put the password in the key box, not in the address');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || /\.(localhost|local|internal|lan|home)$/.test(host) || (!host.includes('.') && !host.includes(':'))) {
    throw new Error('SoloCart can only connect to public addresses');
  }
  const literal = /^[\d.]+$/.test(host) || host.includes(':');
  const ips = literal ? [host] : await resolve(host);
  if (!ips.length) throw new Error(`couldn't find ${host}`);
  const mine = await ownAddressesOf(resolve);
  if (ips.some((ip) => isPrivateAddress(ip) || mine.has(ip))) throw new Error('SoloCart can only connect to public addresses');
  return url;
}

/**
 * fetch, for links the seller gave us: checks the address first, and every
 * redirect too. Cross-origin redirects are refused so a vaulted key is never
 * handed to another site. (A name that repoints itself between the check and
 * the call can still slip through — the check stops the everyday mistakes and
 * the obvious tricks, same as Butler's.)
 */
export async function guardedFetch(input, init = {}, resolve = resolveDns) {
  let request = new Request(input, init);
  for (let hop = 0; hop < 4; hop += 1) {
    await checkUrl(request.url, resolve);
    const res = await fetch(request.clone(), { redirect: 'manual' });
    const next = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || !next) return res;
    await res.body?.cancel();
    const to = new URL(next, request.url);
    if (to.origin !== new URL(request.url).origin) {
      throw new Error(`the server tried to send SoloCart to ${to.host}`);
    }
    const keep = res.status === 307 || res.status === 308;
    request = new Request(to, keep ? { method: request.method, headers: request.headers, body: request.body } : { method: 'GET' });
  }
  throw new Error('too many redirects');
}
