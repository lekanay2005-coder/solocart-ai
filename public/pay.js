/**
 * The buyer's page: load a payment request, provision a Reserve while online,
 * pay from it with zero connectivity, then hand the signed confirmation to
 * the seller's server.
 *
 * All signing happens here, in the browser, via /offline/wallet.mjs — the
 * server only ever sees signed results and verifies them. Nothing on this
 * page claims settlement: the states are "signed", "handed over", and
 * "settlement pending", never "paid".
 */
import { createWallet, deserializeRequest, verifyPaymentRequest } from '/offline/wallet.mjs';

const statusPill = document.querySelector('#pay-status');
const notice = document.querySelector('#pay-notice');
const details = document.querySelector('#pay-request-details');
const pasteBox = document.querySelector('#pay-paste');
const payButton = document.querySelector('#pay-do');
const handoffBox = document.querySelector('#pay-handoff');
const confirmationBox = document.querySelector('#pay-confirmation');

const wallet = createWallet();
let request = null;
let requestStatus = 'pending';
let handoffPayload = '';

const params = new URLSearchParams(location.search);
const sharedRequestId = params.get('r') || '';

function showNotice(message, kind = 'info') {
  notice.textContent = message;
  notice.dataset.kind = kind;
  notice.hidden = false;
}

function setStatus(label, kind) {
  statusPill.textContent = label;
  statusPill.dataset.kind = kind || '';
}

function money(minor, currency) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format((minor || 0) / 100);
}

// --- load the request -------------------------------------------------------------

async function loadSharedRequest() {
  if (!/^req_[0-9a-f]{20}$/.test(sharedRequestId)) {
    setStatus('PASTE A PAYLOAD', 'info');
    details.innerHTML = '<p class="intro-copy">No request link in this URL — paste the seller’s payload below to load it.</p>';
    pasteBox.hidden = false;
    return;
  }
  try {
    const response = await fetch(`/api/offline/share/${sharedRequestId}`);
    if (!response.ok) throw new Error('That request does not exist (or was removed).');
    const shared = await response.json();
    adoptRequest(shared.request, shared.status);
  } catch (error) {
    setStatus('NOT FOUND', 'error');
    details.innerHTML = `<p class="intro-copy">${escapeHtml(error.message)}</p>`;
    pasteBox.hidden = false;
  }
}

function adoptRequest(candidate, status) {
  if (!verifyPaymentRequest(candidate)) {
    setStatus('FAILED CHECK', 'error');
    details.innerHTML = '<p class="intro-copy">This request failed its integrity check — the payload was altered or corrupted. Do not pay it.</p>';
    payButton.disabled = true;
    return;
  }
  request = candidate;
  requestStatus = status || 'pending';
  renderRequest();
}

function renderRequest() {
  const expired = request.expiresAt <= Date.now();
  details.innerHTML = `
    <div class="offline-request-amount"><strong>${escapeHtml(money(request.amountMinor, request.currency))}</strong><span>to ${escapeHtml(request.merchant.name)}</span></div>
    <p class="offline-link">${escapeHtml(request.note)} · request ${escapeHtml(request.id)}</p>
    <p class="intro-copy">${escapeHtml(new Date(request.createdAt).toLocaleString())} · expires ${escapeHtml(new Date(request.expiresAt).toLocaleString())}</p>`;

  if (expired) {
    setStatus('EXPIRED', 'error');
    showNotice('This request has expired — ask the seller to issue a new one.', 'error');
    payButton.disabled = true;
    return;
  }
  if (requestStatus === 'redeemed') {
    setStatus('ALREADY REDEEMED', 'info');
    showNotice('This payment was already handed over and redeemed. Nothing to do.', 'info');
    payButton.disabled = true;
    return;
  }
  if (requestStatus === 'confirmed') {
    setStatus('HANDED OVER', 'info');
    showNotice('A confirmation for this request is already with the seller.', 'info');
    payButton.disabled = true;
    return;
  }
  setStatus('READY', 'success');
  refreshReserve();
}

