const promptField = document.querySelector('#order-prompt');
const prepareButton = document.querySelector('#prepare-order');
const checkoutButton = document.querySelector('#create-checkout');
const notice = document.querySelector('#notice');
const emptyOrder = document.querySelector('#empty-order');
const orderContent = document.querySelector('#order-content');
const lineItems = document.querySelector('#line-items');
const itemTotalLabel = document.querySelector('#item-total');
const totalLabel = document.querySelector('#order-total');
const shippingField = document.querySelector('#shipping-amount');
const orderState = document.querySelector('#order-state');
const orderNote = document.querySelector('#order-note');
const connectionLabel = document.querySelector('#connection-label');
const connectionDot = document.querySelector('.mode-dot');
const privacyNote = document.querySelector('#privacy-note');
const checkoutLabel = document.querySelector('#checkout-label');
const checkoutFootnote = document.querySelector('#checkout-footnote');
const aiStepCopy = document.querySelector('#ai-step-copy');

let currentOrder = null;
let appConfig = { aiMode: 'local', paypalMode: 'preview' };

promptField.value = '2 handwoven baskets at $18 each, delivery $5';

boot();

async function boot() {
  try {
    const response = await fetch('/api/config');
    if (response.ok) appConfig = await response.json();
  } catch {
    // The form remains usable in preview mode when no server is connected.
  }
  renderConnectionState();
  if (appConfig.aiMode === 'local') await loadPreviewSample();
  await refreshDesk();
  renderLocalOrderPages();
  showPaymentReturn();
}

async function loadPreviewSample() {
  const description = promptField.value.trim();
  try {
    const response = await fetch('/api/parse-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // preview: the sample on first load is parsed but never stored.
      body: JSON.stringify({ description, preview: true }),
    });
    if (!response.ok) return;
    currentOrder = await response.json();
    currentOrder.sampleDemo = true;
    currentOrder.note = 'Sample demo order. Review and edit every detail before checkout.';
    renderOrder();
    showNotice('Sample draft loaded with the local preview parser.', 'success');
  } catch {
    // The seller can still organize the sample manually when offline.
  }
}

function renderConnectionState() {
  const aiLive = appConfig.aiMode !== 'local';
  const aiLabel = aiLive ? String(appConfig.aiLabel || 'AI').split(' · ')[0] : 'Local parser';
  const paypalLabel = appConfig.paypalMode === 'sandbox' ? 'PayPal Sandbox' : 'PayPal preview';
  connectionLabel.textContent = `${aiLabel} · ${paypalLabel}`;
  connectionDot.classList.toggle('live', aiLive || appConfig.paypalMode === 'sandbox');

  if (aiLive) {
    privacyNote.textContent = `This order request is sent to ${aiLabel} for extraction. Review every line before checkout.`;
    aiStepCopy.textContent = `${aiLabel} extracts the items, quantities, and prices. You review the draft before checkout.`;
  } else {
    privacyNote.textContent = 'Order details stay on this server. Rules and the local parser read plainly priced requests; no AI key is configured.';
    aiStepCopy.textContent = 'Rules and the local parser turn plainly priced requests into drafts. Add an AI key for extraction.';
  }

  if (appConfig.paypalMode === 'sandbox') {
    checkoutLabel.textContent = 'Create PayPal Sandbox checkout';
    checkoutFootnote.textContent = 'Sandbox only. PayPal hosts approval; no live payment is enabled.';
  } else {
    checkoutLabel.textContent = 'View checkout preview';
    checkoutFootnote.textContent = 'Add PayPal Sandbox credentials in .env to create a test checkout.';
  }
}

prepareButton.addEventListener('click', async () => {
  const description = promptField.value.trim();
  if (!description) return showNotice('Add the customer’s request first.', 'error');
  setBusy(prepareButton, true, 'Organizing…');
  hideNotice();
  try {
    const response = await fetch('/api/parse-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not organize that order.');
    currentOrder = result;
    renderOrder();
    await refreshDesk();
    renderLocalOrderPages();
    const provider = String(appConfig.aiLabel || 'AI').split(' · ')[0];
    const mode = result.mode === 'ai' ? `${provider} extracted a draft.`
      : result.mode === 'rules' ? 'A pricing rule matched, so no AI was called.'
        : 'Local preview parser created a draft.';
    showNotice(`${mode} Check each line before you continue.`, 'success');
  } catch (error) {
    showNotice(error.message || 'Could not organize that order.', 'error');
  } finally {
    setBusy(prepareButton, false, 'Organize order');
  }
});

