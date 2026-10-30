// SoloCart adapter (phase 5): the settlement path that replaces BMONI.
//
// BMONI's path is blocked on KYC/rail activation per Morrow's own docs, so
// payments now settle through SoloCart's server: this device signs the
// confirmation, the server verifies it (`/api/offline/confirm`), and the order
// only reaches `settled` when the seller redeems it on the server
// (`/api/offline/redeem`), which is also where the PayPal Sandbox leg runs.
// The wire format is byte-identical to the web buyer page — proved by the
// shared test-vector file (tests/fixtures/offline-vectors.json).
//
// Server URL: EXPO_PUBLIC_SOLOCART_URL (e.g. http://localhost:4173).
// Unset = local device-to-device mode: same signing, same proof QR, receipts
// stay on this device. Works in Expo Go either way — no native modules here.
import { deserializeRequest } from './protocol';
import type { PaymentRequest } from './types';

export type SolocartShare = {
  requestId: string;
  request: PaymentRequest;
  status: 'pending' | 'confirmed' | 'redeemed' | 'expired';
  expiresAt: number;
};

export type SolocartConfirmResult = {
  verified: boolean;
  requestId: string;
  status: string;
  settlement: string;
  notice: string;
};

export type SolocartErrorCode = 'network' | 'unavailable' | 'rejected' | 'bad_input';

export class SolocartError extends Error {
  code: SolocartErrorCode;
  status?: number;

  constructor(message: string, code: SolocartErrorCode, status?: number) {
    super(message);
    this.name = 'SolocartError';
    this.code = code;
    this.status = status;
  }
}

const TIMEOUT_MS = 8000;
const REQUEST_ID_RE = /^req_[0-9a-f]{20}$/;

/** The configured server origin, or null for local mode. */
export function solocartBaseUrl(): string | null {
  const raw = (process.env.EXPO_PUBLIC_SOLOCART_URL ?? '').trim().replace(/\/+$/, '');
  return raw || null;
}

export const solocartConfigured = (): boolean => solocartBaseUrl() !== null;

/**
 * Pulls a request id out of what the camera or the paste box saw: a bare
 * `req_…` id, or any link carrying one (`…/pay.html?r=req_…`).
 */
export function parsePayRef(input: string): string | null {
  const text = String(input ?? '').trim();
  if (REQUEST_ID_RE.test(text)) return text;
  const fromQuery = text.match(/[?&]r=(req_[0-9a-f]{20})\b/);
  if (fromQuery) return fromQuery[1];
  const fromHash = text.match(/#(?:r|request)=(req_[0-9a-f]{20})\b/);
  if (fromHash) return fromHash[1];
  return null;
}

/** True for a serialized request payload (base64 JSON) — the web QR's content. */
export function looksLikePayload(input: string): boolean {
  const text = String(input ?? '').trim();
  if (text.length < 16 || text.length > 20_000 || text.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/=]+$/.test(text)) return false;
  try {
    const parsed = deserializeRequest(text);
    return parsed?.version === 1 && parsed?.type === 'payment.request';
  } catch {
    return false;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const base = solocartBaseUrl();
  if (!base) {
    throw new SolocartError('No SoloCart server is set (EXPO_PUBLIC_SOLOCART_URL).', 'bad_input');
  }
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new SolocartError('Could not reach the SoloCart server.', 'network');
  }
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const message = typeof payload?.error === 'string' ? payload.error : `SoloCart answered ${response.status}.`;
    // 5xx and timeouts are "can't verify right now"; 4xx is the server
    // refusing this confirmation (expired, replayed, tampered) — callers must
    // treat that differently, because a rejected confirmation must not charge.
    throw new SolocartError(message, response.status >= 500 ? 'unavailable' : 'rejected', response.status);
  }
  return payload as T;
}

/** The seller's issued request, as the server holds it (public read). */
export async function fetchShare(ref: string): Promise<SolocartShare> {
  const requestId = parsePayRef(ref);
  if (!requestId) {
    throw new SolocartError('That does not look like a SoloCart payment link or request id.', 'bad_input');
  }
  const share = await call<{ requestId: string; request: PaymentRequest; status: SolocartShare['status']; expiresAt: number }>(
    `/api/offline/share/${requestId}`
  );
  if (!share?.request) {
    throw new SolocartError('The server did not return that request.', 'rejected');
  }
  return share;
}

/**
 * Hands the signed confirmation to the server — same body as the web buyer
 * page: { requestId, confirmation: <base64 serializeConfirmation()> }.
 * Throws SolocartError with code 'rejected' when the server refuses it.
 */
export async function submitConfirmation(requestId: string, confirmationPayload: string): Promise<SolocartConfirmResult> {
  return call<SolocartConfirmResult>('/api/offline/confirm', {
    method: 'POST',
    body: JSON.stringify({ requestId, confirmation: confirmationPayload }),
  });
}

/** Where this request stands with the seller: pending, confirmed, redeemed, expired. */
export async function settlementStatus(requestId: string): Promise<SolocartShare['status']> {
  const share = await call<{ status: SolocartShare['status'] }>(`/api/offline/share/${requestId}`);
  return share.status;
}