// --- reserve ----------------------------------------------------------------------

function refreshReserve() {
  const summary = wallet.reserveSummary();
  const box = document.querySelector('#pay-reserve-summary');
  if (!summary.active) {
    box.innerHTML = '<p class="intro-copy">No Reserve on this device yet. Add funds while you are online — spending later needs no connectivity.</p>';
    payButton.disabled = true;
    return;
  }
  box.innerHTML = `
    <div class="offline-request-amount"><strong>${escapeHtml(money(summary.remainingMinor, summary.currency))}</strong><span>remaining of ${escapeHtml(money(summary.valueMinor, summary.currency))}</span></div>
    <p class="offline-link">allowance ${escapeHtml(summary.allowanceId)} · ${summary.counter} spend(s) · expires ${escapeHtml(new Date(summary.expiresAt).toLocaleTimeString())}</p>`;
  if (!request || requestStatus !== 'pending' || request.expiresAt <= Date.now()) return;
  const affordable = summary.remainingMinor >= request.amountMinor;
  payButton.disabled = !affordable;
  payButton.textContent = affordable
    ? `Pay ${money(request.amountMinor, request.currency)} from Reserve (offline)`
    : `Reserve short by ${money(request.amountMinor - summary.remainingMinor, request.currency)}`;
}

document.querySelector('#pay-reserve-add').addEventListener('click', () => {
  try {
    const amount = Number(document.querySelector('#pay-reserve-amount').value);
    wallet.provisionReserve({ valueMinor: Math.round(amount * 100) });
    showNotice('Reserve provisioned on this device. You can now spend it without connectivity.', 'success');
    refreshReserve();
  } catch (error) {
    showNotice(error.message, 'error');
  }
});

// --- pay + handoff ----------------------------------------------------------------

payButton.addEventListener('click', async () => {
  if (!request) return;
  const label = document.querySelector('#pay-label').value.trim();
  payButton.disabled = true;
  try {
    const result = await wallet.payFromReserve({ request, payerLabel: label });
    handoffPayload = result.payload;
    confirmationBox.value = handoffPayload;
    handoffBox.hidden = false;
    setStatus('SIGNED', 'success');
    showNotice('Signed on this device. Now hand the confirmation to the seller — this is the part that works without connectivity.', 'success');
    refreshReserve();
    document.querySelector('#pay-send').disabled = false;
  } catch (error) {
    showNotice(error.message, 'error');
    refreshReserve();
  }
});

document.querySelector('#pay-send').addEventListener('click', async (event) => {
  if (!handoffPayload || !request) return;
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const response = await fetch('/api/offline/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: request.id, confirmation: handoffPayload }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'The seller could not verify this confirmation.');
    setStatus('HANDED OVER', 'success');
    showNotice(result.notice, 'success');
    requestStatus = 'confirmed';
  } catch (error) {
    showNotice(error.message, 'error');
    button.disabled = false;
  }
});

document.querySelector('#pay-copy').addEventListener('click', async (event) => {
  try {
    await navigator.clipboard.writeText(handoffPayload);
    event.target.textContent = 'Copied';
    setTimeout(() => { event.target.textContent = 'Copy payload'; }, 1600);
  } catch {
    showNotice('Copy failed — select the payload and copy manually.', 'error');
  }
});

document.querySelector('#pay-paste-load').addEventListener('click', () => {
  try {
    const payload = document.querySelector('#pay-paste-input').value.trim();
    adoptRequest(deserializeRequest(payload), 'pending');
    pasteBox.hidden = true;
  } catch {
    showNotice('That payload could not be read.', 'error');
  }
});

function escapeHtml(value) {
  const node = document.createElement('span');
  node.textContent = String(value);
  return node.innerHTML;
}

loadSharedRequest();
