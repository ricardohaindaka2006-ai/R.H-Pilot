'use strict';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const state = {
  user: null, bot: null, config: null, mode: 'login', view: 'overview',
  symbol: 'XAUUSD', chart: [], firstPrice: null, stream: null, poll: null,
  configPoll: null, formReady: false, desk: null, adminConfig: null,
  markets: null, marketGroups: null, lastProfit: null,
  board: { frozen: false, free: false }
};
const viewMeta = {
  overview: ['Overview', 'Your trading operation at a glance.'],
  trading: ['Trading desk', 'Live exposure and a complete execution audit trail.'],
  markets: ['Market intelligence', 'Activity, macro events and desk reports.'],
  wallet: ['MT5 & Deriv wallet', 'Terminal pairing, broker receipts and optional Options wallet.'],
  support: ['Support centre', 'Manual, protection rules and how to reach us.'],
  users: ['Users & licenses', 'Client access and subscription management.'],
  engine: ['Springboks engine', 'Tune the engine once, then start it here or from the overview.'],
  settings: ['Platform settings', 'Connectivity, maintenance and data resilience.']
};
const errorMessages = {
  'durable-storage-required': 'Free-host storage setup is incomplete. The administrator must configure a private PostgreSQL connection before accepting customer broker tokens or enabling MT5 demo orders.',
  'workspace-capacity-reached': 'This pilot is at its safe account capacity. Existing users were not removed.',
  'deriv-token-expired': 'Your Deriv token expired. Reconnect it in Wallet; your workspace account is still available.',
  'mt5-agent-offline': 'The MT5 agent is offline. Start it on the computer running your exact MT5 account.',
  'mt5-real-orders-disabled': 'Real MT5 accounts are monitor-only in this build. No real-money orders are enabled.',
  'mt5-exact-account-required': 'Enter the exact numeric MT5 login, full server and Market Watch instrument name.',
  'mt5-account-already-linked': 'This MT5 account belongs to another workspace. Use that workspace; no risk history was reset.',
  'mt5-reconciliation-required': 'Existing broker exposure or an unresolved receipt needs reconciliation. No order was retried or forgotten.',
  'mt5-terminal-trading-disabled': 'MT5 Algo Trading or external Python trading is disabled in your terminal.',
  'mt5-usd-account-required': 'Demo execution currently requires a USD account so the dollar risk ceilings are meaningful.',
  'mt5-hedging-account-required': 'Demo execution currently supports hedging accounts only; netting is not treated as equivalent.',
  'mt5-bridge-busy': 'The agent is saving a report. Retry after a moment; no new token or account was selected.',
  'mt5-balance-reconciliation-required': 'The broker balance differs from recorded settlements. Entries remain paused; review the MT5 statement.',
  'mt5-account-not-funded': 'No positive MT5 balance is available. Monitoring is still possible.',
  'invalid-credentials': 'Email recognised — that password is not right. Check caps lock, or use “Password recovery”.',
  'no-such-account': 'No account uses that email. Type the full address, e.g. ricardohaindaka2006@gmail.com.',
  'account-disabled': 'This account is disabled. Contact the admin.',
  'too-many-attempts': 'Too many attempts. Wait one minute, then try again.',
  'email-taken': 'An account already exists for that email.',
  'license-required': 'Enter your license key to continue.',
  'license-invalid': 'That license key is not valid.',
  'license-expired': 'That license has expired. Please renew it.',
  'license-revoked': 'That license has been revoked.',
  'license-bound': 'That license is already linked to another account.',
  'too-many-attempts': 'Too many attempts. Please wait a minute and try again.',
  'payment-required': 'Your access is awaiting payment confirmation.',
  'deriv-market-closed': 'This broker market is closed. Choose an offered open instrument.',
  'deriv-symbol-unavailable': 'This instrument is not offered by the current broker API.',
  'deriv-admin-step-up-required': 'Sign in with your administrator password or verified Google account, then connect Deriv from Wallet.',
  'deriv-app-id-required': 'Administrator setup needed: register and configure your own Deriv App ID. Never enter a PAT as the App ID.',
  'deriv-token-storage-key-required': 'Administrator setup needed: configure the private server token-encryption key.',
  'deriv-oauth-origin-required': 'Administrator setup needed: set PUBLIC_URL to the canonical HTTPS website and register its exact OAuth callback.',
  'deriv-auth-invalid-state': 'This sign-in attempt expired or was already used. Start Deriv sign-in again in this browser.',
  'deriv-link-session-expired': 'Your workspace session expired or changed. Sign in again before linking Deriv.',
  'deriv-auth-account-conflict': 'These broker accounts belong to different workspaces. Contact the administrator; no accounts were merged.',
  'deriv-account-already-linked': 'This broker account is already linked to another workspace. Sign in to that workspace instead.',
  'deriv-credentials-rejected': 'Deriv rejected or expired this credential. Revoke exposed tokens and enter a replacement privately.',
  'deriv-permission-denied': 'Deriv denied account access. Check the registered App ID and token permissions.',
  'deriv-provider-unavailable': 'Deriv could not be reached. No trading was enabled. Please try again.',
  'deriv-account-selection-required': 'Enter the exact account ID. Multiple real accounts were found; none was chosen automatically.',
  'deriv-requested-account-unavailable': 'Deriv did not confirm that exact account ID. Nothing was switched.',
  'deriv-no-options-accounts': 'No supported active Deriv Options accounts were returned. MT5 needs a different integration.',
  'deriv-oauth-failed': 'Deriv did not complete authorization. Retry and check the registered callback URL.',
  'deriv-auth-https-required': 'Open the HTTPS website before entering a credential.',
  'not-signed-in': 'Sign in to your workspace before linking a Deriv account.',
  'unconfigured': 'The administrator must finish Deriv connection setup first.',

  'not-authenticated': 'Your session has expired. Please sign in again.'
};

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}
function money(n, currency = 'USD') {
  const value = Number(n) || 0;
  return (value < 0 ? '-' : '') + currencySymbol(currency) + Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: value !== 0 && Math.abs(value) < 0.0001 ? 8 : Math.abs(value) < 1 ? 4 : 2 });
}
function currencySymbol(c) { return ({ USD: '$', EUR: '€', GBP: '£', BTC: '₿' })[c] || (c ? c + ' ' : '$'); }
function price(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  const digits = Math.abs(v) < 10 ? 5 : Math.abs(v) < 1000 ? 3 : 2;
  return v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function time(ts) { return ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'; }
function date(ts) { return ts ? new Date(ts).toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' }) : 'Lifetime'; }
function setBusy(button, busy, copy = 'Working…') {
  if (!button) return;
  if (busy) { button.dataset.old = button.innerHTML; button.disabled = true; button.textContent = copy; }
  else { button.disabled = false; if (button.dataset.old) button.innerHTML = button.dataset.old; }
}
async function api(path, options = {}) {
  const opts = { credentials: 'same-origin', ...options };
  if (opts.body && typeof opts.body !== 'string') {
    opts.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    opts.body = JSON.stringify(opts.body);
  }
  const response = await fetch(path, opts);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || errorMessages[data.error] || data.error || `Request failed (${response.status})`);
    error.code = data.error; error.status = response.status; error.data = data;
    throw error;
  }
  return data;
}
function toast(message, type = 'success', duration = 3600) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = esc(message).replace(/\n/g, '<br>');
  $('#toast-container').append(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(10px)'; setTimeout(() => el.remove(), 250); }, duration);
}
function showError(form, message) {
  const el = typeof form === 'string' ? $(form) : form;
  if (!el) return toast(message, 'error');
  el.textContent = message; el.classList.remove('hidden');
}
let modalDismiss = null, modalReturnFocus = null;
function updateOverlayState() {
  const dialogOpen = !$('#modal').classList.contains('hidden');
  const manualOpen = !$('#manual-overlay').classList.contains('hidden');
  $('#app').inert = $('#auth-screen').inert = dialogOpen || manualOpen;
  $('#manual-overlay').inert = dialogOpen;
  document.body.classList.toggle('modal-open', dialogOpen || manualOpen);
}
function trapOverlayFocus(e, container) {
  if (e.key !== 'Tab') return;
  const focusable = [...container.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]')]
    .filter(el => el.tabIndex >= 0 && el.getClientRects().length);
  const first = focusable[0], last = focusable.at(-1);
  if (e.shiftKey && (document.activeElement === first || !focusable.includes(document.activeElement))) {
    e.preventDefault(); last?.focus();
  } else if (!e.shiftKey && (document.activeElement === last || !focusable.includes(document.activeElement))) {
    e.preventDefault(); first?.focus();
  }
}
function closeModal() {
  if ($('#modal').classList.contains('hidden')) return;
  $('#modal').classList.add('hidden');
  $('#modal-content').innerHTML = '';
  updateOverlayState();
  if (!$('#manual-overlay').classList.contains('hidden')) $('#manual-title').focus();
  else if (modalReturnFocus?.isConnected && modalReturnFocus.getClientRects().length) modalReturnFocus.focus();
  modalReturnFocus = null;
  const fn = modalDismiss; modalDismiss = null;
  if (fn) fn();
}
function modal(html) {
  if ($('#modal').classList.contains('hidden')) modalReturnFocus = document.activeElement;
  modalDismiss = null;
  $('#modal-content').innerHTML = html;
  $('#modal').classList.remove('hidden');
  updateOverlayState();
  ($('#modal-content input, #modal-content select, #modal-content button') || $('#modal-close')).focus();
}

function stopPolling() { clearInterval(state.poll); clearInterval(state.configPoll); }
function showAuth() {
  clearMt5Token();
  state.user = null; state.bot = null; state.formReady = false;
  clearInterval(state.poll); clearInterval(state.configPoll);
  if (state.stream) { state.stream.close(); state.stream = null; }
  $('#app').classList.add('hidden'); $('#auth-screen').classList.remove('hidden');
}
async function showApp(data) {
  state.user = data.user; state.bot = data.bot;
  $('#auth-screen').classList.add('hidden'); $('#app').classList.remove('hidden');
  $('#side-user-email').textContent = state.user.email;
  $('#side-user-role').textContent = state.user.role === 'admin' ? 'Administrator' : (state.user.licensePlan || 'Client');
  $('#user-avatar').textContent = state.user.email.slice(0, 1).toUpperCase();
  $$('.admin-nav, .admin-view, .admin-only').forEach(el => el.classList.toggle('hidden', state.user.role !== 'admin'));
  $('#welcome-title').textContent = `Good to see you, ${state.user.email.split('@')[0]}.`;
  await loadMarkets();
  state.symbol = state.bot.symbol || 'XAUUSD';
  $('#symbol-select').value = state.symbol;
  await loadPairPicker();
  populateBotForm(); updateBot(state.bot); renderWallet(); renderMt5();
  maybeShowManual();
  connectStream();
  clearInterval(state.poll); clearInterval(state.configPoll);
  state.poll = setInterval(pollBot, 1800);
  state.configPoll = setInterval(loadPublicConfig, 10000);
  loadPublicConfig();
  const params = new URLSearchParams(location.search);
  const result = params.get('deriv');
  if (result === 'linked') toast('Deriv account access connected. Real-money orders remain disabled.');
  else if (result) toast(errorMessages[result] || 'Deriv sign-in could not be completed. Start again from this browser.', 'error', 6500);
  history.replaceState({}, '', location.pathname);
}
/* --------------------------------------------------------------- markets */
/* Markets come with their opening hours from the server, so the picker can show
   at a glance which ones are open right now — forex and metals pause at the
   weekend while volatility and Boom/Crash keep trading. */
const MARKET_GROUP_META = {
  fx: { id: 'fx', label: 'Forex & Metals', note: 'Closed weekends' },
  volatility: { id: 'volatility', label: 'Volatility indices', note: 'Open 24/7' },
  'boom-crash': { id: 'boom-crash', label: 'Boom & Crash', note: 'Open 24/7' }
};
/* Built-in list so the picker still works if the market service is briefly
   unreachable; mirrors the server's weekend waterfall. */
function forecastMarkets() {
  const now = new Date();
  const day = now.getUTCDay(), mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  const fxOpen = !(day === 6 || (day === 5 && mins >= 1260) || (day === 0 && mins < 1260));
  const rows = [
    ['XAUUSD', 'Gold / USD', 'fx'], ['XAGUSD', 'Silver / USD', 'fx'], ['EURUSD', 'Euro / USD', 'fx'],
    ['GBPUSD', 'GBP / USD', 'fx'], ['USDJPY', 'USD / JPY', 'fx'], ['USDCAD', 'USD / CAD', 'fx'],
    ['AUDUSD', 'AUD / USD', 'fx'], ['NZDUSD', 'NZD / USD', 'fx'],
    ['VOL10', 'Volatility 10', 'volatility'], ['VOL25', 'Volatility 25', 'volatility'], ['VOL50', 'Volatility 50', 'volatility'],
    ['VOL75', 'Volatility 75', 'volatility'], ['VOL100', 'Volatility 100', 'volatility'],
    ['CRASH500', 'Crash 500', 'boom-crash'], ['BOOM1000', 'Boom 1000', 'boom-crash']
  ];
  return rows.map(([id, label, group]) => {
    const g = MARKET_GROUP_META[group], open = group === 'fx' ? fxOpen : true;
    return { id, label, group, groupLabel: g.label, groupNote: g.note, open, status: open ? 'open' : 'closed' };
  });
}
async function loadMarkets() {
  if (!state.markets) {
    try {
      const data = await api('/api/market/symbols');
      state.markets = Array.isArray(data.markets) && data.markets.length
        ? data.markets
        : (data.symbols || []).map(id => ({ id, label: '', group: 'fx', groupLabel: 'Forex & Metals', groupNote: '', open: true, status: 'open' }));
      state.marketGroups = data.groups || [];
    } catch (e) {
      state.markets = forecastMarkets();
      state.marketGroups = Object.values(MARKET_GROUP_META);
    }
  }
  const optionHtml = m => `<option value="${esc(m.id)}">${esc(m.id)}${m.label ? ' — ' + esc(m.label) : ''}${m.open ? '' : ' (closed)'}</option>`;
  const chart = $('#symbol-select');
  if (chart && chart.dataset.filled !== '1') { chart.innerHTML = state.markets.map(optionHtml).join(''); chart.dataset.filled = '1'; }
  const botSel = $('#bot-symbol');
  if (botSel && botSel.dataset.filled !== '1') { botSel.innerHTML = state.markets.map(optionHtml).join(''); botSel.dataset.filled = '1'; }
  renderMarketMenu();
}
function marketById(id) { return (state.markets || []).find(m => m.id === id) || null; }
function renderMarketMenu() {
  const menu = $('#market-menu');
  if (!menu) return;
  const groups = (state.marketGroups && state.marketGroups.length)
    ? state.marketGroups
    : [...new Set((state.markets || []).map(m => m.group))].map(g => ({ id: g, label: g, note: '' }));
  const fxOpen = (state.markets || []).filter(m => m.group === 'fx').every(m => m.open);
  const head = `<p class="market-note"><b>Forex &amp; metals:</b> ${fxOpen ? 'open' : 'closed'} now · <b>Volatility &amp; Boom/Crash:</b> open</p>`;
  menu.innerHTML = head + groups.map(g => {
    const items = (state.markets || []).filter(m => m.group === g.id);
    if (!items.length) return '';
    const note = g.note || (items[0] && items[0].groupNote) || '';
    return `<div class="mk-group"><div class="mk-group-head"><b>${esc(g.label)}</b><small>${esc(note)}</small></div><div class="mk-grid">` +
      items.map(m => `<button type="button" class="mk-item${m.open ? '' : ' closed'}" data-symbol="${esc(m.id)}" role="option" aria-selected="false">` +
        `<span><span class="mk-code">${esc(m.id)}</span><br><span class="mk-label">${esc(m.label || '')}</span></span>` +
        `<span class="mk-state ${m.open ? 'open' : 'closed'}">${m.open ? 'OPEN' : 'CLOSED'}</span></button>`).join('') +
      `</div></div>`;
  }).join('');
  menu.querySelectorAll('.mk-item').forEach(btn => btn.addEventListener('click', () => { setMarket(btn.dataset.symbol, true); closeMarketMenu(); }));
  syncMarketPicker();
}
function syncMarketPicker() {
  const sel = $('#bot-symbol');
  if (!sel) return;
  const m = marketById(sel.value) || (state.markets || [])[0] || { id: sel.value, label: '', open: true };
  const name = $('#mk-name'); if (name) name.textContent = m.label ? `${m.id} — ${m.label}` : m.id;
  const dot = $('#mk-dot'); if (dot) dot.classList.toggle('closed', !m.open);
  const badge = $('#mk-badge');
  if (badge) { badge.textContent = m.open ? 'OPEN' : 'CLOSED'; badge.className = `mk-badge ${m.open ? 'open' : 'closed'}`; }
  $$('#market-menu .mk-item').forEach(b => {
    const on = b.dataset.symbol === sel.value;
    b.classList.toggle('selected', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
}
function setMarket(id, commit) {
  const sel = $('#bot-symbol');
  if (!sel || !marketById(id)) return;
  sel.value = id;
  syncMarketPicker();
  if (commit) sel.dispatchEvent(new Event('change', { bubbles: true }));
}
function openMarketMenu() {
  const p = $('#market-picker'); if (!p) return;
  p.classList.add('open');
  const m = $('#market-menu'); if (m) m.classList.remove('hidden');
  const t = $('#market-trigger'); if (t) t.setAttribute('aria-expanded', 'true');
}
function closeMarketMenu() {
  const p = $('#market-picker'); if (!p) return;
  p.classList.remove('open');
  const m = $('#market-menu'); if (m) m.classList.add('hidden');
  const t = $('#market-trigger'); if (t) t.setAttribute('aria-expanded', 'false');
}

/* The client chooses the market. The bot recommends the pair with the firmest
   signals right now, so someone who does not know the markets can just accept it. */
async function loadPairPicker() {
  const sel = $('#bot-symbol'), hint = $('#best-pair-hint');
  if (!sel) return;
  try {
    const pick = await api('/api/market/best-pair');
    if (pick && pick.best && marketById(pick.best)) {
      state.bestPair = pick.best;
      if (hint) hint.textContent = `Bot suggests ${pick.best} — ${pick.note}`;
      // offer one-click acceptance without ever overriding a deliberate choice
      if (!sel.dataset.touched) sel.value = pick.best;
    } else if (hint) {
      hint.textContent = pick && pick.note ? pick.note : 'Any market is fine to start with.';
    }
  } catch (e) {
    if (hint) hint.textContent = 'You can trade any market.';
  }
  syncMarketPicker();
}
/* User manual: auto-shown once per client on first login, and re-openable any
   time from Platform settings or the Support centre without marking it seen. */
function showManualOverlay(markSeen) {
  const overlay = $('#manual-overlay');
  if (!overlay) return;
  const returnFocus = document.activeElement;
  overlay.classList.remove('hidden');
  updateOverlayState();
  $('#manual-title').focus();
  const ok = $('#manual-ok');
  if (ok) ok.onclick = async ev => {
    if (ev) ev.preventDefault();
    overlay.classList.add('hidden');
    updateOverlayState();
    if (returnFocus?.isConnected && returnFocus.getClientRects().length) returnFocus.focus();
    if (markSeen && state.user) {
      state.user.manualSeen = true;
      try { await api('/api/user/manual-seen', { method: 'POST' }); } catch (e) { /* non-critical */ }
    }
  };
}
function maybeShowManual() {
  if (!state.user || state.user.manualSeen) return;
  showManualOverlay(true);
}
function populateBotForm() {
  const b = state.bot, f = $('#quick-bot-form');
  ['lots', 'maxTrades', 'tp', 'sl', 'aggression', 'profitTarget', 'riskPerTrade', 'lockAfterR', 'trailAfterR', 'trailByR'].forEach(k => { if (f.elements[k]) f.elements[k].value = b[k]; });
  if (f.elements.strategy) f.elements.strategy.value = b.strategy || 'auto';
  if (f.elements.autoRisk) f.elements.autoRisk.checked = b.autoRisk !== false;
  if (f.elements.compoundProfits) f.elements.compoundProfits.checked = b.compoundProfits !== false;
  if (f.elements.maxLossPerTrade && b.maxLossPerTrade != null) f.elements.maxLossPerTrade.value = b.maxLossPerTrade;
  if (f.elements.dailyLossLimit && b.dailyLossLimit != null) f.elements.dailyLossLimit.value = b.dailyLossLimit;
  if (f.elements.lockInProfit) f.elements.lockInProfit.checked = b.lockInProfit !== false;
  f.elements.trailing.checked = !!b.trailing;
  // Reflect the saved preset without re-applying it over the loaded values.
  selectPreset(b.preset || 'safe', false);
  const balEl = f.elements.startBalance;
  if (balEl && !balEl.value && b.balance != null) balEl.value = Number(b.balance).toFixed(2);
  $('#aggression-output').value = `${b.aggression} / 10`;
  updateRange(); updateRiskUI(); updateRiskProfile(); state.formReady = true;
}
function updateRange() {
  const r = $('#aggression'), pct = ((r.value - 1) / 9) * 100;
  r.style.background = `linear-gradient(to right, var(--accent) 0 ${pct}%, rgba(255,255,255,.1) ${pct}%)`;
  $('#aggression-output').value = `${r.value} / 10`;
}

/* ---------------------------------------------------- strategy + risk UI */
const GRADE_LABELS = { experimental: 'RESEARCH ONLY', best: 'BEST', excellent: 'EXCELLENT', good: 'GOOD', average: 'AVERAGE', weak: 'WEAK' };
function strategyName(id) {
  const list = (state.config && state.config.engine && state.config.engine.strategies) || [];
  const hit = list.find(s => s.id === id);
  return hit ? hit.name : (id === 'auto' ? 'Auto' : id);
}
function renderStrategySelect() {
  const sel = $('#bot-strategy');
  if (!sel) return;
  const engine = (state.config && state.config.engine) || {};
  const list = engine.strategies || [];
  if (!list.length) return;
  const current = (state.bot && state.bot.strategy) || 'auto';
  const gradeLabel = s => GRADE_LABELS[s.grade] || '';
  sel.innerHTML = [
    `<option value="auto">Auto — paper training reference (${esc(strategyName(engine.defaultStrategy))})</option>`,
    ...list.map(s => {
      const rate = s.winRate == null ? '' : ` — ${(s.winRate * 100).toFixed(1)}% synthetic trend wins`;
      const grade = gradeLabel(s) ? ` [${gradeLabel(s)}]` : '';
      return `<option value="${esc(s.id)}">${esc(s.name)}${grade}${rate}</option>`;
    })
  ].join('');
  // The same grades, as coloured chips under the picker, so the ranking is obvious
  // before a client opens the dropdown.
  const strip = $('#strategy-grades');
  if (strip) {
    strip.innerHTML = list.map(s => {
      const g = s.grade || 'average';
      const win = s.winRate == null ? '—' : (s.winRate * 100).toFixed(1) + '%';
      return `<span class="grade-chip ${g}" title="${esc(s.tagline || '')} · ${esc(String(s.trades || 0))} synthetic trend trades">` +
        `<b>${esc(s.name)}</b><i>${esc(GRADE_LABELS[g] || g)}</i><em>${win} synthetic trend</em></span>`;
    }).join('');
  }
  sel.value = current;
  const hint = $('#strategy-hint');
  if (hint) {
    hint.textContent = current === 'auto'
      ? `Paper reference: ${strategyName(engine.defaultStrategy)}, chosen on synthetic training data only. No demonstrated live edge.`
      : 'Pinned paper research strategy. Synthetic trend win rates are not live forecasts; regime and cost results can be much worse.';
  }
}
const PRESETS = {
  safe: { label: 'Conservative', copy: 'Smallest planned risk. Stop fills and profits are not guaranteed.',
    riskPerTrade: 0.5, capPct: 0.5, dailyPct: 3, maxTrades: 1, aggression: 3, compoundProfits: true, autoRisk: true, lockInProfit: true, lockAfterR: 0.5, trailAfterR: 1, trailByR: 0.35 },
  balanced: { label: 'Balanced', copy: 'Two paper positions, subject to shared portfolio and daily budgets.',
    riskPerTrade: 1, capPct: 1, dailyPct: 3, maxTrades: 2, aggression: 5, compoundProfits: true, autoRisk: true, lockInProfit: true, lockAfterR: 0.5, trailAfterR: 1.3, trailByR: 0.4 },
  aggressive: { label: 'Aggressive', copy: 'More paper exposure, still capped at $1 planned risk per trade and $2 across open positions.',
    riskPerTrade: 1.5, capPct: 1.5, dailyPct: 3, maxTrades: 3, aggression: 7, compoundProfits: true, autoRisk: true, lockInProfit: true, lockAfterR: 0.6, trailAfterR: 1.6, trailByR: 0.5 }
};

// An estimate only: the server rechecks every queued fill, including original
// open-risk reservations, adverse marks and remaining UTC-day capacity.
function estimatePaperRisk(values) {
  const b = state.bot || {}, p = state.config?.engine?.riskPolicy || b.riskPolicy || {
    maxTradeRiskUsd: 1, maxTradeRiskPct: 1.5, maxOpenRiskUsd: 2,
    maxOpenRiskPct: 3, maxDailyLossPct: 3, maxDrawdownPct: 10
  };
  const fresh = !b.startedAt && !b.closedTrades && !b.profit && !(b.positions || []).length;
  const bal = Number(fresh ? values.startBalance || b.balance : b.balance);
  const anchor = fresh ? bal : Number(b.startBalance);
  const pct = Math.min(p.maxTradeRiskPct, Number(values.riskPerTrade) || 0.5);
  if (!(Number.isFinite(bal) && bal > 0 && Number.isFinite(anchor) && anchor > 0)) return { bal, pct, perTrade: 0, daily: 0, remaining: 0, policy: p };
  const compounding = values.compoundProfits !== false;
  const base = compounding ? bal : Math.min(bal, anchor);
  const scale = compounding ? bal / anchor : Math.min(1, bal / anchor);
  const today = new Date().toISOString().slice(0, 10), sameDay = !fresh && b.lossDay === today;
  const dayStart = sameDay ? Number(b.dayStartBalance) : bal;
  const rawDaily = Number(values.dailyLossLimit), rawCap = Number(values.maxLossPerTrade);
  const daily = Math.min(dayStart * p.maxDailyLossPct / 100, rawDaily > 0 ? rawDaily * dayStart / anchor : Infinity);
  const remaining = Math.max(0, daily + (sameDay ? Number(b.dayPnl) || Number(b.dayLoss) || 0 : 0));
  const reserved = fresh || b.openRiskCash === undefined ? 0 : Number.isFinite(b.openRiskCash) && b.openRiskCash >= 0 ? b.openRiskCash : Infinity;
  const headroom = fresh ? bal * p.maxDrawdownPct / 100 : b.riskStatus?.headroom ?? bal * p.maxDrawdownPct / 100;
  let perTrade = Math.max(0, Math.min(base * pct / 100, p.maxTradeRiskUsd,
    bal * p.maxTradeRiskPct / 100, rawCap > 0 ? rawCap * scale : Infinity,
    Math.min(p.maxOpenRiskUsd, bal * p.maxOpenRiskPct / 100) - reserved,
    remaining - reserved, headroom - reserved));
  if ((sameDay && b.dayLimitLatched) || b.riskStorageHealthy === false || b.riskStatus?.drawdownLatched ||
      b.riskStatus?.valid === false || Number(b.riskStatus?.pauseUntil) > Date.now()) perTrade = 0;
  return { bal, pct, perTrade: Number.isFinite(perTrade) ? perTrade : 0,
    daily: Number.isFinite(daily) ? daily : 0, remaining, policy: p };
}

function selectPreset(name, apply = true) {
  if (name === 'custom') { markCustomPreset(); return; }
  const p = state.config?.engine?.riskPresets?.[name] || PRESETS[name] || PRESETS.safe;
  $$('.preset-btn').forEach(b => b.classList.toggle('active', b.dataset.preset === name));
  const hidden = $('#preset-value'); if (hidden) hidden.value = name;
  const copy = $('#preset-copy'); if (copy) copy.textContent = p.copy;
  if (!apply) return;
  const form = $('#quick-bot-form'); if (!form) return;
  const el = form.elements;
  if (el.riskPerTrade) el.riskPerTrade.value = p.riskPerTrade;
  if (el.strategy) el.strategy.value = p.strategy || 'auto';
  for (const field of ['lockAfterR', 'trailAfterR', 'trailByR']) if (el[field]) el[field].value = p[field];
  for (const field of ['autoRisk', 'compoundProfits', 'lockInProfit', 'trailing']) if (el[field]) el[field].checked = p[field] !== false;
  const anchor = state.bot?.startedAt ? Number(state.bot.startBalance) : Number(el.startBalance?.value) || 100;
  if (el.maxLossPerTrade) el.maxLossPerTrade.value = Number((anchor * p.capPct / 100).toFixed(8));
  if (el.dailyLossLimit) el.dailyLossLimit.value = Number((anchor * p.dailyPct / 100).toFixed(8));
  if (el.maxTrades) el.maxTrades.value = p.maxTrades;
  if (el.aggression) el.aggression.value = p.aggression;
  updateRiskUI(); updateRiskProfile();
}
function markCustomPreset() {
  const input = $('#preset-value'); if (input) input.value = 'custom';
  $$('.preset-btn').forEach(b => b.classList.remove('active'));
  const copy = $('#preset-copy'); if (copy) copy.textContent = 'Custom paper settings. Edits affect new positions; existing exits keep their saved rules.';
}
$$('.preset-btn').forEach(btn => { btn.onclick = async () => {
  selectPreset(btn.dataset.preset);
  const saved = await saveBotSettings({ preset: btn.dataset.preset });
  if (saved) {
    populateBotForm();
    // A fresh browser-entered bankroll is not the server's seed balance yet.
    if (!state.bot?.startedAt) selectPreset(btn.dataset.preset);
    updateBot(saved.bot);
  } else if (state.bot) populateBotForm();
}; });

function riskCopy(pct) {
  const p = Math.min(1.5, Number(pct) || 0.5);
  return `${p}% requested planned stop risk, capped at $1 per trade, $2 total open risk and mandatory daily/drawdown guards. Gaps can exceed these planning limits.`;
}

function updateRiskUI() {
  const on = $('#quick-bot-form') && $('#quick-bot-form').elements.autoRisk.checked;
  const wrap = $('#risk-pct-wrap'), lots = $('#lots-input'), note = $('#lots-note');
  if (wrap) wrap.style.opacity = on ? '1' : '.45';
  if (lots) lots.disabled = !!on;
  if (note) note.textContent = on ? 'Ignored while risk-based sizing is on.' : 'A maximum lot size; the server reduces it to fit risk budgets.';
  const out = $('#risk-output'), range = $('#risk-per-trade');
  if (out && range) out.value = `${Number(range.value)}%`;
  const rn = $('#risk-note');
  if (rn && range) rn.textContent = riskCopy(range.value);
  const compound = $('#quick-bot-form')?.elements.compoundProfits;
  if (compound) compound.disabled = !on;
}
/* Balance detector. The client types — or we read — the money they actually
   trade with; the bot scales every limit and trade size to it. A small balance
   does not guarantee a small loss; stop gaps remain possible. */
function updateRiskProfile() {
  const box = $('#risk-profile'), form = $('#quick-bot-form'), input = $('#start-balance');
  if (!box || !input || !form) return;
  const fresh = !state.bot?.startedAt;
  const bal = fresh ? Number(input.value) : Number(state.bot.balance);
  if (!(bal > 0)) { box.classList.add('hidden'); return; }
  const el = form.elements, compounding = el.compoundProfits?.checked !== false;
  const estimate = estimatePaperRisk({ startBalance: bal, compoundProfits: compounding,
    riskPerTrade: el.riskPerTrade?.value, maxLossPerTrade: el.maxLossPerTrade?.value,
    dailyLossLimit: el.dailyLossLimit?.value });
  box.classList.remove('hidden');
  box.innerHTML = `<span class="rp-tier low">${bal < 25 ? 'MICRO PAPER BANKROLL' : 'PLANNED PAPER RISK'}</span>` +
    `<span class="rp-limits">${money(bal)} balance · planned stop risk ≤ ${money(estimate.perTrade)} per trade` +
    ` · daily net-loss budget ${money(estimate.daily)}. ` +
    `${el.autoRisk?.checked === false ? 'Fixed lot ceiling; risk budgets can reduce size.' : compounding ? 'Size scales only until the hard cash ceilings.' : 'Growth compounding is off; size still shrinks after losses.'} ` +
    `Mandatory $1/trade, $2 open-risk and 3%/UTC-day ceilings; 10% drawdown stop. Gaps can exceed budgets.</span>`;
}

/* Balance detector.

   The client should not have to know their balance or type it — we read it from
   the linked Deriv account automatically. The account that matches the mode in
   use wins (real → real balance, demo/sim → practice balance), falling back to
   whichever balance is known. A manual edit still wins until "Use linked
   balance" or a refresh asks us to read it again. A small balance counts as a
   starting paper balance, not a guarantee of maximum loss. */
function autoDetectBalance(force) {
  const input = $('#start-balance');
  if (!input) return 0;
  if (input.dataset.touched && !force) return Number(input.value) || 0;
  const d = state.user && state.user.deriv;
  if (!d) return 0;
  const list = Array.isArray(d.accounts) ? d.accounts : [];
  const acct = list.find(a => a.loginid === d.loginid);
  const raw = acct && acct.balance != null ? acct.balance : d.balance;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  input.value = n.toFixed(2);
  input.classList.add('auto');
  const preset = $('#preset-value')?.value;
  if (!state.bot?.startedAt && PRESETS[preset]) selectPreset(preset);
  updateRiskProfile();
  return Number(input.value);
}
function useLinkedBalance() {
  const input = $('#start-balance');
  if (input) delete input.dataset.touched;
  const bal = autoDetectBalance(true);
  if (bal > 0) toast(`Balance ${money(bal)} read from your linked Deriv account.`, 'success');
  else toast('No linked balance yet — connect Deriv in the wallet, or type your balance.', 'info');
}
async function saveBotSettings(patch) {
  try {
    const data = await api('/api/bot/settings', { method: 'POST', body: patch });
    state.bot = data.bot;
    if (typeof data.bot.strategy === 'string' && $('#bot-strategy')) $('#bot-strategy').value = data.bot.strategy;
    return data;
  } catch (e) { toast(e.message, 'error'); return null; }
}
async function resyncEngine(mode) {
  const btn = $('#refresh-engine');
  setBusy(btn, true, 'Refreshing…');
  try {
    const data = await api('/api/bot/refresh', { method: 'POST', body: { mode: mode || 'soft' } });
    state.bot = data.bot;
    if (data.deriv && state.user) { state.user.deriv = data.deriv; renderWallet(); }
    updateBot(data.bot);
    const r = data.report || {};
    toast(r.advice || 'Engine refreshed.', 'success');
    pollBot();
  } catch (e) { toast(e.message, 'error'); }
  finally { setBusy(btn, false); }
}

function applyMaintenance(config) {
  const lock = $('#maintenance-lock');
  if (!lock) return;
  const m = (config && config.maintenance) || {};
  const frozen = !!m.enabled && !m.adminBypass && state.user && state.user.role !== 'admin';
  lock.classList.toggle('hidden', !frozen);
  if (!frozen) return;
  document.body.classList.add('is-locked');
  if (m.message) $('#maintenance-lock-copy').textContent = m.message;
  $('#maintenance-lock-meta').innerHTML = [
    m.version ? `<span>VERSION <b>v${esc(m.version)}</b></span>` : '',
    m.startedAt ? `<span>STARTED <b>${date(m.startedAt)}</b></span>` : '',
    m.notes ? `<span class="wide">${esc(String(m.notes).slice(0, 240))}</span>` : ''
  ].filter(Boolean).join('');
  // A frozen client must not sit on a stale bot screen.
  stopPolling();
}
function renderDerivSetup(config) {
  const connection = config.derivConnection || {}, box = $('#deriv-setup-status');
  const oauthButton = $('#deriv-signin'), patButton = $('#deriv-pat-signin');
  if (oauthButton) oauthButton.disabled = !connection.oauthEnabled;
  if (patButton) patButton.disabled = !connection.patEnabled;
  if (box) {
    const problem = (connection.setupRequired || [])[0];
    box.textContent = problem ? (errorMessages[problem] || 'Administrator connection setup is incomplete.')
      : connection.credentialStorage === 'development-plaintext'
        ? 'Development mode: no token encryption. Use test credentials only.'
        : 'Deriv account access is configured. Real-money execution is still disabled.';
    box.classList.toggle('warn', !!problem || connection.credentialStorage === 'development-plaintext');
  }
}
async function loadPublicConfig() {
  try {
    const config = await api('/api/config/public'); state.config = config; renderDerivSetup(config);
    $('#app-version').textContent = config.version;
    updateFeed(config.derivStatus, config.derivLastError);
    if (state.view === 'engine') renderEngine(config.engine);
    renderStrategySelect();
    applyMaintenance(config);
    renderSupportCard(config.support);
  } catch (e) { /* keep the last good status */ }
}
/* Support details are owner-editable, so every surface that shows them is filled
   from config rather than hard-coded. Pass either the public `support` shape or
   an admin `profile` shape. */
function renderSupportCard(src) {
  const s = src || (state.config && state.config.support) || {};
  const phone = s.phone || s.supportPhone || '081 609 0300';
  const email = s.email || s.supportEmail || 'ricardohaindaka2006@gmail.com';
  const web = s.website || 'https://rhpilot.com';
  const webLabel = String(web).replace(/^https?:\/\//, '').replace(/\/$/, '');
  const digits = v => String(v || '').replace(/[^0-9+]/g, '');
  const pl = $('#support-phone-link'); if (pl) { pl.textContent = phone; pl.href = 'tel:' + digits(phone); }
  const el = $('#support-email-link'); if (el) { el.textContent = email; el.href = 'mailto:' + email; }
  const wl = $('#support-web-link'); if (wl) { wl.textContent = webLabel; wl.href = web; }
  const row = $('#support-assistant-row'), al = $('#support-assistant-link'), a = s.assistantPhone || '';
  if (row && al) { row.classList.toggle('hidden', !a); if (a) { al.textContent = a; al.href = 'tel:' + digits(a); } }
  const summary = $('#support-line-summary'); if (summary) summary.textContent = `Support: ${phone} · ${webLabel}`;
}
function updateFeed(status, error) {
  const live = status === 'live', connecting = status === 'connecting';
  const badge = $('#feed-badge'); badge.className = `feed-badge ${live ? 'live' : connecting ? 'connecting' : 'offline'}`;
  $('b', badge).textContent = live ? 'LIVE MARKET' : connecting ? 'CONNECTING' : 'SIMULATOR';
  $('small', badge).textContent = live ? 'Deriv market feed' : connecting ? 'Deriv market feed' : 'Deriv offline · fallback active';
  $('#side-feed-dot').className = `status-dot ${live ? '' : 'warn'}`;
  $('#side-feed-title').textContent = live ? 'Deriv connected' : 'Simulator active';
  $('#side-feed-copy').textContent = live ? 'Real-time Deriv ticks' : (error || 'Automatic fallback · reconnecting').slice(0, 65);
}
async function pollBot() {
  if (!state.user) return;
  try {
    const data = await api('/api/bot/state');
    const previousSymbol = state.bot?.symbol;
    state.bot = Object.assign(data.bot, { simulation: data.simulation }); updateBot(state.bot);
    if (data.bot.symbol !== previousSymbol && document.activeElement !== $('#symbol-select')) {
      state.symbol = data.bot.symbol; $('#symbol-select').value = state.symbol; connectStream();
    }
    if (data.bot.symbol === state.symbol) renderSignal(data.signal);
    if (state.view === 'wallet' || state.user.mt5?.mode === 'demo') await loadMt5();
  } catch (e) { if (e.status === 401) showAuth(); }
}
function renderRiskGuardStatus(b) {
  const box = $('#risk-guard-status'); if (!box) return;
  const r = b.riskStatus || {};
  let copy;
  if (b.riskStorageHealthy === false) copy = 'RISK STOP: state storage unavailable. New entries are blocked; recover storage and restart manually.';
  else if (r.drawdownLatched) copy = 'RISK STOP: 10% account drawdown rail reached. No automatic reset, including after a new day. Review the paper ledger; gaps can exceed this rail.';
  else if (r.valid === false) copy = 'RISK STOP: paper equity or exposure cannot be validated. New entries are blocked; review the ledger.';
  else if (b.dayLimitLatched && b.lossDay === new Date().toISOString().slice(0, 10)) copy = 'DAILY STOP: net-loss budget reached. Restarting or changing presets cannot clear it. Eligible again next UTC day, subject to other guards.';
  else if (r.pauseUntil > Date.now()) copy = `LOSS PAUSE: ${Math.ceil((r.pauseUntil - Date.now()) / 1000)} seconds remaining after consecutive losses. Existing exits stay managed.`;
  else copy = 'Risk rails active: $1 planned/trade · $2 total open risk · 3%/UTC day · 10% drawdown stop. Three consecutive losses pause entries for 5 minutes. No daily trade-count or default profit ceiling; safety pauses and market hours still apply.';
  if (box.textContent !== copy) box.textContent = copy;
}
function updateBot(b) {
  if (!b) return;
  renderRiskGuardStatus(b);
  const trades = b.trades || [];
  const closed = Math.max(b.closedTrades || 0, trades.length);
  const wins = closed ? (b.closedWins ?? trades.filter(t => t.pnl > 0).length) : 0;
  const safetyNote = $('#engine-safety-note');
  if (safetyNote) safetyNote.textContent = b.reconciliationRequired
    ? 'Broker reconciliation required. Existing contract records are preserved, not confirmed closed. Check your Deriv statement; new orders are blocked.'
    : (b.performanceWarning ? b.performanceWarning + ' ' : '') + 'Paper execution only. Live orders are disabled pending broker settlement tracking. Stops and synthetic results do not guarantee profits.';
  $('#stat-balance').textContent = money(b.balance);
  $('#stat-balance').classList.toggle('long-value', $('#stat-balance').textContent.length > 9);
  $('#stat-profit').textContent = money(b.profit);
  $('#stat-profit').className = b.profit > 0 ? 'positive' : b.profit < 0 ? 'negative' : '';
  $('#stat-profit').classList.toggle('long-value', $('#stat-profit').textContent.length > 9);
  $('#stat-peak').textContent = `All-time peak ${money(b.peakProfit)}`;
  /* A live cue so the client can see the money growing, or not, at a glance. */
  const trend = $('#stat-trend'), picon = $('#stat-profit-icon');
  const prev = state.lastProfit;
  if (trend) {
    if (prev == null) { trend.className = 'stat-trend flat'; trend.textContent = b.running ? 'Tracking paper P/L' : 'Waiting for the first trade…'; }
    else {
      const delta = Number(b.profit) - Number(prev);
      if (delta > 0.005) {
        trend.className = 'stat-trend up pop';
        trend.textContent = `Money increasing · +${money(delta)} this update`;
        setTimeout(() => trend.classList.remove('pop'), 700);
      } else if (delta < -0.005) {
        trend.className = 'stat-trend down';
        trend.textContent = `Down ${money(delta)} this update`;
      } else {
        trend.className = 'stat-trend flat';
        trend.textContent = 'Holding steady';
      }
    }
  }
  if (picon) {
    picon.className = `stat-icon ${b.profit > 0 ? 'up' : b.profit < 0 ? 'down' : ''}`;
    picon.textContent = b.profit > 0 ? '↗' : b.profit < 0 ? '↘' : '•';
  }
  state.lastProfit = b.profit;
  $('#stat-winrate').textContent = closed ? `${(wins / closed * 100).toFixed(1)}%` : '—';
  $('#stat-trades').textContent = `${closed} closed trade${closed === 1 ? '' : 's'} · ${wins} wins`;
  $('#stat-engine').textContent = b.running
    ? (b.live ? 'Deriv live' : (b.simulation && !b.simulation.warmedUp ? `Warming ${b.simulation.ticks}/${b.simulation.warmup}` : (b.simulation && !b.simulation.signalReady ? 'Scanning simulation' : 'Springboks active')))
    : b.targetHit ? 'Target reached' : 'Standby';
  $('#stat-engine-dot').className = `status-dot ${b.running ? '' : b.targetHit ? 'warn' : 'off'}`;
  $('#stat-positions').textContent = `${b.positions.length} open position${b.positions.length === 1 ? '' : 's'} · ${b.symbol}`;
  $('#nav-running').classList.toggle('hidden', !b.running);
  $('#bot-status-badge').textContent = b.running ? 'RUNNING' : b.targetHit ? 'TARGET HIT' : 'STOPPED';
  $('#bot-status-badge').classList.toggle('running', !!b.running);
  /* Keep the hero button and the running class in step, so the gold Trade button
     and the red Stop button never both show and never both hide. */
  const actions = document.querySelector('.bot-actions');
  if (actions) actions.classList.toggle('running', !!b.running);
  $('#start-bot').classList.toggle('hidden', !!b.running);
  $('#stop-bot').classList.toggle('hidden', !b.running);
  /* The overview Start button doubles as the Stop button: while the engine runs
     it flips to Stop, so one control always governs the whole operation. */
  const heroStart = $('#hero-start'), heroStop = $('#hero-stop');
  if (heroStart) heroStart.classList.toggle('hidden', !!b.running);
  if (heroStop) heroStop.classList.toggle('hidden', !b.running);
  $('#desk-open').textContent = `${b.positions.length} / ${b.maxTrades}`;
  $('#desk-profit').textContent = money(b.profit);
  $('#desk-profit').className = b.profit > 0 ? 'positive' : b.profit < 0 ? 'negative' : '';
  $('#desk-mode').textContent = b.live ? 'DERIV LIVE' : 'SIMULATED';
  $('#desk-mode').className = b.live ? 'negative' : 'positive';
  $('#history-count').textContent = `${trades.length} TRADES`;
  $('#live-stake').value = b.liveStake || 1;
  if ($('#live-confirm-wrap').classList.contains('hidden')) $('#live-toggle').checked = !!b.live;
  updateExecutionMode(); renderTrades(trades); renderPositions(b.positions || []);
  const target = Number(b.profitTarget) || 0;
  $('#target-progress').classList.toggle('hidden', !target);
  if (target) {
    $('#target-copy').textContent = `${money(b.profit)} / ${money(target)}`;
    $('#target-bar').style.width = `${Math.max(0, Math.min(100, b.profit / target * 100))}%`;
  }
}
function renderSignal(signal) {
  if (!signal || !signal.votes) {
    $('#desk-signal').textContent = 'Warming up';
    return;
  }
  const names = ['trend', 'momentum', 'breakout', 'reversal'];
  $$('#signal-strip > div').forEach((el, i) => {
    const vote = signal.votes[names[i]], b = $('b', el);
    b.textContent = vote > 0 ? 'BUY' : vote < 0 ? 'SELL' : 'FLAT';
    b.className = vote > 0 ? 'buy' : vote < 0 ? 'sell' : '';
  });
  const entry = Number(signal.entry) || 0;
  $('#desk-signal').textContent = Math.abs(entry) < 1 ? 'Neutral' : `${entry > 0 ? 'Bullish' : 'Bearish'} ${Math.abs(entry).toFixed(1)}`;
  $('#desk-signal').className = entry > 0 ? 'positive' : entry < 0 ? 'negative' : '';
}
function tradeRow(t, full = false) {
  const side = `<span class="side-tag ${t.dir.toLowerCase()}">${t.dir}</span>`;
  const pnl = `<b class="${t.pnl > 0 ? 'positive' : 'negative'}">${money(t.pnl)}</b>`;
  if (full) return `<tr><td>${time(t.at)}</td><td><b>${esc(t.symbol)}</b></td><td>${side}</td><td>${t.lots}</td><td>${price(t.entry)}</td><td>${price(t.exit)}</td><td>${pnl}</td><td class="reason">${esc(t.cause.replaceAll('-', ' '))}</td></tr>`;
  return `<tr><td>${time(t.at)}</td><td><b>${esc(t.symbol)}</b></td><td>${side}</td><td>${price(t.entry)} <span class="muted">→</span> ${price(t.exit)}</td><td>${pnl}</td><td class="reason">${esc(t.cause.replaceAll('-', ' '))}</td></tr>`;
}
function renderTrades(trades) {
  $('#recent-trades').innerHTML = trades.slice(0, 6).map(t => tradeRow(t)).join('');
  $('#all-trades-table').innerHTML = trades.map(t => tradeRow(t, true)).join('');
  $('#trades-empty').classList.toggle('hidden', trades.length > 0);
}
function renderPositions(positions) {
  $('#positions-table').innerHTML = positions.map(p => `<tr><td>${time(p.at)}</td><td><b>${esc(state.bot.symbol)}</b></td><td><span class="side-tag ${p.dir.toLowerCase()}">${p.dir}</span></td><td>${p.lots}</td><td>${price(p.entry)}</td><td>${Number(p.score || 0).toFixed(2)}</td><td><span class="tag ${p.contractId ? 'live' : ''}">${p.reconciliationRequired || p.contractId || p.livePending ? 'BROKER RECONCILE' : 'PAPER'}</span></td></tr>`).join('');
  $('#positions-empty').classList.toggle('hidden', positions.length > 0);
}

function connectStream() {
  if (state.stream) state.stream.close();
  state.chart = []; state.firstPrice = null;
  $('#current-price').textContent = '—';
  const stream = new EventSource(`/api/market/stream?symbol=${encodeURIComponent(state.symbol)}`);
  state.stream = stream;
  stream.onmessage = event => {
    if (state.symbol !== JSON.parse(event.data).symbol) return;
    const tick = JSON.parse(event.data), value = Number(tick.price);
    if (!Number.isFinite(value)) return;
    if (state.firstPrice == null) state.firstPrice = value;
    state.chart.push({ price: value, at: Date.now() }); if (state.chart.length > 120) state.chart.shift();
    $('#current-price').textContent = price(value);
    const change = state.firstPrice ? (value - state.firstPrice) / state.firstPrice * 100 : 0;
    $('#price-change').textContent = `${change >= 0 ? '+' : ''}${change.toFixed(3)}%`;
    $('#price-change').className = change >= 0 ? 'positive' : 'negative';
    $('#chart-source').textContent = tick.source === 'live' ? 'DERIV LIVE' : 'SIM';
    $('#chart-source').className = `tag ${tick.source === 'live' ? 'live' : ''}`;
    $('#last-tick').textContent = `${time(tick.epoch * 1000)} · ${tick.latency != null ? tick.latency + ' ms latency' : 'local fallback'}`;
    drawChart();
  };
  stream.onerror = () => { $('#last-tick').textContent = 'Reconnecting stream…'; };
}
function drawChart() {
  const canvas = $('#price-chart');
  if (!canvas || state.chart.length < 2) return;
  const rect = canvas.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
  const w = Math.round(rect.width * dpr), h = Math.round(rect.height * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = rect.width, H = rect.height, pad = { top: 22, right: 10, bottom: 15, left: 5 };
  const values = state.chart.map(x => x.price), min0 = Math.min(...values), max0 = Math.max(...values);
  const margin = Math.max((max0 - min0) * .15, max0 * .00003), min = min0 - margin, max = max0 + margin;
  const x = i => pad.left + i / (values.length - 1) * (W - pad.left - pad.right);
  const y = v => pad.top + (max - v) / (max - min || 1) * (H - pad.top - pad.bottom);
  const rising = values[values.length - 1] >= values[0], color = rising ? '#b1dda3' : '#ffb1a2';
  ctx.clearRect(0, 0, W, H);
  const gradient = ctx.createLinearGradient(0, pad.top, 0, H);
  gradient.addColorStop(0, rising ? 'rgba(177,221,163,.20)' : 'rgba(255,177,162,.18)'); gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.beginPath(); ctx.moveTo(x(0), H - pad.bottom);
  values.forEach((v, i) => ctx.lineTo(x(i), y(v)));
  ctx.lineTo(x(values.length - 1), H - pad.bottom); ctx.closePath(); ctx.fillStyle = gradient; ctx.fill();
  ctx.beginPath(); values.forEach((v, i) => i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)));
  ctx.strokeStyle = color; ctx.lineWidth = 1.7; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.shadowColor = rising ? 'rgba(177,221,163,.25)' : 'rgba(255,177,162,.25)'; ctx.shadowBlur = 8; ctx.stroke(); ctx.shadowBlur = 0;
  const lx = x(values.length - 1), ly = y(values[values.length - 1]);
  ctx.beginPath(); ctx.arc(lx, ly, 3.2, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
  ctx.beginPath(); ctx.arc(lx, ly, 7, 0, Math.PI * 2); ctx.fillStyle = rising ? 'rgba(177,221,163,.12)' : 'rgba(255,177,162,.12)'; ctx.fill();
}

async function loadDesk() {
  try {
    const data = await api('/api/market/desk'); state.desk = data;
    $('#advisor-list').innerHTML = data.advisor.slice(0, 10).map(r => `<div class="advisor-row"><span class="advisor-rank">${String(r.rank).padStart(2, '0')}</span><div class="advisor-symbol"><b>${r.symbol}</b><small>${r.verdict.replace('-', ' ')}</small></div><div class="advisor-price">${price(r.price)}</div><div class="advisor-change ${r.changePct >= 0 ? 'positive' : 'negative'}">${r.changePct >= 0 ? '+' : ''}${r.changePct.toFixed(3)}%</div><div class="activity-track"><i style="width:${Math.min(100, r.score * 3 + 5)}%"></i></div></div>`).join('');
    $('#calendar-list').innerHTML = data.events.length ? data.events.map(e => {
      const d = new Date(e.date);
      return `<div class="calendar-item"><div class="calendar-date"><b>${d.getDate()}</b><span>${d.toLocaleDateString([], { month: 'short' })}</span></div><div class="calendar-copy"><b><i class="impact ${e.impact}"></i>${esc(e.title)}</b><small>${esc(e.time)} · ${esc(e.country)}<br>${esc(e.note)}</small></div></div>`;
    }).join('') : '<div class="empty-state compact"><b>No upcoming events</b></div>';
    $('#news-list').innerHTML = data.news.length ? data.news.map(n => `<div class="news-item"><h4><i class="impact ${n.impact}"></i>${esc(n.title)}</h4><p>${esc(n.body)}</p><small>${new Date(n.at).toLocaleString()}</small></div>`).join('') : '<div class="empty-state compact"><b>No desk reports yet</b><p>Administrator market updates will be published here.</p></div>';
  } catch (e) { toast(e.message, 'error'); }
}
function navigate(view) {
  if (!viewMeta[view] || (['users', 'settings'].includes(view) && state.user?.role !== 'admin')) return;
  state.view = view;
  $$('.view').forEach(el => el.classList.toggle('active', el.id === `view-${view}`));
  $$('.nav-item').forEach(el => {
    const active = el.dataset.view === view;
    el.classList.toggle('active', active);
    if (active) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
  });
  $('#page-title').textContent = viewMeta[view][0]; $('#page-subtitle').textContent = viewMeta[view][1];
  setSidebarOpen(false);
  $('#main-content').focus({ preventScroll: true });
  if (view === 'markets') loadDesk();
  if (view === 'users') loadAdminUsers();
  if (view === 'engine' && state.user?.role === 'admin') loadEngine();
  if (view === 'settings') loadSettings();
  if (view === 'wallet') loadMt5();
  window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

function renderWallet() {
  if (!state.user) return;
  const d = state.user.deriv;
  $('#wallet-disconnected').classList.toggle('hidden', !!d);
  $('#wallet-connected').classList.toggle('hidden', !d);
  $('#wallet-link-status').textContent = d ? 'CONNECTED' : 'NOT LINKED';
  $('#wallet-link-status').classList.toggle('running', !!d);
  if (d) {
    $('#deriv-balance').textContent = d.balance == null ? 'Balance unavailable' : money(d.balance, d.currency);
    $('#deriv-login').textContent = d.loginid;
    /* Both balances are shown side by side so the client can always see whether
       they are trading practice funds or real money before pressing start. */
    const demoEl = $('#demo-balance'), realEl = $('#real-balance');
    if (demoEl && realEl) {
      if (d.isVirtual) {
        demoEl.textContent = d.balance == null ? '—' : money(d.balance, d.currency);
        realEl.textContent = 'Not linked';
        $('#real-badge').textContent = 'DEMO ONLY';
      } else {
        realEl.textContent = d.balance == null ? '—' : money(d.balance, d.currency);
        demoEl.textContent = 'Not linked';
        $('#real-badge').textContent = 'LIVE';
      }
    }
    $('#deriv-type').textContent = d.isVirtual ? 'DEMO' : 'REAL';
    $('#deriv-type').className = d.isVirtual ? 'positive' : 'negative';
    $('#deriv-currency').textContent = d.currency || 'USD';
    $('#deriv-via').textContent = String(d.via || 'token').toUpperCase();
    const c = state.user.cashier || {};
    const links = $$('#cashier-links a');
    ['deposit', 'withdraw', 'transfer', 'statement'].forEach((k, i) => { if (c[k]) links[i].href = c[k]; });
  }
  renderAccountChoice();
  renderAccountBar();
  autoDetectBalance();
  checkDerivHealth(true);
  updateExecutionMode();
}
function updateExecutionMode() {
  const reconcile = !!state.bot?.reconciliationRequired;
  $('#execution-mode-title').textContent = reconcile ? 'BROKER REVIEW REQUIRED' : 'PAPER SIMULATION';
  $('#execution-mode-title').className = reconcile ? 'negative' : 'positive';
  $('#execution-mode-copy').textContent = reconcile
    ? 'Legacy contract records are preserved. Check the Deriv statement for actual settlement.'
    : 'No real-money orders. Live execution is blocked until broker settlement and recovery are implemented and demo-tested.';
  $('#mode-dot').className = `status-dot ${reconcile ? 'warn' : ''}`;
  $('#live-toggle').checked = false;
  $('#live-toggle').disabled = true;
  $('#live-stake').disabled = true;
  $('#confirm-live').disabled = true;
}

function syncBoardControls(config) {
  const frozen = !!(config.maintenance && config.maintenance.enabled);
  const free = !config.licenseRequired;
  state.board = { frozen, free };
  const mt = $('#board-maintenance'), fr = $('#board-free'), st = $('#board-state');
  if (mt) mt.checked = frozen;
  if (fr) fr.checked = free;
  if (st) {
    st.textContent = frozen ? 'MAINTENANCE' : 'LIVE';
    st.className = 'tag ' + (frozen ? 'warn' : 'live');
  }
  renderFootprint();
  syncAccessControls();
}
/* The Users & licenses screen carries its own copy of the two master switches so
   the admin can open the doors (free for everyone) or freeze the board without
   hunting through Platform settings. Both stay in lock-step with state.board. */
function syncAccessControls() {
  const { frozen, free } = state.board;
  const fr = $('#access-free'), mt = $('#access-maintenance'), st = $('#access-state'), note = $('#access-note');
  if (fr) fr.checked = free;
  if (mt) mt.checked = frozen;
  if (st) { st.textContent = frozen ? 'MAINTENANCE' : 'LIVE'; st.className = 'tag ' + (frozen ? 'warn' : 'live'); }
  if (note) {
    note.classList.toggle('success', !frozen && free);
    note.textContent = frozen
      ? 'Maintenance is ON — every client bot is frozen and every trade action is refused until you switch it off and finish the update. Your admin access stays open.'
      : free
        ? 'Free mode is ON — anyone with a Deriv login can use the bot without a license key. Switch it off to require keys again; every client is signed out.'
        : 'Keys are required — clients need a valid license key to sign in and trade. Switch on “Free for everyone” to open the platform to everyone.';
  }
}
async function renderFootprint() {
  const box = $('#board-footprint');
  if (!box) return;
  try {
    const h = await api('/api/health');
    const m = h.memory || {};
    box.innerHTML = [
      `<span>MEMORY RSS <b>${m.rssMb ?? '—'} / ${m.limitMb ?? '—'} MiB</b></span>`,
      `<span>APP DATA <b>${((h.storage?.bytes || 0) / 1048576).toFixed(2)} / ${((h.storage?.limitBytes || 0) / 1048576).toFixed(0)} MiB</b></span>`,
      `<span>STORAGE <b>${h.storage?.durable ? 'POSTGRES' : 'EPHEMERAL / LOCAL'}</b></span>`,
      `<span>SNAPSHOTS <b>${h.storage?.backupCount || 0} / ${h.storage?.backupCountLimit || 3}</b></span>`,
      `<span>USED <b>${m.pct ?? '—'}%</b></span>`,
      `<span>UPTIME <b>${Math.round((h.uptime || 0) / 60)}m</b></span>`,
      `<span>FEED <b>${h.deriv && h.deriv.live ? 'DERIV LIVE' : 'SIMULATOR'}</b></span>`,
      `<span>ENGINE <b>${esc((h.engine && h.engine.defaultStrategy) || '—')}</b></span>`
    ].join('');
  } catch (e) { box.textContent = 'Footprint unavailable.'; }
}
async function applyAccessState(wantFrozen, wantFree) {
  const isFrozen = state.board.frozen;
  const isFree = state.board.free;
  const cfg = state.config || {};
  try {
    if (wantFrozen !== isFrozen) {
      if (wantFrozen && !confirm('Take the board down for clients? Their bots are flattened and every trade action is refused until you switch it back on.')) { syncAccessControls(); return; }
      const r = await api('/api/admin/maintenance', { method: 'PUT', body: { enabled: wantFrozen, message: wantFrozen ? 'We are upgrading the Springbok engine. Trading is paused for a short while.' : '', version: cfg.version } });
      toast(wantFrozen ? `Board frozen — ${r.stopped || 0} client bot(s) stopped.` : 'Board live again.', wantFrozen ? 'warn' : 'success', 6000);
    }
    if (wantFree !== isFree) {
      if (!wantFree && !confirm('Require license keys again? Every client is signed out until you send them a key.')) { syncAccessControls(); return; }
      const r = await api('/api/admin/license-required', { method: 'PUT', body: { required: !wantFree } });
      toast(wantFree ? 'Free mode on — anyone can try the bot.' : `Keys required — ${r.loggedOut || 0} client session(s) ended.`, wantFree ? 'success' : 'warn', 6000);
    }
    await loadPublicConfig();
    await loadSettings();
    if (state.view === 'users') await loadAdminUsers();
  } catch (e) { toast(e.message, 'error'); syncAccessControls(); }
}
function applyBoardState() { return applyAccessState($('#board-maintenance').checked, $('#board-free').checked); }
$('#board-save').onclick = applyBoardState;
$('#access-apply').onclick = () => applyAccessState($('#access-maintenance').checked, $('#access-free').checked);
$('#board-lockdown').onclick = async () => {
  if (!confirm('Lock down now? Every unused key is revoked, every client is signed out and their bots stopped. You keep access.')) return;
  try {
    const r = await api('/api/admin/license-lockdown', { method: 'POST' });
    toast(`Locked down: ${r.revoked} key(s) revoked, ${r.loggedOut} session(s) ended, ${r.botsStopped} bot(s) stopped.`, 'warn', 7000);
    await loadAdminConfig(); await loadPublicConfig();
  } catch (e) { toast(e.message, 'error'); }
};
async function loadAdminUsers() {
  try {
    const [users, licenses, stats, cfg] = await Promise.all([api('/api/admin/users'), api('/api/admin/licenses'), api('/api/admin/stats'), api('/api/admin/config')]);
    if (cfg && cfg.config) syncBoardControls(cfg.config);
    $('#admin-stats').innerHTML = [['TOTAL USERS', stats.users], ['ONLINE NOW', stats.online], ['PAID CLIENTS', stats.paid], ['BOTS RUNNING', stats.running]].map(x => `<div><span>${x[0]}</span><b>${x[1]}</b></div>`).join('');
    $('#user-count').textContent = `${users.users.length} USERS`;
    $('#users-table').innerHTML = users.users.map(u => `<tr><td><div class="user-email"><span class="avatar">${esc(u.email[0].toUpperCase())}</span><div><b>${esc(u.email)}</b><small>${u.online ? '<i class="online-dot"></i>Online' : 'Offline'}</small></div></div></td><td>${esc(u.role.toUpperCase())}</td><td><span class="tag ${u.active ? 'live' : ''}">${u.active ? 'ACTIVE' : 'DISABLED'}</span></td><td><span class="tag ${u.paid ? 'live' : ''}">${u.paid ? 'ALLOWED' : 'RESTRICTED'}</span></td><td>${u.running ? '<span class="positive">RUNNING</span>' : 'Stopped'}<br><small>${esc(u.symbol)}${u.live ? ' · LIVE' : ''}</small></td><td class="${u.profit > 0 ? 'positive' : u.profit < 0 ? 'negative' : ''}">${money(u.profit)}</td><td>${u.role === 'admin' ? '<span class="muted">Protected</span>' : `<div class="row-actions"><button data-user-pay="${u.id}" data-paid="${!u.paid}">${u.paid ? 'Restrict' : 'Allow'}</button><button data-user-active="${u.id}" data-active="${!u.active}">${u.active ? 'Disable' : 'Enable'}</button><button class="danger" data-user-delete="${u.id}">Delete</button></div>`}</td></tr>`).join('');
    $('#license-required').checked = licenses.required;
    renderLicenseMode(licenses.required);
    $('#licenses-table').innerHTML = licenses.licenses.map(l => `<tr><td><span class="license-key" title="Click to copy" data-copy="${esc(l.key)}">${esc(l.key)}</span></td><td><b>${esc((l.plan || 'days30').toUpperCase())}</b></td><td>${esc(l.label || l.email || '—')}</td><td><span class="tag ${l.status === 'active' ? 'live' : ''}">${esc(l.status.toUpperCase())}</span></td><td>${esc(l.boundEmail || '—')}</td><td>${l.expiresAt ? date(l.expiresAt) : l.plan === 'lifetime' ? 'Lifetime' : 'On redemption'}</td><td><div class="row-actions"><button data-license-status="${l.id}" data-status="${l.status === 'revoked' ? 'active' : 'revoked'}">${l.status === 'revoked' ? 'Restore' : 'Revoke'}</button>${!l.boundUserId ? `<button class="danger" data-license-delete="${l.id}">Delete</button>` : ''}</div></td></tr>`).join('');
    $('#licenses-empty').classList.toggle('hidden', licenses.licenses.length > 0);
  } catch (e) { toast(e.message, 'error'); }
}
const loadLicenses = loadAdminUsers;
async function loadEngine() {
  try {
    const data = await api('/api/admin/engine'); renderEngine(data);
  } catch (e) { toast(e.message, 'error'); }
}
function renderEngine(engine) {
  if (!engine) return;
  $('#weights-list').innerHTML = Object.entries(engine.weights).map(([k, v]) => `<div class="weight-row"><div><span>${k}</span><b>${Number(v).toFixed(2)}×</b></div><div class="weight-track"><i style="width:${Math.min(100, Number(v) / 2.5 * 100)}%"></i></div></div>`).join('');
  const s = engine.stats, decided = (s.wins || 0) + (s.losses || 0);
  $('#engine-stats').innerHTML = [['EVALUATIONS', (s.scored || 0).toLocaleString()], ['LEARNED TRADES', decided], ['WINNING LABELS', s.wins || 0], ['LOSING LABELS', s.losses || 0]].map(x => `<div><span>${x[0]}</span><b>${x[1]}</b></div>`).join('');
}
const loadAdminConfig = loadSettings;
async function loadSettings() {
  try {
    const [data, backups] = await Promise.all([api('/api/admin/config'), api('/api/admin/backups')]); state.adminConfig = data.config;
    const f = $('#integration-form'); f.elements.derivAppId.value = data.config.derivAppId; f.elements.derivOAuthMode.value = data.config.derivOAuthMode; f.elements.googleClientId.value = data.config.googleClientId; f.elements.derivPatAppId.value = data.config.derivPatAppId || ''; f.elements.derivOauthClientId.value = data.config.derivOauthClientId || '';
    syncBoardControls(data.config);
    const pf = data.config.profile || {};
    const sf = $('#support-form');
    if (sf) { sf.elements.supportPhone.value = pf.supportPhone || ''; sf.elements.supportEmail.value = pf.supportEmail || ''; sf.elements.assistantPhone.value = pf.assistantPhone || ''; sf.elements.website.value = pf.website || ''; }
    renderSupportCard(pf);
    const m = $('#maintenance-form'); m.elements.enabled.checked = data.config.maintenance.enabled; m.elements.version.value = data.config.appVersion; m.elements.message.value = data.config.maintenance.message; m.elements.notes.value = data.config.maintenance.notes;
    renderBackups(backups.backups);
  } catch (e) { toast(e.message, 'error'); }
}
function renderBackups(backups) {
  $('#backup-list').innerHTML = backups.length ? backups.slice(0, 5).map(b => `<div class="backup-row"><b>${esc(b.id)}</b><span>${(b.bytes / 1024).toFixed(1)} KB</span></div>`).join('') : '<div class="empty-state compact"><b>No snapshots yet</b></div>';
}

function newUserModal() {
  modal(`<h3>Add a platform user</h3><p>Create a secure email + password account. New client accounts begin with restricted access.</p><form id="modal-user-form"><label>Email address<input name="email" type="email" required></label><label>Temporary password<input name="password" type="password" minlength="8" required></label><label>Role<select name="role"><option value="user">Client</option><option value="admin">Administrator</option></select></label><div class="modal-actions"><button type="button" class="btn btn-ghost" onclick="document.querySelector('#modal-close').click()">Cancel</button><button class="btn btn-primary" type="submit">Create account</button></div></form>`);
  $('#modal-user-form').onsubmit = async e => {
    e.preventDefault(); const btn = $('button[type="submit"]', e.target), body = Object.fromEntries(new FormData(e.target)); setBusy(btn, true);
    try { await api('/api/admin/users', { method: 'POST', body }); closeModal(); toast('User account created.'); loadAdminUsers(); } catch (err) { toast(err.message, 'error'); setBusy(btn, false); }
  };
}
function newLicenseModal() {
  modal(`<h3>Generate license keys</h3><p>The subscription clock starts when the client redeems the key. Lifetime keys never expire.</p><form id="modal-license-form"><label>Plan<select name="plan"><option value="days30">30-Day</option><option value="year">1-Year</option><option value="lifetime">Lifetime</option></select></label><div class="form-grid two"><label>Quantity<input name="count" type="number" min="1" max="50" value="1"></label><label>Label<input name="label" placeholder="Customer name"></label></div><label>Client email (optional)<input name="email" type="email"></label><div class="modal-actions"><button type="button" class="btn btn-ghost" onclick="document.querySelector('#modal-close').click()">Cancel</button><button class="btn btn-primary" type="submit">Generate</button></div></form>`);
  $('#modal-license-form').onsubmit = async e => {
    e.preventDefault(); const btn = $('button[type="submit"]', e.target), body = Object.fromEntries(new FormData(e.target)); setBusy(btn, true);
    try {
      const data = await api('/api/admin/licenses', { method: 'POST', body });
      if (data.created.length === 1) {
        $('#modal-content').innerHTML = `<h3>License ready</h3><p>Share this key privately with your client. It can only be bound to one account.</p><div class="generated-key">${data.created[0].key}</div><div class="modal-actions"><button id="copy-new-key" class="btn btn-primary">Copy key</button><button id="done-new-key" class="btn btn-outline">Done</button></div>`;
        $('#copy-new-key').onclick = () => { navigator.clipboard.writeText(data.created[0].key); toast('License key copied.'); };
        $('#done-new-key').onclick = () => { closeModal(); loadAdminUsers(); };
      } else { closeModal(); toast(`${data.created.length} license keys generated.`); loadAdminUsers(); }
    } catch (err) { toast(err.message, 'error'); setBusy(btn, false); }
  };
}

/* Navigation and global controls */
$$('.nav-item').forEach(b => b.addEventListener('click', () => navigate(b.dataset.view)));
$$('[data-go]').forEach(b => b.addEventListener('click', () => navigate(b.dataset.go)));
$$('.open-manual-btn').forEach(b => b.addEventListener('click', () => showManualOverlay(false)));
const mobileNav = window.matchMedia('(max-width: 900px)');
function setSidebarOpen(open, restoreFocus = false) {
  const sidebar = $('#sidebar'), menu = $('#menu-btn'), main = $('#main-content');
  const expanded = !!open && mobileNav.matches;
  sidebar.classList.toggle('open', expanded);
  $('#sidebar-scrim').classList.toggle('visible', expanded);
  document.body.classList.toggle('nav-open', expanded);
  menu.setAttribute('aria-expanded', String(expanded));
  sidebar.inert = mobileNav.matches && !expanded;
  main.inert = expanded;
  if (expanded) {
    sidebar.setAttribute('role', 'dialog');
    sidebar.setAttribute('aria-modal', 'true');
    sidebar.setAttribute('aria-label', 'Workspace navigation');
    sidebar.querySelector('.nav-item.active, .nav-item')?.focus();
  } else {
    sidebar.removeAttribute('role'); sidebar.removeAttribute('aria-modal'); sidebar.removeAttribute('aria-label');
    if (restoreFocus && mobileNav.matches) menu.focus();
  }
}
$('#menu-btn').onclick = () => setSidebarOpen(true);
$('#sidebar-close').onclick = () => setSidebarOpen(false, true);
$('#sidebar-scrim').onclick = () => setSidebarOpen(false, true);
mobileNav.addEventListener('change', () => setSidebarOpen(false));
setSidebarOpen(false);
$('#sidebar').addEventListener('keydown', e => {
  if (!mobileNav.matches || !$('#sidebar').classList.contains('open')) return;
  if (e.key === 'Escape') { e.preventDefault(); setSidebarOpen(false, true); return; }
  if (e.key !== 'Tab') return;
  const focusable = $$('button:not([disabled]), a[href]', $('#sidebar')).filter(el => el.getClientRects().length);
  const first = focusable[0], last = focusable.at(-1);
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
});
$('#modal-close').onclick = closeModal;
$('#modal').addEventListener('keydown', e => trapOverlayFocus(e, $('#modal')));
$('#manual-overlay').addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.preventDefault(); $('#manual-ok').click(); }
  else trapOverlayFocus(e, $('#manual-overlay'));
});
$('#modal').addEventListener('click', e => { if (e.target === $('#modal')) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
$('#logout-btn').onclick = async () => { try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) {} showAuth(); };
const retryLock = $('#maintenance-retry');
if (retryLock) retryLock.onclick = async () => {
  await loadPublicConfig();
  if ($('#maintenance-lock').classList.contains('hidden')) { toast('Back online — welcome.'); pollBot(); }
  else toast('Still updating. We will be back shortly.', 'warn');
};
$('#top-refresh').onclick = async () => { await Promise.all([pollBot(), loadPublicConfig()]); if (state.view === 'markets') loadDesk(); toast('Workspace refreshed.'); };
$('#symbol-select').onchange = e => { state.symbol = e.target.value; connectStream(); renderSignal(null); };
$('#aggression').oninput = updateRange;
window.addEventListener('resize', () => drawChart());

/* Authentication */
$$('[data-auth-mode]').forEach(b => b.onclick = () => {
  state.mode = b.dataset.authMode;
  $$('[data-auth-mode]').forEach(x => x.classList.toggle('active', x === b));
  $('#auth-title').textContent = state.mode === 'login' ? 'Sign in to your workspace' : 'Create your trading account';
  $('#auth-subtitle').textContent = state.mode === 'login' ? 'Your markets, engine and positions are waiting.' : 'Redeem your license and set up your secure workspace.';
  $('#auth-submit span').textContent = state.mode === 'login' ? 'Enter workspace' : 'Create account';
  $('#auth-password').autocomplete = state.mode === 'login' ? 'current-password' : 'new-password';
  $('#auth-kicker').textContent = state.mode === 'login' ? 'WELCOME BACK' : 'GET STARTED';
  $('#auth-error').classList.add('hidden');
});
$('#toggle-password').onclick = () => { const p = $('#auth-password'); p.type = p.type === 'password' ? 'text' : 'password'; $('#toggle-password').textContent = p.type === 'password' ? 'Show' : 'Hide'; };
$('#google-signin').onclick = () => startGoogleSignIn();
$('#forgot-password').onclick = () => openRecovery('password');
$('#open-recovery').onclick = () => openRecovery('admin');
$('#admin-login-btn').onclick = () => openAdminLogin();
$('#service-deriv').onclick = () => $('#deriv-signin').click();
$('#deriv-link-now').onclick = () => {
  if (state.user) { location.href = '/api/auth/deriv/start?link=1'; return; }
  toast('Sign in first — then link your Deriv account in one tap.', 'success');
  $('#deriv-signin').click();
};
$$('#login-plans .plan-chip').forEach(chip => chip.onclick = () => {
  const plan = chip.dataset.plan, plans = (state.config && state.config.plans) || {};
  const copy = plans[plan] || {}, label = chip.querySelector('b').textContent + ' ' + chip.querySelector('small').textContent;
  toast(`${label}${copy.price ? ' · ' + copy.price : ''} — ${copy.blurb || 'Redeem a license key to activate this plan.'}`, 'success', 5200);
  $('#auth-license').scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => $('#auth-license').focus({ preventScroll: true }), 320);
});
function setLoginStatus(copy, tone) {
  const el = $('#login-status'); if (!el) return;
  $('#login-status-copy').textContent = copy;
  el.classList.toggle('warn', tone === 'warn');
}
function loadGoogleSdk() {
  return new Promise((resolve, reject) => {
    if (window.google && window.google.accounts && window.google.accounts.id) return resolve();
    const existing = document.querySelector('script[data-gsi]');
    const done = () => window.google && window.google.accounts && window.google.accounts.id ? resolve() : reject(new Error('google-sdk-unavailable'));
    if (existing) { existing.addEventListener('load', done); existing.addEventListener('error', () => reject(new Error('google-sdk-unavailable'))); return; }
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client'; script.async = true; script.defer = true; script.dataset.gsi = '1';
    script.onload = done; script.onerror = () => reject(new Error('google-sdk-unavailable'));
    document.head.append(script);
  });
}
function googleClientId() { return (state.config && state.config.googleClientId) || ''; }
function googleCredential() {
  return new Promise(async (resolve, reject) => {
    const clientId = googleClientId();
    if (!clientId) return reject(new Error('google-not-configured'));
    try { await loadGoogleSdk(); } catch (e) { return reject(new Error('google-unreachable')); }
    window.google.accounts.id.initialize({ client_id: clientId, ux_mode: 'popup', auto_select: false, callback: resp => resolve(resp.credential) });
    window.google.accounts.id.prompt(notification => {
      if (notification && (notification.isNotDisplayed && notification.isNotDisplayed() || notification.isSkippedMoment && notification.isSkippedMoment())) {
        window.google.accounts.id.renderButton(document.createElement('div'), {});
        reject(new Error('google-prompt-blocked'));
      }
    });
  });
}
async function startGoogleSignIn() {
  const error = $('#auth-error'); error.classList.add('hidden');
  try {
    const clientId = googleClientId();
    if (!clientId) throw new Error('google-not-configured');
    const credential = await googleCredential();
    const data = await api('/api/auth/google', { method: 'POST', body: { credential } });
    await showApp(data); toast('Signed in with Google.');
  } catch (err) {
    const copy = {
      'google-not-configured': 'Google sign-in is not configured yet. Add your Google OAuth Client ID in Platform settings → Integrations.',
      'google-unreachable': 'Google could not be reached from this browser. Check your connection and try again.',
      'google-prompt-blocked': 'Google sign-in was blocked. Allow popups and third-party cookies for this site, then retry.'
    }[err.message];
    showError(error, copy || err.message);
  }
}
function openRecovery(mode) {
  const rc = (state.config && state.config.recovery) || {};
  const support = (state.config && state.config.support) || {};
  const phone = support.phone || '081 609 0300';
  const supportEmail = support.email || 'ricardohaindaka2006@gmail.com';
  const googleEmail = rc.googleAvailable ? rc.googleEmail : 'ricardohaindaka2006@gmail.com';
  modal(`
    <div class="modal-head"><span class="panel-kicker">${mode === 'admin' ? 'ADMIN ACCESS' : 'ACCOUNT RECOVERY'}</span><h3>${mode === 'admin' ? 'Reset the admin password' : 'Forgot your password?'}</h3><p class="muted">Reset the administrator password with a one-time code from WhatsApp/SMS, or verify with the recovery Google account.</p></div>
    <div class="recovery-steps">
      <div class="recovery-step"><b>1. Send a one-time code</b><p class="muted">Delivered to ${esc(phone)}${rc.phoneAvailable ? '' : ' (support line)'} and written to the server log.</p><button class="btn btn-outline btn-full" id="recover-send">Send reset code</button></div>
      <form id="recover-code-form" class="recovery-step hidden"><b>2. Enter the code</b><label>Six-digit code<input id="recover-code" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" maxlength="6" required></label><button class="btn btn-primary btn-full" type="submit">Verify code</button></form>
      <div class="recovery-step"><b>Alt. Verify with Google</b><p class="muted">Recovery identity: <strong>${esc(googleEmail)}</strong></p><button class="btn btn-outline btn-full" id="recover-google"><span class="g-badge">G</span>Verify with Google</button></div>
      <form id="recover-reset-form" class="recovery-step hidden"><b>3. Set a new password</b><label>New password<input id="recover-password" type="password" autocomplete="new-password" minlength="8" required placeholder="At least 8 characters"></label><button class="btn btn-primary btn-full" type="submit">Save new password</button></form>
      <p class="panel-note"><svg><use href="#i-info"/></svg>Still stuck? Contact support on <a href="tel:+264816090300">081 609 0300</a> or <a href="mailto:${esc(supportEmail)}">${esc(supportEmail)}</a>.</p>
    </div>`);
  let ticket = null;
  $('#recover-send').onclick = async e => {
    setBusy(e.currentTarget, true, 'Sending…');
    try {
      const data = await api('/api/auth/recover/start', { method: 'POST', body: { method: 'phone' } });
      $('#recover-code-form').classList.remove('hidden');
      toast(data.message || 'Reset code sent.', 'success', 6000);
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(e.currentTarget, false); }
  };
  $('#recover-code-form').onsubmit = async e => {
    e.preventDefault(); const btn = $('button[type="submit"]', e.target); setBusy(btn, true);
    try {
      const data = await api('/api/auth/recover/verify', { method: 'POST', body: { code: $('#recover-code').value.trim() } });
      ticket = data.ticket; $('#recover-reset-form').classList.remove('hidden'); toast('Code verified. Choose a new password.');
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(btn, false); }
  };
  $('#recover-google').onclick = async e => {
    const btn = e.currentTarget; setBusy(btn, true, 'Opening Google…');
    try {
      if (!googleClientId()) throw new Error('google-not-configured');
      const credential = await googleCredential();
      const data = await api('/api/auth/recover/google', { method: 'POST', body: { credential } });
      ticket = data.ticket;
      $('#recover-reset-form').classList.remove('hidden');
      toast('Google verified. Choose a new admin password.', 'success');
    } catch (err) {
      toast(err.message === 'google-not-configured' ? 'Set the Google OAuth Client ID in Platform settings first.' : err.message, 'error');
    } finally { setBusy(btn, false); }
  };
  $('#recover-reset-form').onsubmit = async e => {
    e.preventDefault();
    if (!ticket) return toast('Verify a code first.', 'error');
    const btn = $('button[type="submit"]', e.target); setBusy(btn, true);
    try {
      await api('/api/auth/recover/reset', { method: 'POST', body: { ticket, password: $('#recover-password').value } });
      closeModal(); toast('Admin password updated. Sign in with your new password.', 'success', 5000);
      $('#auth-email').focus();
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(btn, false); }
  };
}
async function openAdminLogin() {
  const me = state.user, isAdmin = me && me.role === 'admin';
  if (isAdmin) return toast('You are already signed in as administrator.', 'success');
  modal(`
    <div class="modal-head"><span class="panel-kicker">ADMINISTRATOR</span><h3>Admin login</h3><p class="muted">Sign in with the administrator account to unlock users, licenses, engine lab and platform settings.</p></div>
    <form id="admin-login-form">
      <label>Admin email<input id="admin-email" type="email" autocomplete="username" placeholder="admin@rhpilot.com" required></label>
      <label>Admin password<div class="password-wrap"><input id="admin-password" type="password" autocomplete="current-password" placeholder="Your admin password" required><button type="button" id="admin-password-toggle" aria-label="Show password">Show</button></div></label>
      <div id="admin-login-error" class="form-error hidden" role="alert"></div>
      <button class="btn btn-primary btn-full" type="submit"><svg><use href="#i-shield"/></svg>Unlock admin controls</button>
    </form>
    <p class="panel-note"><svg><use href="#i-info"/></svg>Forgot it? <button type="button" class="text-btn" id="admin-forgot">Reset via WhatsApp code</button> · Support 081 609 0300</p>`);
  if (me) $('#admin-email').value = me.email;
  $('#admin-password-toggle').onclick = () => { const p = $('#admin-password'); p.type = p.type === 'password' ? 'text' : 'password'; $('#admin-password-toggle').textContent = p.type === 'password' ? 'Show' : 'Hide'; };
  $('#admin-forgot').onclick = () => openRecovery('admin');
  $('#admin-login-form').onsubmit = async e => {
    e.preventDefault(); const btn = $('button[type="submit"]', e.target), err = $('#admin-login-error'); err.classList.add('hidden'); setBusy(btn, true);
    const body = { email: $('#admin-email').value.trim(), password: $('#admin-password').value };
    try {
      if (state.user) {
        const data = await api('/api/auth/unlock-admin', { method: 'POST', body });
        await showApp(data); closeModal(); toast('Administrator controls unlocked.', 'success');
      } else {
        const data = await api('/api/auth/login', { method: 'POST', body });
        if (data.user.role !== 'admin') { closeModal(); return showError('#auth-error', 'That account is not an administrator. Sign in normally instead.'); }
        await showApp(data); closeModal(); toast('Welcome back, administrator.', 'success');
      }
    } catch (err2) { showError(err, err2.message); } finally { setBusy(btn, false); }
  };
}
$('#auth-form').onsubmit = async e => {
  e.preventDefault(); const btn = $('#auth-submit'), error = $('#auth-error'); error.classList.add('hidden'); setBusy(btn, true);
  try {
    const key = $('#auth-license').value.trim();
    if (key) await api('/api/license/check', { method: 'POST', body: { key } });
    const data = await api(`/api/auth/${state.mode}`, { method: 'POST', body: { email: $('#auth-email').value, password: $('#auth-password').value } });
    await showApp(data); toast(state.mode === 'login' ? 'Welcome back to R.H Pilot.' : 'Your workspace is ready.');
  } catch (err) {
    showError(error, err.message);
    // Put the cursor where the problem is, and never wipe what they typed.
    if (err.code === 'no-such-account') $('#auth-email').focus();
    else if (err.code === 'invalid-credentials') $('#auth-password').select();
  } finally { setBusy(btn, false); }
};
$('#deriv-pat-login-form').onsubmit = async e => {
  e.preventDefault();
  const btn = $('#deriv-pat-signin'), error = $('#deriv-pat-login-error');
  const token = $('#auth-deriv-token').value;
  const accountId = $('#auth-deriv-account').value.trim();
  // Do not leave a credential visible in the DOM after either success/failure.
  $('#auth-deriv-token').value = '';
  error.classList.add('hidden'); setBusy(btn, true, 'Verifying account…');
  try {
    const key = $('#auth-deriv-license').value.trim() || $('#auth-license').value.trim();
    if (key) await api('/api/license/check', { method: 'POST', body: { key } });
    const data = await api('/api/auth/deriv/pat', { method: 'POST', body: { token, ...(accountId ? { accountId } : {}) } });
    await showApp(data); toast('Deriv account access connected. Real-money orders remain disabled.');
  } catch (err) { showError(error, err.message); }
  finally { setBusy(btn, false); }
};
$('#deriv-signin').onclick = async () => {
  try { const key = $('#auth-license').value.trim(); if (key) await api('/api/license/check', { method: 'POST', body: { key } }); location.href = '/api/auth/deriv/start'; }
  catch (e) { showError('#auth-error', e.message); }
};

/* Bot controls */
/* ---------------------------------------------------------------------------
   Trade confirmation.

   Every press of the trade button must show this, every time. It names the
   account (DEMO or REAL), the pair, the balance and the money at risk, and it
   cannot be dismissed by pressing outside or by a "don't ask again" setting.
   --------------------------------------------------------------------------- */
function confirmTrade(body) {
  return new Promise(resolve => {
    const mode = 'PAPER SIMULATION';
    const money0 = n => (n == null || !Number.isFinite(Number(n))) ? '—' : money(n);
    const estimate = estimatePaperRisk(body);
    const bal = estimate.bal, plannedPct = estimate.pct, cap = estimate.perTrade, daily = estimate.daily;
    const cls = 'demo';
    const html = `
      <div class="trade-confirm-card">
        <div class="tc-head">
          <div class="tc-icon ${cls}"><svg width="20" height="20"><use href="#i-shield"/></svg></div>
          <div>
            <h3>Confirm this trade</h3>
            <p>Check the details before the engine is allowed to open a position.</p>
          </div>
        </div>
        <div class="tc-rows">
          <div class="tc-row"><span>Account</span><b class="${cls}">${mode}</b></div>
          <div class="tc-row"><span>Currency pair</span><b>${body.symbol || '—'}</b></div>
          <div class="tc-row"><span>Balance in use</span><b>${money0(bal)}</b></div>
          <div class="tc-row"><span>Planned stop-risk budget</span><b class="${cls}">${money0(cap)}</b></div>
          <div class="tc-row"><span>Stop trading after</span><b>${money0(daily)} UTC-day net loss (planned)</b></div>
          <div class="tc-row"><span>Risk per trade</span><b>${plannedPct}%</b></div>
        </div>
        <div class="tc-atrisk ${cls}">
          <span>Planned paper risk, not a guaranteed fill</span>
          <b>${money0(cap)}${daily ? ` <small>· UTC-day net-loss planning budget ${money0(daily)}</small>` : ''}</b>
        </div>
        <div class="tc-risk ${cls}">
          <b>Paper simulation only.</b> Nothing is bought on a linked demo or real account. Mandatory $1/trade and $2 total planned risk; 3% daily net-loss and 10% drawdown rails. Three consecutive losses pause entries for 5 minutes. Costs and gaps can exceed these limits. Synthetic win rates are not live performance evidence. New real-money orders are disabled.
        </div>
        <div class="tc-actions">
          <button type="button" class="btn btn-ghost" data-tc="cancel">Cancel</button>
          <button type="button" class="btn btn-primary" data-tc="ok">
            Confirm and start paper engine
          </button>
        </div>
        <p class="tc-hint">Nothing is opened until you confirm. Press <b>Cancel</b>, the <b>✕</b>, or click outside this box to back out.</p>
      </div>`;
    modal(html);
    modalDismiss = () => resolve(false);
    const done = ok => {
      modalDismiss = null;
      const close = document.querySelector('#modal-close');
      if (close) close.click();
      resolve(ok);
    };
    document.querySelectorAll('#modal-content [data-tc]').forEach(b => {
      b.onclick = () => done(b.dataset.tc === 'ok');
    });
  });
}

/* One start routine for both entry points: the gold button in the engine section
   and the Start button on the overview. Both read the same form, so the engine
   the client tuned is exactly the engine that runs. */
async function startEngine(btn) {
  const form = $('#quick-bot-form');
  if (!form) return;
  const selectedPreset = form.elements.preset?.value;
  if (!state.bot?.startedAt && PRESETS[selectedPreset]) selectPreset(selectedPreset);
  const body = Object.fromEntries(new FormData(form));
  const symEl = form.elements.symbol;
  body.symbol = (symEl && symEl.value) || state.symbol;
  state.symbol = body.symbol;
  if ($('#symbol-select')) $('#symbol-select').value = body.symbol;
  const balEl = form.elements.startBalance;
  const declared = balEl ? Number(balEl.value) : 0;
  /* A client who never typed a balance leaves it to the server, which reads the
     linked Deriv account and sizes every limit to it. */
  if (declared > 0) body.startBalance = declared; else delete body.startBalance;
  body.trailing = form.elements.trailing.checked;
  body.autoRisk = form.elements.autoRisk.checked;
  body.riskPerTrade = Number(form.elements.riskPerTrade.value) || 0.5;
  body.compoundProfits = form.elements.compoundProfits?.checked !== false;
  for (const field of ['lockAfterR', 'trailAfterR', 'trailByR']) body[field] = Number(form.elements[field].value);
  body.strategy = form.elements.strategy.value || 'auto';
  body.preset = form.elements.preset ? form.elements.preset.value : 'safe';
  body.lockInProfit = form.elements.lockInProfit ? form.elements.lockInProfit.checked : true;
  body.maxLossPerTrade = Number(form.elements.maxLossPerTrade && form.elements.maxLossPerTrade.value) || 0;
  body.dailyLossLimit = Number(form.elements.dailyLossLimit && form.elements.dailyLossLimit.value) || 0;
  body.maxTrades = Number(form.elements.maxTrades.value) || 1;
  body.aggression = Number(form.elements.aggression.value) || 6;
  if (!body.autoRisk) body.lots = Number(form.elements.lots.value) || 0.01;

  /* Nothing starts until the client has seen and accepted the risks. This runs on
     EVERY press — there is no way to skip it. */
  if (!(await confirmTrade(body))) return toast('Trade cancelled — no position was opened.', 'warn');

  setBusy(btn, true, 'Starting…');
  try {
    const data = await api('/api/bot/start', { method: 'POST', body });
    state.bot = Object.assign(data.bot, { simulation: data.simulation });
    updateBot(state.bot); renderSignal(data.signal);
    const warm = data.simulation && data.simulation.waiting === 'warming-up' ? ` · warming up ${data.simulation.ticks}/${data.simulation.warmup} ticks` : '';
    toast(`Springboks engine started on ${data.bot.symbol} in ${data.bot.live ? 'LIVE' : 'simulation'} mode${warm}.`);
  } catch (err) { toast(err.message, 'error'); } finally { setBusy(btn, false); }
}
$('#quick-bot-form').onsubmit = e => { e.preventDefault(); startEngine($('#start-bot')); };
const heroStartBtn = $('#hero-start');
if (heroStartBtn) heroStartBtn.onclick = () => startEngine(heroStartBtn);
const heroStopBtn = $('#hero-stop');
if (heroStopBtn) heroStopBtn.onclick = () => stopBot();
async function stopBot(path = '/api/bot/stop') {
  try { const data = await api(path, { method: 'POST' }); state.bot = data.bot; updateBot(data.bot); toast('Engine stopped. Review the exposure log for any remaining positions.', 'warn'); }
  catch (e) { toast(e.message, 'error'); }
}
$('#stop-bot').onclick = () => stopBot();
$('#emergency-close').onclick = () => { if (confirm('Stop the engine and close every open position now?')) stopBot('/api/bot/closeall'); };
$('#refresh-engine').onclick = () => resyncEngine('soft');
// strategy / risk changes apply immediately, even mid-run
const botSymEl = $('#bot-symbol');
if (botSymEl) botSymEl.onchange = e => { e.target.dataset.touched = '1'; state.symbol = e.target.value; };
$('#bot-strategy').onchange = async e => {
  markCustomPreset();
  await saveBotSettings({ strategy: e.target.value });
  renderStrategySelect(); updateBot(state.bot);
  toast(e.target.value === 'auto' ? 'Auto strategy engaged.' : `${strategyName(e.target.value)} selected.`);
};
$('#risk-per-trade').oninput = () => { updateRiskUI(); updateRiskProfile(); };
$('#risk-per-trade').onchange = async e => {
  markCustomPreset();
  await saveBotSettings({ riskPerTrade: Number(e.target.value) });
  toast(`Planned risk per trade set to ${Number(e.target.value)}%.`);
};
$('#quick-bot-form').elements.autoRisk.onchange = async e => {
  markCustomPreset(); updateRiskUI();
  await saveBotSettings({ autoRisk: e.target.checked });
  updateBot(state.bot);
};

for (const field of ['compoundProfits', 'lockInProfit', 'trailing', 'lockAfterR', 'trailAfterR', 'trailByR', 'maxLossPerTrade', 'dailyLossLimit', 'maxTrades', 'lots', 'aggression']) {
  const control = $('#quick-bot-form').elements[field];
  if (!control) continue;
  control.onchange = async e => {
    markCustomPreset();
    const value = e.target.type === 'checkbox' ? e.target.checked : Number(e.target.value);
    const saved = await saveBotSettings({ [field]: value });
    if (saved) { updateBot(saved.bot); updateRiskUI(); updateRiskProfile(); }
    else if (state.bot) populateBotForm();
  };
}

/* Market picker — a grouped, status-aware menu instead of a native select */
const marketTrigger = $('#market-trigger');
if (marketTrigger) marketTrigger.onclick = e => {
  e.preventDefault(); e.stopPropagation();
  const p = $('#market-picker');
  if (p && p.classList.contains('open')) closeMarketMenu(); else openMarketMenu();
};
document.addEventListener('click', e => { if (!e.target.closest('#market-picker')) closeMarketMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMarketMenu(); });

/* Balance detector — type a balance, or pull it from the linked account */
const balInput = $('#start-balance');
if (balInput) balInput.oninput = () => { balInput.dataset.touched = '1'; balInput.classList.remove('auto');
  const preset = $('#preset-value')?.value;
  if (!state.bot?.startedAt && PRESETS[preset]) selectPreset(preset);
  updateRiskProfile(); };
const useBal = $('#use-linked-balance');
if (useBal) useBal.onclick = () => useLinkedBalance();

/* Deriv */
$('#deriv-token-form').onsubmit = async e => {
  e.preventDefault(); const btn = $('button[type="submit"]', e.target); setBusy(btn, true, 'Verifying…');
  const token = $('#deriv-token').value; $('#deriv-token').value = '';
  try { const data = await api('/api/deriv/link', { method: 'POST', body: { token } }); state.user.deriv = data.deriv; state.user.cashier = data.cashier; renderWallet(); toast(`Deriv ${data.deriv.isVirtual ? 'demo' : 'real'} account access linked. Orders remain disabled.`); }
  catch (err) { toast(err.message, 'error', 5500); } finally { setBusy(btn, false); }
};
/* Show account-access status, not a claim that the linked account can trade.
   A client should never have to guess why the bot is not placing orders. */
async function checkDerivHealth(quiet) {
  const box = $('#deriv-health'), text = $('#deriv-health-text');
  if (!box || !text) return;
  if (!state.user || !state.user.deriv) {
    box.className = 'deriv-health';
    text.textContent = 'No Deriv account linked yet.';
    return;
  }
  if (!quiet) text.textContent = 'Checking…';
  try {
    const r = await api('/api/deriv/ready');
    box.classList.remove('ok', 'bad', 'warn');
    box.classList.add(r.account ? 'warn' : 'bad');
    text.textContent = r.message || 'Paper-only build. Broker execution remains blocked pending settlement tracking and demo validation.';
  } catch (e) {
    box.classList.remove('ok', 'warn'); box.classList.add('bad');
    text.textContent = 'Connection check failed: ' + e.message;
  }
}
const healthBtn = $('#deriv-health-check');
if (healthBtn) healthBtn.onclick = async () => {
  setBusy(healthBtn, true, 'Checking…');
  try {
    const t = await api('/api/deriv/test', { method: 'POST' });
    if (t.accountOk === false) toast('Your Deriv account did not confirm: ' + (t.error || 'unknown reason'), 'error', 8000);
    else if (!t.serverOk) toast('This server cannot reach Deriv right now: ' + (t.error || 'network'), 'error', 8000);
    else toast('Deriv responded in ' + t.latency + ' ms — account confirmed.', 'success');
    if (t.account && state.user && state.user.deriv) {
      state.user.deriv.balance = t.account.balance;
      state.user.deriv.isVirtual = t.account.isVirtual;
      renderWallet();
    }
  } catch (e) { toast(e.message, 'error'); }
  await checkDerivHealth(true);
  setBusy(healthBtn, false);
};
$('#refresh-balance').onclick = async e => {
  setBusy(e.currentTarget, true);
  try {
    const data = await api('/api/deriv/refresh', { method: 'POST' });
    state.user.deriv = data.deriv;
    const input = $('#start-balance');
    if (input) delete input.dataset.touched;
    renderWallet();
    const bal = Number(input && input.value) || 0;
    toast(bal > 0 ? `Deriv balance refreshed — sizing read from your account (${money(bal)}).` : 'Deriv balance refreshed.');
  }
  catch (err) { toast(err.message, 'error'); } finally { setBusy(e.currentTarget, false); }
};
$('#unlink-deriv').onclick = async () => {
  if (!confirm('Unlink this Deriv account?')) return;
  try { await api('/api/deriv/unlink', { method: 'POST' }); state.user.deriv = null; state.bot.live = false; renderWallet(); updateBot(state.bot); toast('Deriv account unlinked.', 'warn'); }
  catch (e) { toast(e.message, 'error'); }
};
$('#test-deriv').onclick = async e => {
  const btn = e.currentTarget, box = $('#deriv-test-result'); setBusy(btn, true, 'Testing…'); box.classList.remove('hidden', 'success', 'error'); box.textContent = 'Checking the public Deriv connection and your linked account…';
  try {
    const r = await api('/api/deriv/test', { method: 'POST' });
    const ok = r.serverOk && r.accountOk === true;
    box.classList.add(ok ? 'success' : 'error');
    box.textContent = ok ? `Server + selected Deriv account confirmed · ${r.latency} ms · ${r.account.loginid}`
      : (r.serverOk ? 'Deriv public API is reachable, but no linked account was verified. Link your Deriv account and run Verify demo + real.' : `Deriv API is not reachable from this server (${r.error || 'network error'}). The simulator remains available.`);
    if (r.account && state.user && state.user.deriv) {
      state.user.deriv.balance = r.account.balance;
      state.user.deriv.isVirtual = r.account.isVirtual;
      renderWallet();
    }
  } catch (err) { box.classList.add('error'); box.textContent = err.message; } finally { setBusy(btn, false); }
};
$('#verify-all-deriv').onclick = async e => {
  const btn = e.currentTarget, box = $('#deriv-test-result');
  if (!state.user || !state.user.deriv) {
    box.classList.remove('hidden', 'success'); box.classList.add('error');
    box.textContent = 'Link your Deriv account first. Use OAuth or a Personal Access Token with trade permission.';
    return;
  }
  setBusy(btn, true, 'Verifying both…'); box.classList.remove('hidden', 'success', 'error');
  box.textContent = 'Checking every linked demo and real account with quote-only proposals. No trades will be placed.';
  try {
    const r = await api('/api/deriv/verify-accounts', { method: 'POST', body: { symbol: 'VOL10' } });
    const details = (r.accounts || []).map(a => `${a.type.toUpperCase()} ${a.loginid}: ${a.verified ? 'VERIFIED' : 'FAILED (' + (a.error || 'not confirmed') + ')'}`);
    box.classList.add(r.ok ? 'success' : 'error');
    const missing = (r.missingTypes || []).map(type => 'Missing ' + type.toUpperCase() + ' account').join(' · ');
    box.textContent = (r.ok ? 'Both DEMO and REAL accounts passed account access and trade-quote checks. ' : 'Full verification incomplete. ' + missing + ' ') + details.join(' · ') + ' — no contracts were bought.';
    await checkDerivHealth(true);
    if (state.user && state.user.deriv) {
      const current = (r.accounts || []).find(a => a.loginid === state.user.deriv.loginid);
      if (current && current.balance != null) state.user.deriv.balance = current.balance;
      renderWallet(); renderAccountChoice();
    }
  } catch (err) { box.classList.add('error'); box.textContent = err.message; } finally { setBusy(btn, false); }
};
/* ---------------------------------------------------------------------------
   Demo or real account.

   The client must make this choice explicitly. Selecting DEMO is instant and
   always safe. Selecting REAL asks for confirmation, and the server will still
   refuse to arm real money if the underlying Deriv account is a demo one.
   --------------------------------------------------------------------------- */
/* ---------------------------------------------------------------------------
   Account bar on the overview.

   Three states the client can pick: DEMO, REAL, or SIMULATION. Simulation means
   nothing is placed anywhere; DEMO means Deriv demo funds; REAL means real money
   and keeps the arming requirement from the execution panel.
   --------------------------------------------------------------------------- */
function currentAccountMode() {
  const d = state.user && state.user.deriv;
  if (!d) return 'sim';
  return d.isVirtual ? 'demo' : 'real';
}
function renderAccountBar() {
  const bar = $('#account-bar');
  if (!bar) return;
  const d = state.user && state.user.deriv;
  const list = d && Array.isArray(d.accounts) ? d.accounts : [];
  const demo = list.find(a => a.isVirtual);
  const real = list.find(a => !a.isVirtual);
  const mode = currentAccountMode();
  bar.dataset.mode = mode;

  const money0 = n => (n == null || !Number.isFinite(Number(n))) ? '—' : money(n);
  const label = { real: 'REAL MONEY', demo: 'DEMO FUNDS', sim: 'SIMULATION' }[mode];
  if ($('#ab-mode')) $('#ab-mode').textContent = label;
  if ($('#ab-demo-bal')) $('#ab-demo-bal').textContent = demo ? money0(demo.balance) : (d && d.isVirtual ? money0(d.balance) : 'not linked');
  if ($('#ab-real-bal')) $('#ab-real-bal').textContent = real ? money0(real.balance) : (d && !d.isVirtual ? money0(d.balance) : 'not linked');

  $$('#account-bar .ab-btn').forEach(b => {
    const m = b.dataset.mode;
    b.classList.toggle('active', m === mode);
    if (m === 'sim') b.disabled = false;
    else b.disabled = !(m === 'demo' ? (demo || (d && d.isVirtual)) : (real || (d && !d.isVirtual)));
  });

  const perm = $('#ab-permission');
  if (perm) perm.textContent = d ? 'Manage Deriv' : 'Link Deriv';

  /* Each option shows whether it is the one active right now. The selected mode
     reads ACTIVE (green); the others show their balance or STANDBY. */
  if ($('#ab-sim-status')) $('#ab-sim-status').textContent = mode === 'sim' ? 'active' : 'standby';

  const health = $('#ab-health');
  if (health) {
    if (!d) { health.className = 'ab-health'; health.textContent = 'Simulation active — link Deriv for real/demo'; }
    else if (mode === 'real' && !state.bot?.live) { health.className = 'ab-health warn'; health.textContent = 'Real account selected — execution not armed'; }
    else if (mode === 'real' && state.bot?.live) { health.className = 'ab-health ok'; health.textContent = 'Real account active — trading armed'; }
    else if (mode === 'demo') { health.className = 'ab-health ok'; health.textContent = 'Demo account active — practice funds'; }
    else { health.className = 'ab-health ok'; health.textContent = 'Simulation active — no real money at risk'; }
  }
}
const accountBar = $('#account-bar');
if (accountBar) accountBar.onclick = async e => {
  if (e.target.closest('#ab-permission')) { navigate('wallet'); return; }
  const btn = e.target.closest('.ab-btn');
  if (!btn || btn.disabled) return;
  const mode = btn.dataset.mode;

  if (mode === 'sim') {
    /* Leaving real money must always be allowed, even with positions open. */
    if (state.bot && state.bot.live) {
      try {
        const r = await api('/api/bot/live', { method: 'POST', body: { live: false } });
        state.bot.live = r.live;
        if ($('#live-toggle')) $('#live-toggle').checked = false;
      } catch (err) { return toast(err.message, 'error'); }
    }
    renderAccountBar(); autoDetectBalance(); updateExecutionMode();
    return toast('Simulation mode active — nothing is placed on any market.', 'warn');
  }

  const d = state.user && state.user.deriv;
  if (!d) return toast('Link your Deriv account first.', 'warn');
  const list = Array.isArray(d.accounts) ? d.accounts : [];
  const pick = list.find(a => (mode === 'demo' ? a.isVirtual : !a.isVirtual));
  if (!pick) return toast(`No ${mode.toUpperCase()} account is linked to this login.`, 'warn');

  if (mode === 'real') {
    const ok = confirm(
      'Switch to your REAL Deriv account?\n\n' +
      `Account ${pick.loginid}` + (pick.balance != null ? ` · balance $${Number(pick.balance).toFixed(2)}` : '') + '\n\n' +
      'Real money can be lost. Execution stays off until you arm it.'
    );
    if (!ok) return;
  }
  try {
    const res = await api('/api/deriv/account', { method: 'POST', body: { loginid: pick.loginid } });
    state.user.deriv = res.deriv;
    state.bot.live = res.live;
    if ($('#live-toggle')) $('#live-toggle').checked = !!res.live;
    renderWallet(); renderAccountBar(); renderAccountChoice(); updateExecutionMode();
    toast(mode === 'demo' ? 'DEMO account selected — practice funds only.' : 'REAL account selected. Arm execution to place real contracts.', mode === 'demo' ? 'success' : 'warn');
  } catch (err) { toast(err.message, 'error'); }
};

function renderAccountChoice() {
  const d = state.user && state.user.deriv;
  const wrap = $('#account-choice'), status = $('#account-status');
  if (!wrap) return;
  const btns = $$('#account-choice .account-btn');
  if (!d) {
    btns.forEach(b => { b.disabled = true; b.classList.remove('active'); });
    if ($('#acct-demo-bal')) $('#acct-demo-bal').textContent = '—';
    if ($('#acct-real-bal')) $('#acct-real-bal').textContent = '—';
    if (status) status.textContent = 'Link a Deriv account to choose.';
    return;
  }
  const list = Array.isArray(d.accounts) ? d.accounts : [];
  const demo = list.find(a => a.isVirtual) || (d.isVirtual ? d : null);
  const real = list.find(a => !a.isVirtual) || (!d.isVirtual ? d : null);
  if ($('#acct-demo-bal')) $('#acct-demo-bal').textContent = demo && demo.balance != null ? money(demo.balance, demo.currency) : 'Not linked';
  if ($('#acct-real-bal')) $('#acct-real-bal').textContent = real && real.balance != null ? money(real.balance, real.currency) : 'Not linked';
  btns.forEach(b => {
    const mode = b.dataset.mode;
    const account = mode === 'demo' ? demo : real;
    b.disabled = !account;
    b.classList.toggle('active', (mode === 'demo') === !!d.isVirtual);
  });
  if (status) {
    status.textContent = d.isVirtual
      ? 'DEMO account selected — practice funds only, no real money can be risked.'
      : 'REAL account selected — real funds. Arming live execution still requires confirmation.';
  }
}
const acctChoice = $('#account-choice');
if (acctChoice) acctChoice.onclick = async e => {
  const btn = e.target.closest('.account-btn');
  if (!btn || btn.disabled) return;
  const mode = btn.dataset.mode;
  const d = state.user && state.user.deriv;
  if (!d) return toast('Link a Deriv account first.', 'warn');
  const list = Array.isArray(d.accounts) ? d.accounts : [];
  const pick = list.find(a => (mode === 'demo' ? a.isVirtual : !a.isVirtual));
  if (!pick) return toast(`No ${mode.toUpperCase()} account is linked to this login.`, 'warn');
  if (mode === 'real') {
    const ok = confirm(
      'Switch to your REAL Deriv account?\n\n' +
      `Account ${pick.loginid}` + (pick.balance != null ? ` · balance ${money(pick.balance, pick.currency)}` : '') + '\n\n' +
      'The paper engine stays in simulation. Real-money execution is disabled in this build.'
    );
    if (!ok) return;
  }
  try {
    const res = await api('/api/deriv/account', { method: 'POST', body: { loginid: pick.loginid } });
    state.user.deriv = res.deriv;
    state.bot.live = res.live;
    if ($('#live-toggle')) $('#live-toggle').checked = !!res.live;
    renderWallet(); renderAccountChoice(); updateExecutionMode();
    toast(mode === 'demo' ? 'DEMO account selected. No real money is at risk.' : 'REAL account selected for wallet access. The engine remains paper-only; real orders are disabled.', mode === 'demo' ? 'success' : 'warn');
  } catch (err) { toast(err.message, 'error'); }
};

$('#live-toggle').onchange = e => {
  e.target.checked = false;
  toast('Real-money orders are disabled pending broker settlement tracking and demo validation.', 'warn');
};
$('#confirm-live').onclick = () => toast('Live execution is disabled in this build.', 'warn');

/* Admin actions */
$('#new-user').onclick = newUserModal;
$('#new-license').onclick = newLicenseModal;
function renderLicenseMode(required) {
  const box = $('#license-mode-note');
  if (!box) return;
  box.classList.toggle('success', !required);
  box.classList.toggle('error', !!required);
  box.textContent = required
    ? 'License keys are required. Clients cannot sign in without a validated key, and their bots are stopped.'
    : 'Free mode is ON. Anyone can create an account and run the bot without a key — use this to let people test it. Turn it on to require keys again; every client is signed out.';
}
$('#license-lockdown').onclick = async () => {
  if (!confirm('Lock down now? Every unused key is revoked, every client is signed out and their bots are stopped. Your admin account keeps access.')) return;
  try {
    const r = await api('/api/admin/license-lockdown', { method: 'POST' });
    $('#license-required').checked = true; renderLicenseMode(true);
    toast(`Locked down: ${r.revoked} key(s) revoked, ${r.loggedOut} session(s) ended, ${r.botsStopped} bot(s) stopped.`, 'warn', 6000);
    loadLicenses();
  } catch (e) { toast(e.message, 'error'); }
};
$('#license-required').onchange = async e => {
  const body = { required: e.target.checked };
  if (e.target.checked && !confirm('Require license keys again? Every client is signed out and their bots are stopped until you send them a key.')) { e.target.checked = false; return; }
  try {
    const r = await api('/api/admin/license-required', { method: 'PUT', body });
    renderLicenseMode(r.required);
    toast(r.required ? `Keys required — ${r.loggedOut} client session(s) ended, ${r.botsStopped} bot(s) stopped.` : 'Free mode is on — anyone can try the bot without a key.', r.required ? 'warn' : 'success', 6000);
    loadLicenses();
  }
  catch (err) { e.target.checked = !e.target.checked; toast(err.message, 'error'); }
};
$('#view-users').addEventListener('click', async e => {
  const t = e.target.closest('button, [data-copy]'); if (!t) return;
  try {
    if (t.dataset.copy) { await navigator.clipboard.writeText(t.dataset.copy); return toast('License key copied.'); }
    if (t.dataset.userPay) await api(`/api/admin/users/${t.dataset.userPay}/payment`, { method: 'POST', body: { paid: t.dataset.paid === 'true' } });
    else if (t.dataset.userActive) await api(`/api/admin/users/${t.dataset.userActive}`, { method: 'PATCH', body: { active: t.dataset.active === 'true' } });
    else if (t.dataset.userDelete) { if (!confirm('Permanently delete this user and their bot history?')) return; await api(`/api/admin/users/${t.dataset.userDelete}`, { method: 'DELETE' }); }
    else if (t.dataset.licenseStatus) await api(`/api/admin/licenses/${t.dataset.licenseStatus}`, { method: 'PATCH', body: { status: t.dataset.status } });
    else if (t.dataset.licenseDelete) { if (!confirm('Delete this unused license?')) return; await api(`/api/admin/licenses/${t.dataset.licenseDelete}`, { method: 'DELETE' }); }
    else return;
    loadAdminUsers(); toast('Access settings updated.');
  } catch (err) { toast(err.message, 'error'); }
});
$('#reset-weights').onclick = async () => {
  if (!confirm('Reset all learned detector weights to 1.0? Trade history and P/L are preserved.')) return;
  try { const data = await api('/api/admin/engine', { method: 'PUT', body: { reset: true } }); if (state.config) state.config.engine.weights = data.weights; loadEngine(); toast('Adaptive weights reset.'); } catch (e) { toast(e.message, 'error'); }
};
$('#integration-form').onsubmit = async e => {
  e.preventDefault(); const btn = $('button[type="submit"]', e.target); setBusy(btn, true);
  try { await api('/api/admin/config', { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) }); toast('Integration settings saved. Market socket reconnects when the App ID changes.'); loadPublicConfig(); }
  catch (err) { toast(err.message, 'error'); } finally { setBusy(btn, false); }
};
$('#support-form').onsubmit = async e => {
  e.preventDefault(); const btn = $('button[type="submit"]', e.target); setBusy(btn, true);
  try {
    const data = await api('/api/admin/profile', { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) });
    renderSupportCard(data.profile);
    toast('Support details updated — clients see them everywhere now.');
    loadPublicConfig();
  } catch (err) { toast(err.message, 'error'); } finally { setBusy(btn, false); }
};
$('#maintenance-form').onsubmit = async e => {
  e.preventDefault(); const body = Object.fromEntries(new FormData(e.target)); body.enabled = e.target.elements.enabled.checked;
  try { await api('/api/admin/maintenance', { method: 'PUT', body }); toast('Platform status published.'); } catch (err) { toast(err.message, 'error'); }
};
$('#news-form').onsubmit = async e => {
  e.preventDefault(); const btn = $('button[type="submit"]', e.target); setBusy(btn, true);
  try { await api('/api/admin/news', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); e.target.reset(); toast('Market report published to clients.'); }
  catch (err) { toast(err.message, 'error'); } finally { setBusy(btn, false); }
};
$('#create-backup').onclick = async e => {
  const button = e.currentTarget; setBusy(button, true);
  try { const data = await api('/api/admin/backup', { method: 'POST' }); renderBackups(data.backups); toast('Private local snapshot created.'); }
  catch (err) { toast(err.message, 'error'); } finally { setBusy(button, false); }
};
$('#refresh-desk').onclick = loadDesk;

/* MT5 terminal workspace: Options tokens and terminal credentials are distinct. */
let mt5TokenTimer = null;
function clearMt5Token() {
  clearTimeout(mt5TokenTimer); mt5TokenTimer = null;
  const input = $('#mt5-pair-token'); if (input) input.value = '';
  $('#mt5-secret')?.classList.add('hidden');
}
function showMt5Token(value) {
  clearMt5Token(); $('#mt5-pair-token').value = value;
  $('#mt5-secret').classList.remove('hidden');
  mt5TokenTimer = setTimeout(clearMt5Token, 120000);
}
function renderMt5() {
  const m = state.user?.mt5 || { configured: false }, box = $('#mt5-status');
  if (!box) return;
  $('#mt5-badge').textContent = !m.configured ? 'NOT PAIRED' : !m.connected ? 'AGENT OFFLINE' : m.mode === 'demo' ? 'MT5 DEMO' : 'MONITOR ONLY';
  $('#mt5-badge').classList.toggle('running', !!m.connected);
  const kind = m.account?.tradeMode === 0 ? 'DEMO' : m.account ? 'REAL / READ-ONLY' : 'NOT YET VERIFIED';
  const reason = errorMessages[m.reason] || ({
    'mt5-warming-up': `Warming up: ${m.samples || 0} / ${m.warmup || 91} fresh terminal ticks.`,
    'mt5-no-signal': 'No eligible strategy signal. Waiting, not inventing a trade.',
    'mt5-minimum-lot-exceeds-risk': 'Broker minimum volume and estimated costs do not fit the risk budget. Trade skipped.',
    'mt5-exposure-reserved': 'Exposure is reserved. Waiting for confirmed broker settlement.',
    'mt5-stale-quote': 'The terminal quote is stale or the market is closed. No new entry.',
    'mt5-awaiting-new-tick': 'Waiting for the next fresh terminal tick.',
    'mt5-restart-disarmed': 'Server restarted. Entries are disarmed; reconcile and resume manually.',
    'mt5-entries-paused': 'New entries paused. Existing positions still need broker/agent exit management.',
    'mt5-entry-cooldown': 'Waiting for the entry cooldown.',
    'mt5-token-rotated-restart-agent': 'New token issued. Restart the same agent with its existing journal.'
  })[m.reason] || (m.reason ? m.reason.replaceAll('-', ' ') : 'Terminal report received.');
  box.innerHTML = m.configured ? `<b>${esc(m.login)} · ${esc(m.server)}</b><span>${esc(m.symbol)} · ${kind}</span><span>Balance ${m.account ? money(m.account.balance, m.account.currency) : 'unconfirmed'} · ${m.openPositions?.length || 0} broker position(s)</span><span>${esc(reason)}</span>` : 'No terminal paired. Enter the exact account and server to begin.';
  const held = m.reconciliationRequired || m.openPositions?.length || m.brokerPendingOrders || m.orders?.some(o => ['delivered', 'filled', 'uncertain'].includes(o.status));
  const ready = !!m.connected && m.account?.tradeMode === 0 && m.durableStorageReady && m.account.currency === 'USD' && m.account.marginMode === 2
    && !held && m.reason !== 'mt5-stale-quote' && m.ledger?.balance > 0 && !m.ledger.risk?.drawdownLatched && !(m.ledger.risk?.pauseUntil > Date.now());
  $('#mt5-start').disabled = !ready || m.mode === 'demo';
  $('#mt5-pause').disabled = !m.configured || m.mode !== 'demo';
  $('#mt5-rotate').disabled = !m.configured;
  $('#mt5-unlink').disabled = !m.configured || !!held;
  const form = $('#mt5-pair-form');
  if (m.configured && !form.contains(document.activeElement)) { form.elements.login.value = m.login; form.elements.server.value = m.server; form.elements.symbol.value = m.symbol; }
  const riskForm = $('#mt5-settings-form'), settings = m.settings;
  if (settings && !riskForm.contains(document.activeElement)) {
    const selected = settings.strategy || 'auto', catalog = state.config?.engine?.strategies || [];
    const picker = $('#mt5-strategy');
    picker.innerHTML = '<option value="auto">Auto · frozen research reference</option>' + catalog.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
    picker.value = selected;
    for (const key of ['riskPerTrade', 'maxLossPerTrade', 'dailyLossLimit', 'profitTarget', 'lockAfterR', 'trailAfterR', 'trailByR']) riskForm.elements[key].value = settings[key];
    for (const key of ['compoundProfits', 'lockInProfit', 'trailing']) riskForm.elements[key].checked = settings[key];
  }
  $('#mt5-orders').innerHTML = m.orders?.length ? m.orders.slice(0, 30).map(o => `<tr><td>${time(o.at)}</td><td>${esc(o.side || '—')}</td><td>${esc(o.symbol)}</td><td>${esc(o.status)}</td><td>${o.volume == null ? '—' : esc(o.volume)}</td><td>${o.pnl == null ? 'Unsettled' : money(o.pnl)}</td></tr>`).join('') : '<tr><td colspan="6">No MT5 order receipts.</td></tr>';
  const note = $('#mt5-overview-note');
  note.classList.toggle('hidden', !m.configured);
  note.textContent = `MT5 ${m.mode === 'demo' ? 'DEMO entries active' : 'monitoring / paused'} — inspect terminal positions and broker receipts in Wallet. The cards and chart below remain PAPER results, not MT5 equity or fills.`;
}
async function loadMt5() {
  if (!state.user) return;
  try { const result = await api('/api/mt5/status'); if (state.user) { state.user.mt5 = result.mt5; renderMt5(); } }
  catch (error) { if (error.status === 401) showAuth(); else $('#mt5-status').textContent = 'Terminal status unavailable. No new execution was confirmed.'; }
}
$('#mt5-pair-form').onsubmit = async event => {
  event.preventDefault(); const button = $('#mt5-pair-button'); clearMt5Token(); setBusy(button, true);
  try {
    const result = await api('/api/mt5/pair', { method: 'POST', body: Object.fromEntries(new FormData(event.target)) });
    state.user.mt5 = result.mt5; renderMt5(); showMt5Token(result.token);
    toast('Terminal pairing created. Keep the token private; no order was placed.');
  } catch (error) { toast(error.message, 'error'); } finally { setBusy(button, false); }
};
$('#mt5-settings-form').onsubmit = async event => {
  event.preventDefault(); const form = event.target, button = $('button[type="submit"]', form), body = {};
  body.strategy = form.elements.strategy.value;
  for (const key of ['riskPerTrade', 'maxLossPerTrade', 'dailyLossLimit', 'profitTarget', 'lockAfterR', 'trailAfterR', 'trailByR']) body[key] = Number(form.elements[key].value);
  for (const key of ['compoundProfits', 'lockInProfit', 'trailing']) body[key] = form.elements[key].checked;
  setBusy(button, true);
  try { const result = await api('/api/mt5/settings', { method: 'POST', body }); state.user.mt5 = result.mt5; renderMt5(); toast('MT5 settings saved for new entries. Existing risk reservations remain intact.'); }
  catch (error) { toast(error.message, 'error'); } finally { setBusy(button, false); }
};
$('#mt5-copy-token').onclick = async () => {
  const value = $('#mt5-pair-token').value; if (!value) return;
  try { await navigator.clipboard.writeText(value); toast('Copied. Paste only into your local agent; clear the clipboard afterward.'); }
  catch (error) { toast('Clipboard permission denied. Re-pair from a supported HTTPS browser.', 'warn'); }
};
$('#mt5-hide-token').onclick = clearMt5Token;
$('#mt5-refresh').onclick = loadMt5;
$('#mt5-start').onclick = async event => {
  const button = event.currentTarget;
  const m = state.user?.mt5;
  if (!m || !confirm(`Start practice-fund MT5 orders on ${m.login} at ${m.server}, ${m.symbol}? Planned risk is at most $1/trade and 1.5% of equity, subject to tighter configured budgets. Broker costs and gaps can exceed planned risk. This is separate from the paper engine and real-money execution stays disabled.`)) return;
  setBusy(button, true);
  try { const result = await api('/api/mt5/start', { method: 'POST', body: { confirmation: 'MT5_DEMO_ONLY' } }); state.user.mt5 = result.mt5; renderMt5(); toast('MT5 demo entries enabled. The local agent must also opt in.'); }
  catch (error) { toast(error.message, 'error'); } finally { setBusy(button, false); renderMt5(); }
};
$('#mt5-pause').onclick = async () => {
  try { const result = await api('/api/mt5/pause', { method: 'POST', body: {} }); state.user.mt5 = result.mt5; renderMt5(); toast('New MT5 entries paused. Existing positions were not claimed closed.', 'warn'); }
  catch (error) { toast(error.message, 'error'); }
};
$('#mt5-rotate').onclick = async () => {
  if (!confirm('Rotate the agent token and pause new entries? Existing exposure and risk history are retained. Restart the same agent with its existing journal.')) return;
  clearMt5Token();
  try { const result = await api('/api/mt5/rotate-token', { method: 'POST', body: {} }); state.user.mt5 = result.mt5; renderMt5(); showMt5Token(result.token); }
  catch (error) { toast(error.message, 'error'); }
};
$('#mt5-unlink').onclick = async () => {
  if (!confirm('Unpair this flat terminal? Its risk history is retained and does not reset when re-paired.')) return;
  clearMt5Token();
  try { const result = await api('/api/mt5/unlink', { method: 'POST', body: {} }); state.user.mt5 = result.mt5; renderMt5(); }
  catch (error) { toast(error.message, 'error'); }
};

/* Boot */
(async function init() {
  $('#license-field').classList.remove('hidden');
  try { state.config = await api('/api/config/public'); renderDerivSetup(state.config); updateFeed(state.config.derivStatus, state.config.derivLastError); $('#app-version').textContent = state.config.version; if (state.config.derivStatus === 'live') setLoginStatus('Deriv public feed connected · Private sign-in', 'ok'); } catch (e) {}
  try { const me = await api('/api/auth/me'); await showApp(me); }
  catch (e) { showAuth(); }
})();