shippingField.addEventListener('input', () => {
  if (!currentOrder) return;
  currentOrder.shipping = numericValue(shippingField.value);
  renderTotals();
});

checkoutButton.addEventListener('click', async () => {
  if (!currentOrder || checkoutButton.disabled) return;
  const order = readOrderFromForm();
  if (!order.items.length || order.items.some((item) => !item.name.trim() || item.quantity < 1 || item.unitPrice <= 0)) {
    return showNotice('Add a positive price and quantity for every item.', 'error');
  }
  if (appConfig.paypalMode !== 'sandbox') {
    return showNotice(`Preview total: ${money(order.total)}. Add your PayPal Sandbox app keys in .env to try buyer approval.`, 'success');
  }

  setBusy(checkoutButton, true, 'Creating…');
  hideNotice();
  try {
    const response = await fetch('/api/create-checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(order),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'PayPal Sandbox could not create this checkout.');
    if (result.mode !== 'sandbox' || !result.approvalUrl) {
      await refreshDesk();
      renderLocalOrderPages();
      return showNotice(result.message || 'Sandbox checkout is not connected yet.', 'success');
    }
    window.location.assign(result.approvalUrl);
  } catch (error) {
    showNotice(error.message || 'PayPal Sandbox could not create this checkout.', 'error');
    setBusy(checkoutButton, false, checkoutLabel.textContent);
  }
});

function renderOrder() {
  emptyOrder.hidden = true;
  orderContent.hidden = false;
  orderState.textContent = 'Review before checkout';
  orderState.classList.add('ready');
  orderNote.textContent = currentOrder.note || 'Confirm the details. You can edit quantity, price, and delivery.';
  shippingField.value = Number(currentOrder.shipping || 0).toFixed(2);
  lineItems.replaceChildren();

  currentOrder.items.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = 'line-item';

    const main = document.createElement('div');
    main.className = 'line-item-main';
    const name = document.createElement('span');
    name.className = 'item-name';
    name.textContent = item.name;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove-item';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Remove ${item.name}`);
    remove.addEventListener('click', () => {
      currentOrder.items.splice(index, 1);
      if (!currentOrder.items.length) {
        currentOrder = null;
        emptyOrder.hidden = false;
        orderContent.hidden = true;
        checkoutButton.disabled = true;
        orderState.textContent = 'Waiting for a request';
        orderState.classList.remove('ready');
        renderRouteAmounts(0);
        return;
      }
      renderOrder();
    });
    main.append(name, remove);

    const quantity = document.createElement('input');
    quantity.className = 'line-field';
    quantity.type = 'number';
    quantity.min = '1';
    quantity.max = '99';
    quantity.step = '1';
    quantity.inputMode = 'numeric';
    quantity.value = String(item.quantity);
    quantity.setAttribute('aria-label', `Quantity for ${item.name}`);
    quantity.addEventListener('input', () => {
      currentOrder.items[index].quantity = Math.max(1, Math.min(99, Math.trunc(numericValue(quantity.value) || 1)));
      renderTotals();
    });

    const priceWrap = document.createElement('div');
    priceWrap.className = 'price-wrap';
    const dollar = document.createElement('span');
    dollar.textContent = '$';
    const price = document.createElement('input');
    price.className = 'line-field price';
    price.type = 'number';
    price.min = '0';
    price.max = '10000';
    price.step = '0.01';
    price.inputMode = 'decimal';
    price.value = Number(item.unitPrice || 0).toFixed(2);
    price.setAttribute('aria-label', `Unit price for ${item.name} in dollars`);
    price.addEventListener('input', () => {
      currentOrder.items[index].unitPrice = numericValue(price.value);
      renderTotals();
    });
    priceWrap.append(dollar, price);

    row.append(main, quantity, priceWrap);
    lineItems.append(row);
  });
  renderTotals();
}

