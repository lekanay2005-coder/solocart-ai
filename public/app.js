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
  showPaymentReturn();
}

async function loadPreviewSample() {
  const description = promptField.value.trim();
  try {
    const response = await fetch('/api/parse-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description }),
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
  const aiLabel = appConfig.aiMode === 'openai' ? 'OpenAI' : 'Local parser';
  const paypalLabel = appConfig.paypalMode === 'sandbox' ? 'PayPal Sandbox' : 'PayPal preview';
  connectionLabel.textContent = `${aiLabel} · ${paypalLabel}`;
  connectionDot.classList.toggle('live', appConfig.aiMode === 'openai' || appConfig.paypalMode === 'sandbox');

  if (appConfig.aiMode === 'openai') {
    privacyNote.textContent = 'This order request is sent to OpenAI for extraction. Review every line before checkout.';
    aiStepCopy.textContent = 'OpenAI extracts the items, quantities, and prices. You review the draft before checkout.';
  } else {
    privacyNote.textContent = 'Order details stay on this device until checkout. The parser is running locally.';
    aiStepCopy.textContent = 'The local preview parser reads simple, explicitly priced requests. Add an OpenAI key for AI extraction.';
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
    const mode = result.mode === 'openai' ? 'AI extracted a draft.' : 'Local preview parser created a draft.';
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
      return showNotice(result.message || 'Sandbox checkout is not connected yet.', 'error');
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
    addLocalEvent('PayPal Sandbox order completed', 'Buyer approval and capture succeeded');
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
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function navigate() { setPage(location.hash.slice(1) || 'overview'); }
window.addEventListener('hashchange', navigate);
document.querySelectorAll('a[href^="#"]').forEach((link) => link.addEventListener('click', () => {
  const page = link.getAttribute('href').slice(1);
  if (pageViews.some((view) => view.dataset.view === page)) setPage(page);
}));

function readLocalOrders() {
  try { return JSON.parse(localStorage.getItem('solocart-orders') || '[]'); } catch { return []; }
}
function addLocalEvent(title, detail, amount = null) {
  const events = readLocalOrders();
  events.unshift({ id: crypto.randomUUID(), title, detail, amount, time: new Date().toISOString() });
  localStorage.setItem('solocart-orders', JSON.stringify(events.slice(0, 40)));
}
function renderLocalOrderPages() {
  const orders = readLocalOrders();
  const amount = orders.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const balance = document.querySelector('#wallet-balance');
  balance.textContent = amountsHidden ? '••••••' : money(amount);
  document.querySelector('#draft-count').textContent = currentOrder ? '01' : '00';
  document.querySelector('#paid-count').textContent = String(orders.length).padStart(2, '0');
  const html = orders.length ? orders.map((item) => `<article class="activity-row"><span class="activity-mark">✓</span><div><strong>${escapeText(item.title)}</strong><small>${escapeText(item.detail)} · ${new Date(item.time).toLocaleString()}</small></div><b>${item.amount == null ? 'Saved' : (amountsHidden ? '••••' : money(item.amount))}</b></article>`).join('') : '<div class="empty-state"><span>✦</span><strong>Your desk is ready</strong><p>Recent order and checkout events will appear here. Your sample draft is ready in New order.</p><a href="#workspace">Open order builder</a></div>';
  document.querySelector('#activity-list').innerHTML = html;
  document.querySelector('#overview-activity').innerHTML = orders.length ? orders.slice(0, 3).map((item) => `<article class="activity-row"><span class="activity-mark">✓</span><div><strong>${escapeText(item.title)}</strong><small>${escapeText(item.detail)}</small></div><b>${item.amount == null ? 'Saved' : (amountsHidden ? '••••' : money(item.amount))}</b></article>`).join('') : '<div class="empty-state"><span>✦</span><strong>Your desk is ready</strong><p>Recent order and checkout events will appear here. Your sample draft is ready in New order.</p><a href="#workspace">Open order builder</a></div>';
  document.querySelector('#orders-list').innerHTML = currentOrder ? `<article class="panel order-tile"><span class="status-pill">DRAFT · REVIEW</span><h2>Customer order</h2><p>${currentOrder.items.map((item) => `${escapeText(item.quantity)} × ${escapeText(item.name)}`).join(', ')}</p><strong>${amountsHidden ? '••••' : money(currentOrder.total)}</strong><a class="button button-primary" href="#workspace">Review order</a></article>` : '<div class="panel empty-state"><span>✦</span><strong>No drafts yet</strong><p>Start with a customer message and check each detail before checkout.</p><a href="#workspace">Create your first order</a></div>';
}
function escapeText(value) { const node = document.createElement('span'); node.textContent = String(value); return node.innerHTML; }

function refreshSettings() {
  document.querySelector('#settings-account-label').textContent = signedInUser ? `Signed in as ${signedInUser.email}` : 'No account signed in';
  document.querySelector('#theme-toggle').textContent = document.documentElement.dataset.theme === 'dark' ? 'Use light mode' : 'Use night mode';
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
    document.querySelector('#welcome-name').textContent = `Welcome back, ${signedInUser.name.split(' ')[0]}`;
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

// Put each finished checkout into the local activity log; this is not an account balance.
document.querySelector('#create-checkout').addEventListener('click', () => {
  if (appConfig.paypalMode !== 'sandbox' && currentOrder) addLocalEvent('Checkout preview opened', 'Preview only · no payment was made', currentOrder.total);
});
for (const button of document.querySelectorAll('[data-pet-action]')) button.addEventListener('click', () => {
  document.querySelector('#byte-page-status').textContent = document.querySelector('#pet-status').textContent;
});

setAmountsHidden(amountsHidden);
refreshAuth();
renderLocalOrderPages();
navigate();