function renderTotals() {
  if (!currentOrder) return;
  const order = readOrderFromForm();
  currentOrder.itemTotal = order.itemTotal;
  currentOrder.total = order.total;
  itemTotalLabel.textContent = money(order.itemTotal);
  totalLabel.textContent = money(order.total);
  const valid = order.items.length > 0 && order.items.every((item) => item.quantity >= 1 && item.unitPrice > 0) && order.total > 0;
  checkoutButton.disabled = !valid;
  orderState.textContent = valid ? (currentOrder.sampleDemo ? 'Sample demo draft' : 'Review before checkout') : 'Add item prices';
  orderState.classList.toggle('ready', valid);
  renderRouteAmounts(order.total);
}

function readOrderFromForm() {
  const rows = [...lineItems.querySelectorAll('.line-item')];
  const items = rows.map((row, index) => ({
    name: currentOrder.items[index].name,
    quantity: Math.max(1, Math.trunc(numericValue(row.querySelector('input[type="number"]')?.value) || 1)),
    unitPrice: numericValue(row.querySelector('.price')?.value),
  }));
  const shipping = numericValue(shippingField.value);
  const itemTotal = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  return { currency: 'USD', items, shipping, itemTotal: roundMoney(itemTotal), total: roundMoney(itemTotal + shipping) };
}

function showPaymentReturn() {
  const params = new URLSearchParams(window.location.search);
  const payment = params.get('payment');
  if (!payment) return;
  if (payment === 'cancelled') showNotice('Checkout was cancelled. Your draft is still yours to edit.', 'success');
  else if (payment === 'COMPLETED') {
    showNotice('Sandbox payment completed. The order was approved in PayPal Sandbox.', 'success');
    refreshDesk().then(renderLocalOrderPages);
  }
  else if (payment === 'error') showNotice('PayPal returned to the app, but sandbox capture did not complete. Check the PayPal test account and try again.', 'error');
  else if (payment === 'unavailable') showNotice('PayPal Sandbox return is unavailable until sandbox credentials are configured.', 'error');
  if (window.history.replaceState) window.history.replaceState({}, '', '/');
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  const text = button.querySelector('span:not(.button-arrow)');
  if (text && button === prepareButton) text.textContent = label;
  if (button === checkoutButton) checkoutLabel.textContent = label;
}

function showNotice(message, kind = 'info') {
  notice.textContent = message;
  notice.dataset.kind = kind;
  notice.hidden = false;
}

function hideNotice() {
  notice.hidden = true;
  notice.textContent = '';
}

function numericValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

const routeInputs = [...document.querySelectorAll('.route-share')];
for (const input of routeInputs) input.addEventListener('input', () => {
  const edited = input;
  const otherNonPayPal = routeInputs.filter((route) => route !== edited && route.dataset.route !== 'paypal');
  const requested = Number(edited.value);
  const otherSum = otherNonPayPal.reduce((sum, route) => sum + Number(route.value), 0);
  if (edited.dataset.route !== 'paypal' && requested + otherSum > 100) {
    edited.value = String(Math.max(0, 100 - otherSum));
  }
  const nonPayPalTotal = routeInputs.filter((route) => route.dataset.route !== 'paypal').reduce((sum, route) => sum + Number(route.value), 0);
  const paypal = routeInputs.find((route) => route.dataset.route === 'paypal');
  paypal.value = String(Math.max(0, 100 - nonPayPalTotal));
  const total = currentOrder ? readOrderFromForm().total : 0;
  renderRouteAmounts(total);
});

function renderRouteAmounts(total) {
  for (const input of routeInputs) {
    const output = document.querySelector(`[data-route-value="${input.dataset.route}"]`);
    const share = Number(input.value) || 0;
    output.textContent = `${share}% · ${money(roundMoney(total * share / 100))}`;
    input.setAttribute('aria-valuetext', `${share} percent, ${money(total * share / 100)}`);
  }
  document.querySelector('#route-total').textContent = money(total);
}

for (const button of document.querySelectorAll('[data-pet-action]')) {
  button.addEventListener('click', () => {
    const moods = button.dataset.petAction === 'feed'
      ? ['Byte enjoyed the snack. Energy +1 (just for fun).', 'Byte says thanks and is ready to help.']
      : ['Byte did a tiny dance. Mood: delighted.', 'Byte is back at the desk after a quick game.'];
    document.querySelector('#pet-status').textContent = moods[Math.floor(Math.random() * moods.length)];
  });
}

document.querySelector('#demo-nonce').textContent = `SC-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
renderRouteAmounts(0);

function money(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value || 0);
}

// Multi-page seller desk: the original order builder remains the checkout core.
const pageViews = [...document.querySelectorAll('[data-view]')];
const workspaceSections = [...document.querySelectorAll('main > .intro, main > .workspace, main > .demo-grid, main > .how-it-works')];
const footer = document.querySelector('.footer');
let signedInUser = null;
let amountsHidden = localStorage.getItem('solocart-hide-amounts') === 'true';
const savedTheme = localStorage.getItem('solocart-theme') || 'dark';
document.documentElement.dataset.theme = savedTheme;

function setPage(name) {
  const page = name === 'workspace' || pageViews.some((view) => view.dataset.view === name) ? name : 'overview';
  pageViews.forEach((view) => { view.hidden = view.dataset.view !== page; });
  workspaceSections.forEach((section) => {
    section.hidden = section.id === 'routes' ? page !== 'routes' : page !== 'workspace';
  });
  footer.hidden = ['signin', 'signup'].includes(page);
  if (page === 'routes') {
    const target = document.querySelector('#routes-page-content');
    const source = document.querySelector('#routes');
    if (target && source && source.parentElement !== target) target.append(source);
  }
  document.querySelectorAll('[data-page]').forEach((link) => link.classList.toggle('active', link.dataset.page === page));
  document.querySelectorAll('.more-nav').forEach((menu) => {
    menu.open = false;
    menu.classList.toggle('has-active', Boolean(menu.querySelector(`[data-page="${page}"]`)));
  });
  document.querySelector('#app-pages').hidden = false;
  if (page === 'overview' || page === 'orders' || page === 'activity') renderLocalOrderPages();
  if (page === 'settings') refreshSettings();
  if (page === 'offline') refreshOffline();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function navigate() { setPage(location.hash.slice(1) || 'overview'); }
window.addEventListener('hashchange', navigate);
document.querySelectorAll('a[href^="#"]').forEach((link) => link.addEventListener('click', () => {
  const page = link.getAttribute('href').slice(1);
  if (pageViews.some((view) => view.dataset.view === page)) setPage(page);
}));

// Orders and activity live on the server, scoped to this desk's identity.
// The browser keeps only the theme and the balance-hidden toggle.
let serverEvents = [];
let serverOrders = [];
let serverSummary = { count: 0, amount: 0 };

async function refreshDesk() {
  try {
    const [activityResponse, ordersResponse] = await Promise.all([
      fetch('/api/activity'),
      fetch('/api/orders'),
    ]);
    if (activityResponse.ok) {
      const data = await activityResponse.json();
      serverEvents = data.events || [];
      serverSummary = data.summary || { count: 0, amount: 0 };
    }
    if (ordersResponse.ok) serverOrders = (await ordersResponse.json()).orders || [];
  } catch {
    // Keep the last known state when the server is unreachable.
  }
}

const ORDER_STATUS_LABELS = {
  draft: 'DRAFT · REVIEW',
  awaiting_buyer: 'AWAITING BUYER',
  captured: 'PAID · SANDBOX',
  expired: 'EXPIRED',
  failed: 'FAILED',
  paid_offline_pending: 'OFFLINE · PENDING',
  settled: 'SETTLED',
};

function orderTile(order) {
  const lines = (order.items || []).map((item) => `${escapeText(item.quantity)} × ${escapeText(item.name)}`).join(', ');
  const amount = amountsHidden ? '••••' : money(order.total);
  const action = order.status === 'draft' ? '<a class="button button-primary" href="#workspace">Review order</a>' : '';
  return `<article class="panel order-tile"><span class="status-pill">${ORDER_STATUS_LABELS[order.status] || escapeText(String(order.status).toUpperCase())}</span><h2>Customer order</h2><p>${lines}</p><strong>${amount}</strong>${action}<small class="order-when">${escapeText(new Date(order.createdAt).toLocaleString())}</small></article>`;
}

const DESK_EMPTY = '<div class="empty-state"><span>✦</span><strong>Your desk is ready</strong><p>Recent order and checkout events will appear here. Your sample draft is ready in New order.</p><a href="#workspace">Open order builder</a></div>';

function renderLocalOrderPages() {
  const balance = document.querySelector('#wallet-balance');
  balance.textContent = amountsHidden ? '••••••' : money(serverSummary.amount);
  const drafts = serverOrders.filter((order) => order.status === 'draft').length;
  document.querySelector('#draft-count').textContent = String(Math.min(99, drafts)).padStart(2, '0');
  document.querySelector('#paid-count').textContent = String(serverSummary.count).padStart(2, '0');
  const row = (item) => `<article class="activity-row"><span class="activity-mark">✓</span><div><strong>${escapeText(item.title)}</strong><small>${escapeText(item.detail)} · ${new Date(item.time).toLocaleString()}</small></div><b>${item.amount == null ? 'Saved' : (amountsHidden ? '••••' : money(item.amount))}</b></article>`;
  document.querySelector('#activity-list').innerHTML = serverEvents.length ? serverEvents.map(row).join('') : DESK_EMPTY;
  document.querySelector('#overview-activity').innerHTML = serverEvents.length
    ? serverEvents.slice(0, 3).map((item) => `<article class="activity-row"><span class="activity-mark">✓</span><div><strong>${escapeText(item.title)}</strong><small>${escapeText(item.detail)}</small></div><b>${item.amount == null ? 'Saved' : (amountsHidden ? '••••' : money(item.amount))}</b></article>`).join('')
    : DESK_EMPTY;
  document.querySelector('#orders-list').innerHTML = serverOrders.length
    ? serverOrders.slice(0, 6).map(orderTile).join('')
    : '<div class="panel empty-state"><span>✦</span><strong>No drafts yet</strong><p>Start with a customer message and check each detail before checkout.</p><a href="#workspace">Create your first order</a></div>';
}
function escapeText(value) { const node = document.createElement('span'); node.textContent = String(value); return node.innerHTML; }

// --- Offline payments (phase 3) --------------------------------------------------
// Issue a signed request from a draft order, then redeem the buyer's signed
// confirmation. Settlement is simulated and labeled as such everywhere.

let offlineRequests = [];
let lastIssued = null;

const OFFLINE_STATUS_LABELS = {
  pending: 'AWAITING BUYER',
  confirmed: 'READY TO REDEEM',
  redeemed: 'REDEEMED · SETTLED',
  expired: 'EXPIRED',
};

function showOfflineNotice(message, kind = 'info') {
  const element = document.querySelector('#offline-notice');
  element.textContent = message;
  element.dataset.kind = kind;
  element.hidden = false;
}

async function refreshOffline() {
  try {
    const response = await fetch('/api/offline/requests');
    if (response.ok) offlineRequests = (await response.json()).requests || [];
  } catch {
    // Keep the last known list when the server is unreachable.
  }
  renderOffline();
}

function renderOffline() {
  const drafts = serverOrders.filter((order) => order.status === 'draft');
  const select = document.querySelector('#offline-order');
  const keep = select.value;
  select.innerHTML = drafts.length
    ? drafts.map((order) => `<option value="${escapeText(order.id)}">${escapeText((order.items || []).map((item) => `${item.quantity} × ${item.name}`).join(', ') || 'Order')} · ${amountsHidden ? '••••' : money(order.total)}</option>`).join('')
    : '<option value="">No draft orders yet — create one in New order</option>';
  if (drafts.some((order) => order.id === keep)) select.value = keep;
  document.querySelector('#offline-issue').disabled = !drafts.length;

  document.querySelector('#offline-requests').innerHTML = offlineRequests.length
    ? offlineRequests.map(offlineRow).join('')
    : '<div class="empty-state"><span>✦</span><strong>No requests yet</strong><p>Issue a signed payment request from a draft order to start an offline handoff.</p></div>';
}

function offlineRow(entry) {
  const label = OFFLINE_STATUS_LABELS[entry.status] || String(entry.status).toUpperCase();
  const amount = amountsHidden ? '••••' : money(entry.amount);
  const action = entry.status === 'confirmed'
    ? `<button class="button button-primary" type="button" data-redeem="${escapeText(entry.requestId)}">Redeem payment</button>`
    : '';
  return `<article class="offline-row"><div><span class="status-pill">${escapeText(label)}</span><h3>${escapeText(entry.note || 'Order payment')}</h3><p>${escapeText(entry.requestId)} · ${escapeText(new Date(entry.createdAt).toLocaleString())}</p></div><div class="offline-row-side"><strong>${amount}</strong>${action}</div></article>`;
}

async function issueOfflineRequest() {
  const orderId = document.querySelector('#offline-order').value;
  if (!orderId) return;
  const button = document.querySelector('#offline-issue');
  button.disabled = true;
  try {
    const response = await fetch('/api/offline/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not issue that request.');
    lastIssued = result;
    document.querySelector('#offline-issued').hidden = false;
    document.querySelector('#offline-paylink').textContent = `${location.origin}${result.payUrl}`;
    document.querySelector('#offline-payload').value = result.payload;
    showOfflineNotice(result.notice, 'success');
    await renderOfflineQr(result.payload);
    await refreshOffline();
    refreshDesk().then(renderLocalOrderPages);
  } catch (error) {
    showOfflineNotice(error.message, 'error');
  } finally {
    button.disabled = !serverOrders.some((order) => order.status === 'draft');
  }
}

async function renderOfflineQr(payload) {
  const canvas = document.querySelector('#offline-qr');
  try {
    const { default: qrcode } = await import('/vendor/qrcode.mjs');
    await qrcode.toCanvas(canvas, payload, {
      width: 220,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#0b1622', light: '#ffffff' },
    });
    canvas.hidden = false;
  } catch {
    canvas.hidden = true; // payload + link still work without the QR render
  }
}

async function redeemOffline(requestId, button) {
  button.disabled = true;
  try {
    const response = await fetch('/api/offline/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not redeem that payment.');
    showOfflineNotice(result.notice, 'success');
    await refreshOffline();
    await refreshDesk();
    renderLocalOrderPages();
  } catch (error) {
    showOfflineNotice(error.message, 'error');
    await refreshOffline();
  }
}

document.querySelector('#offline-issue').addEventListener('click', issueOfflineRequest);
document.querySelector('#offline-requests').addEventListener('click', (event) => {
  const button = event.target.closest('[data-redeem]');
  if (button) redeemOffline(button.dataset.redeem, button);
});
for (const id of ['#offline-copy', '#offline-copy-link']) {
  document.querySelector(id).addEventListener('click', async (event) => {
    const text = id === '#offline-copy'
      ? document.querySelector('#offline-payload').value
      : document.querySelector('#offline-paylink').textContent;
    try {
      await navigator.clipboard.writeText(text);
      event.target.textContent = 'Copied';
      setTimeout(() => { event.target.textContent = id === '#offline-copy' ? 'Copy payload' : 'Copy payment link'; }, 1600);
    } catch {
      showOfflineNotice('Copy failed — select the text and copy manually.', 'error');
    }
  });
}

function refreshSettings() {
  document.querySelector('#settings-account-label').textContent = signedInUser ? `Signed in as ${signedInUser.email}` : 'No account signed in';
  document.querySelector('#theme-toggle').textContent = document.documentElement.dataset.theme === 'dark' ? 'Use light mode' : 'Use night mode';
  refreshFacts();
  document.querySelector('#settings-balance-toggle').textContent = amountsHidden ? 'Show amounts' : 'Hide amounts';
}
function setAmountsHidden(hidden) {
  amountsHidden = hidden;
  localStorage.setItem('solocart-hide-amounts', String(hidden));
  document.querySelector('#balance-toggle').textContent = hidden ? 'Show balance' : 'Hide balance';
  document.querySelector('#settings-balance-toggle').textContent = hidden ? 'Show amounts' : 'Hide amounts';
  renderLocalOrderPages();
}
document.querySelector('#balance-toggle').addEventListener('click', () => setAmountsHidden(!amountsHidden));
document.querySelector('#settings-balance-toggle').addEventListener('click', () => setAmountsHidden(!amountsHidden));
document.querySelector('#theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  document.documentElement.style.colorScheme = next;
  document.querySelector('meta[name="theme-color"]').content = next === 'dark' ? '#080d14' : '#f4f6fa';
  localStorage.setItem('solocart-theme', next);
  refreshSettings();
});

async function refreshAuth() {
  try {
    const response = await fetch('/api/auth/me');
    const result = await response.json();
    signedInUser = result.user;
  } catch { signedInUser = null; }
  const signedIn = Boolean(signedInUser);
  document.querySelector('#signed-out-actions').hidden = signedIn;
  document.querySelector('#signed-in-actions').hidden = !signedIn;
  document.querySelector('#account-summary').textContent = signedIn ? `Signed in as ${signedInUser.email}` : 'Sign in or create a local SoloCart account.';
  if (signedIn) {
    document.querySelector('#profile-name').textContent = signedInUser.name;
    document.querySelector('#profile-email').textContent = signedInUser.email;
    document.querySelector('#profile-badge').textContent = signedInUser.name.slice(0, 1).toUpperCase();
    document.querySelector('.avatar').textContent = signedInUser.name.slice(0, 1).toUpperCase();
    const welcome = document.querySelector('#welcome-name');
    if (welcome) welcome.textContent = `Welcome back, ${signedInUser.name.split(' ')[0]}`;
  }
  refreshSettings();
}

async function submitAuth(form, endpoint) {
  const message = form.querySelector('.auth-message');
  const button = form.querySelector('button[type="submit"]');
  message.textContent = '';
  button.disabled = true;
  try {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not complete sign-in.');
    signedInUser = result.user;
    await refreshAuth();
    location.hash = '#account';
  } catch (error) { message.textContent = error.message; }
  finally { button.disabled = false; }
}
document.querySelector('#signin-form').addEventListener('submit', (event) => { event.preventDefault(); submitAuth(event.currentTarget, '/api/auth/login'); });
document.querySelector('#signup-form').addEventListener('submit', (event) => { event.preventDefault(); submitAuth(event.currentTarget, '/api/auth/register'); });
document.querySelector('#signout-button').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  signedInUser = null;
  await refreshAuth();
  location.hash = '#signin';
});

// Preview checkouts are recorded by the server, so the activity feed is
// server-written end to end; the browser only reads it.
for (const button of document.querySelectorAll('[data-pet-action]')) button.addEventListener('click', () => {
  document.querySelector('#byte-page-status').textContent = document.querySelector('#pet-status').textContent;
});

setAmountsHidden(amountsHidden);
refreshAuth();
renderLocalOrderPages();
navigate();

// --- Ask Byte ------------------------------------------------------------------
// One message in, one plan out. Reads answer immediately; anything that sends,
// changes or deletes comes back as a plan and waits for the confirm click.
const askInput = document.querySelector('#ask-input');
const askSend = document.querySelector('#ask-send');
const askMic = document.querySelector('#ask-mic');
const askNotice = document.querySelector('#ask-notice');
const askPlan = document.querySelector('#ask-plan');
const askPlanText = document.querySelector('#ask-plan-text');
const askConfirm = document.querySelector('#ask-confirm');
const askCancel = document.querySelector('#ask-cancel');
const askAnswer = document.querySelector('#ask-answer');
const askAnswerText = document.querySelector('#ask-answer-text');
let askToken = null;

function setAskNotice(message, kind = 'info') {
  askNotice.textContent = message || '';
  askNotice.dataset.kind = kind;
  askNotice.hidden = !message;
}

function clearAskResult() {
  askPlan.hidden = true;
  askAnswer.hidden = true;
  askToken = null;
}

function showByteReply(reply) {
  const text = String(reply || '');
  askAnswerText.textContent = text;
  askAnswer.hidden = false;
  const firstLine = text.split('\n')[0];
  document.querySelector('#pet-status').textContent = firstLine.slice(0, 140);
  document.querySelector('#byte-page-status').textContent = firstLine.slice(0, 180);
}

async function askByte(text) {
  const value = String(text || '').trim();
  if (!value) return setAskNotice('Type a command or a question for Byte first.', 'error');
  clearAskResult();
  setAskNotice('');
  const label = askSend.textContent;
  askSend.disabled = true;
  askSend.textContent = 'Thinking…';
  document.querySelector('#pet-status').textContent = 'Byte is thinking…';
  try {
    const response = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: value }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Byte could not read that.');
    if (result.needsConfirm) {
      askToken = result.token;
      askPlanText.textContent = result.plan.reply || 'Byte wants to change something on your desk. Nothing has happened yet.';
      askPlan.hidden = false;
      setAskNotice('This one writes to your desk, so it waits for your confirm click.', 'info');
      document.querySelector('#pet-status').textContent = 'Byte is waiting for your approval…';
    } else {
      showByteReply(result.reply);
      setAskNotice('Read-only action — nothing was changed.', 'success');
    }
  } catch (error) {
    setAskNotice(error.message, 'error');
    document.querySelector('#pet-status').textContent = 'Byte could not work that out.';
  } finally {
    askSend.disabled = false;
    askSend.textContent = label;
  }
}

async function answerConfirmation(confirm) {
  if (!askToken) return;
  const token = askToken;
  askToken = null;
  askConfirm.disabled = true;
  askCancel.disabled = true;
  try {
    const response = await fetch('/api/ask/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, confirm }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'That confirmation could not be completed.');
    setAskNotice(result.reply, confirm ? 'success' : 'info');
    if (confirm) showByteReply(result.reply);
    await refreshDesk();
    renderLocalOrderPages();
  } catch (error) {
    setAskNotice(error.message, 'error');
  } finally {
    askPlan.hidden = true;
    askConfirm.disabled = false;
    askCancel.disabled = false;
  }
}

askSend.addEventListener('click', () => askByte(askInput.value));
askInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') askByte(askInput.value); });
askConfirm.addEventListener('click', () => answerConfirmation(true));
askCancel.addEventListener('click', () => answerConfirmation(false));

// Voice input where the browser offers the Web Speech API (typed input always works).
const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRecognitionCtor) {
  askMic.hidden = false;
  const recognition = new SpeechRecognitionCtor();
  recognition.lang = document.documentElement.lang || 'en';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  let listening = false;
  askMic.addEventListener('click', () => {
    if (listening) {
      recognition.stop();
      return;
    }
    try {
      recognition.start();
    } catch {
      // Already starting; ignore.
    }
  });
  recognition.onstart = () => { listening = true; askMic.textContent = 'Listening…'; };
  recognition.onend = () => { listening = false; askMic.textContent = 'Speak'; };
  recognition.onerror = () => { listening = false; askMic.textContent = 'Speak'; };
  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    askInput.value = transcript;
    askByte(transcript);
  };
}

// --- What Byte remembers (Settings) ----------------------------------------------
async function refreshFacts() {
  const list = document.querySelector('#facts-list');
  if (!list) return;
  try {
    const response = await fetch('/api/facts');
    if (!response.ok) return;
    const payload = await response.json();
    const facts = payload.facts || [];
    if (!facts.length) {
      list.innerHTML = '<li class="facts-empty">Nothing remembered yet. Byte picks up facts you mention, and you can forget any of them here.</li>';
      return;
    }
    list.replaceChildren(...facts.map((fact) => {
      const item = document.createElement('li');
      const text = document.createElement('span');
      text.textContent = fact.text;
      const forget = document.createElement('button');
      forget.type = 'button';
      forget.className = 'facts-forget';
      forget.textContent = 'Forget';
      forget.setAttribute('aria-label', `Forget: ${fact.text}`);
      forget.addEventListener('click', async () => {
        await fetch(`/api/facts/${encodeURIComponent(fact.id)}`, { method: 'DELETE' });
        refreshFacts();
      });
      item.append(text, forget);
      return item;
    }));
  } catch {
    // The settings page stays usable when the server is unreachable.
  }
}

document.querySelector('#facts-forget-all').addEventListener('click', async () => {
  await fetch('/api/facts/forget-all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  refreshFacts();
});
