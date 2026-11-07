'use strict';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const state = {
  user: null, bot: null, config: null, mode: 'login', view: 'overview',
  symbol: 'XAUUSD', chart: [], firstPrice: null, stream: null, poll: null,
  configPoll: null, formReady: false, desk: null, adminConfig: null
};
const viewMeta = {
  overview: ['Overview', 'Your trading operation at a glance.'],
  trading: ['Trading desk', 'Live exposure and a complete execution audit trail.'],
  markets: ['Market intelligence', 'Activity, macro events and desk reports.'],
  wallet: ['Deriv wallet', 'Your account, balance and execution mode.'],
  support: ['Support centre', 'Manual, protection rules and how to reach us.'],
  users: ['Users & licenses', 'Client access and subscription management.'],
  engine: ['Engine lab', 'Springboks signal fusion and online learning.'],
  settings: ['Platform settings', 'Connectivity, maintenance and data resilience.']
};
const errorMessages = {
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
  'not-authenticated': 'Your session has expired. Please sign in again.'
};

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}
function money(n, currency = 'USD') {
  const value = Number(n) || 0;
  return (value < 0 ? '-' : '') + currencySymbol(currency) + Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
function closeModal() { $('#modal').classList.add('hidden'); $('#modal-content').innerHTML = ''; }
function modal(html) { $('#modal-content').innerHTML = html; $('#modal').classList.remove('hidden'); setTimeout(() => $('#modal-content input, #modal-content select')?.focus(), 40); }

function stopPolling() { clearInterval(state.poll); clearInterval(state.configPoll); }
function showAuth() {
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
  $$('.admin-nav, .admin-view').forEach(el => el.classList.toggle('hidden', state.user.role !== 'admin'));
  $('#welcome-title').textContent = `Good to see you, ${state.user.email.split('@')[0]}.`;
  if (!$('#symbol-select').options.length) {
    const symbols = await api('/api/market/symbols');
    $('#symbol-select').innerHTML = symbols.symbols.map(s => `<option value="${s}">${s}</option>`).join('');
  }
  state.symbol = state.bot.symbol || 'XAUUSD';
  $('#symbol-select').value = state.symbol;
  await loadPairPicker();
  populateBotForm(); updateBot(state.bot); renderWallet();
  maybeShowManual();
  connectStream();
  clearInterval(state.poll); clearInterval(state.configPoll);
  state.poll = setInterval(pollBot, 1800);
  state.configPoll = setInterval(loadPublicConfig, 10000);
  loadPublicConfig();
  const params = new URLSearchParams(location.search);
  if (params.get('deriv') === 'linked') toast('Deriv account linked successfully.');
  if (params.get('deriv') && !['linked'].includes(params.get('deriv'))) toast('Deriv sign-in could not be completed. Try a Personal Access Token instead.', 'error');
  history.replaceState({}, '', location.pathname);
}
/* The client chooses the market. The bot recommends the pair with the firmest
   signals right now, so someone who does not know the markets can just accept it. */
async function loadPairPicker() {
  const sel = $('#bot-symbol'), hint = $('#best-pair-hint');
  if (!sel) return;
  try {
    if (!sel.options.length || sel.options.length === 1) {
      const list = await api('/api/market/symbols');
      sel.innerHTML = list.symbols.map(x => `<option value="${x}">${x}</option>`).join('');
      sel.value = state.bot.symbol || 'XAUUSD';
    }
    const pick = await api('/api/market/best-pair');
    if (pick && pick.best) {
      state.bestPair = pick.best;
      if (hint) hint.textContent = `Bot suggests ${pick.best} — ${pick.note}`;
      // offer one-click acceptance without ever overriding a deliberate choice
      if (!sel.dataset.touched) sel.value = pick.best;
    } else if (hint) {
      hint.textContent = pick && pick.note ? pick.note : 'Any pair is fine to start with.';
    }
  } catch (e) {
    if (hint) hint.textContent = 'You can trade any pair.';
  }
}
/* User manual: auto-shown once per client on first login, and re-openable any
   time from Platform settings or the Support centre without marking it seen. */
function showManualOverlay(markSeen) {
  const overlay = $('#manual-overlay');
  if (!overlay) return;
  overlay.classList.remove('hidden');
  document.body.classList.add('modal-open');
  const ok = $('#manual-ok');
  if (ok) ok.onclick = async ev => {
    if (ev) ev.preventDefault();
    overlay.classList.add('hidden');
    document.body.classList.remove('modal-open');
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
  ['lots', 'maxTrades', 'tp', 'sl', 'aggression', 'profitTarget', 'riskPerTrade'].forEach(k => { if (f.elements[k]) f.elements[k].value = b[k]; });
  if (f.elements.strategy) f.elements.strategy.value = b.strategy || 'auto';
  if (f.elements.autoRisk) f.elements.autoRisk.checked = b.autoRisk !== false;
  if (f.elements.maxLossPerTrade && b.maxLossPerTrade != null) f.elements.maxLossPerTrade.value = b.maxLossPerTrade;
  if (f.elements.dailyLossLimit && b.dailyLossLimit != null) f.elements.dailyLossLimit.value = b.dailyLossLimit;
  if (f.elements.lockInProfit) f.elements.lockInProfit.checked = b.lockInProfit !== false;
  f.elements.trailing.checked = !!b.trailing;
  // Reflect the saved preset without re-applying it over the loaded values.
  selectPreset(b.preset || 'safe', false);
  $('#aggression-output').value = `${b.aggression} / 10`;
  updateRange(); updateRiskUI(); state.formReady = true;
}
function updateRange() {
  const r = $('#aggression'), pct = ((r.value - 1) / 9) * 100;
  r.style.background = `linear-gradient(to right, var(--accent) 0 ${pct}%, rgba(255,255,255,.1) ${pct}%)`;
  $('#aggression-output').value = `${r.value} / 10`;
}

/* ---------------------------------------------------- strategy + risk UI */
const GRADE_LABELS = { best: 'BEST', excellent: 'EXCELLENT', good: 'GOOD', average: 'AVERAGE', weak: 'WEAK' };
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
  const lead = list.find(s => s.id === engine.defaultStrategy);
  const gradeLabel = s => GRADE_LABELS[s.grade] || '';
  sel.innerHTML = [
    `<option value="auto">Auto — trades the best-rated strategy${lead && lead.winRate != null ? ' (' + (lead.winRate * 100).toFixed(1) + '% win)' : ''}</option>`,
    ...list.map(s => {
      const rate = s.winRate == null ? '' : ` — ${(s.winRate * 100).toFixed(1)}% win`;
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
      return `<span class="grade-chip ${g}" title="${esc(s.tagline || '')} · ${esc(String(s.trades || 0))} validated trades">` +
        `<b>${esc(s.name)}</b><i>${esc(GRADE_LABELS[g] || g)}</i><em>${win} win</em></span>`;
    }).join('');
  }
  sel.value = current;
  const hint = $('#strategy-hint');
  if (hint) {
    hint.textContent = current === 'auto'
      ? `Auto trades the leader: ${strategyName(engine.defaultStrategy)}${lead && lead.winRate != null ? ' with a ' + (lead.winRate * 100).toFixed(1) + '% validated win rate' : ''}.`
      : 'Pinned to one strategy. You can change this at any time, even while the bot runs.';
  }
}
const PRESETS = {
  safe: { label: 'Safe', copy: 'Smallest losses, profits protected, trading stops for the day after a small drawdown. Best for a first run.',
    riskPerTrade: 1, maxLossPerTrade: 1, dailyLossLimit: 5, maxTrades: 1, aggression: 4 },
  balanced: { label: 'Balanced', copy: 'Slightly larger positions and two open trades. Still protected by a daily stop.',
    riskPerTrade: 2, maxLossPerTrade: 2, dailyLossLimit: 10, maxTrades: 2, aggression: 6 },
  aggressive: { label: 'Aggressive', copy: 'For when you understand the risk. Bigger positions, bigger swings — the daily stop still applies.',
    riskPerTrade: 5, maxLossPerTrade: 5, dailyLossLimit: 25, maxTrades: 3, aggression: 8 }
};
function selectPreset(name, apply = true) {
  const p = PRESETS[name] || PRESETS.safe;
  $$('.preset-btn').forEach(b => b.classList.toggle('active', b.dataset.preset === name));
  const hidden = $('#preset-value'); if (hidden) hidden.value = name;
  const copy = $('#preset-copy'); if (copy) copy.textContent = p.copy;
  if (!apply) return;
  const form = $('#quick-bot-form'); if (!form) return;
  const el = form.elements;
  if (el.riskPerTrade) { el.riskPerTrade.value = p.riskPerTrade; }
  if (el.maxLossPerTrade) el.maxLossPerTrade.value = p.maxLossPerTrade;
  if (el.dailyLossLimit) el.dailyLossLimit.value = p.dailyLossLimit;
  if (el.maxTrades) el.maxTrades.value = p.maxTrades;
  if (el.aggression) el.aggression.value = p.aggression;
  updateRiskUI();
}
$$('.preset-btn').forEach(btn => { btn.onclick = () => selectPreset(btn.dataset.preset); });

function riskCopy(pct) {
  const p = Number(pct) || 2;
  const level = p <= 1 ? 'Very cautious' : p <= 3 ? 'Balanced' : p <= 8 ? 'Aggressive' : 'Very aggressive';
  return `${level}: roughly ${p}% of your balance is at risk on each trade. Higher risk means bigger gains and bigger losses.`;
}
function updateRiskUI() {
  const on = $('#quick-bot-form') && $('#quick-bot-form').elements.autoRisk.checked;
  const wrap = $('#risk-pct-wrap'), lots = $('#lots-input'), note = $('#lots-note');
  if (wrap) wrap.style.opacity = on ? '1' : '.45';
  if (lots) lots.disabled = !!on;
  if (note) note.textContent = on ? 'Ignored while risk-based sizing is on.' : 'Your own stake is used for every trade.';
  const out = $('#risk-output'), range = $('#risk-per-trade');
  if (out && range) out.value = `${Number(range.value).toFixed(1)}%`;
  const rn = $('#risk-note');
  if (rn && range) rn.textContent = riskCopy(range.value);
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
async function loadPublicConfig() {
  try {
    const config = await api('/api/config/public'); state.config = config;
    $('#app-version').textContent = config.version;
    updateFeed(config.derivStatus, config.derivLastError);
    if (state.view === 'engine') renderEngine(config.engine);
    renderStrategySelect();
    applyMaintenance(config);
  } catch (e) { /* keep the last good status */ }
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
  } catch (e) { if (e.status === 401) showAuth(); }
}
function updateBot(b) {
  if (!b) return;
  const trades = b.trades || [];
  const closed = Math.max(b.closedTrades || 0, trades.length);
  const wins = closed ? (b.closedWins || trades.filter(t => t.pnl > 0).length) : 0;
  $('#stat-balance').textContent = money(b.balance);
  $('#stat-profit').textContent = money(b.profit);
  $('#stat-profit').className = b.profit > 0 ? 'positive' : b.profit < 0 ? 'negative' : '';
  $('#stat-peak').textContent = `All-time peak ${money(b.peakProfit)}`;
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
  $('#positions-table').innerHTML = positions.map(p => `<tr><td>${time(p.at)}</td><td><b>${esc(state.bot.symbol)}</b></td><td><span class="side-tag ${p.dir.toLowerCase()}">${p.dir}</span></td><td>${p.lots}</td><td>${price(p.entry)}</td><td>${Number(p.score || 0).toFixed(2)}</td><td><span class="tag ${p.contractId ? 'live' : ''}">${p.livePending ? 'PLACING' : p.liveFailed ? 'LIVE FAILED' : p.contractId ? 'DERIV OPEN' : 'MANAGED'}</span></td></tr>`).join('');
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
  const rising = values[values.length - 1] >= values[0], color = rising ? '#b8f56a' : '#ff7c85';
  ctx.clearRect(0, 0, W, H);
  const gradient = ctx.createLinearGradient(0, pad.top, 0, H);
  gradient.addColorStop(0, rising ? 'rgba(184,245,106,.20)' : 'rgba(255,107,117,.18)'); gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.beginPath(); ctx.moveTo(x(0), H - pad.bottom);
  values.forEach((v, i) => ctx.lineTo(x(i), y(v)));
  ctx.lineTo(x(values.length - 1), H - pad.bottom); ctx.closePath(); ctx.fillStyle = gradient; ctx.fill();
  ctx.beginPath(); values.forEach((v, i) => i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)));
  ctx.strokeStyle = color; ctx.lineWidth = 1.7; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.shadowColor = rising ? 'rgba(184,245,106,.25)' : 'rgba(255,107,117,.25)'; ctx.shadowBlur = 8; ctx.stroke(); ctx.shadowBlur = 0;
  const lx = x(values.length - 1), ly = y(values[values.length - 1]);
  ctx.beginPath(); ctx.arc(lx, ly, 3.2, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
  ctx.beginPath(); ctx.arc(lx, ly, 7, 0, Math.PI * 2); ctx.fillStyle = rising ? 'rgba(184,245,106,.12)' : 'rgba(255,107,117,.12)'; ctx.fill();
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
  if (!viewMeta[view] || (['users', 'engine', 'settings'].includes(view) && state.user?.role !== 'admin')) return;
  state.view = view;
  $$('.view').forEach(el => el.classList.toggle('active', el.id === `view-${view}`));
  $$('.nav-item').forEach(el => {
    const active = el.dataset.view === view;
    el.classList.toggle('active', active);
    if (active) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
  });
  $('#page-title').textContent = viewMeta[view][0]; $('#page-subtitle').textContent = viewMeta[view][1];
  $('#sidebar').classList.remove('open'); $('#sidebar-scrim').classList.remove('visible');
  if (view === 'markets') loadDesk();
  if (view === 'users') loadAdminUsers();
  if (view === 'engine') loadEngine();
  if (view === 'settings') loadSettings();
  window.scrollTo({ top: 0, behavior: 'smooth' });
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
  checkDerivHealth(true);
  updateExecutionMode();
}
function updateExecutionMode() {
  const live = !!state.bot?.live;
  $('#execution-mode-title').textContent = live ? 'DERIV LIVE' : 'SIMULATED';
  $('#execution-mode-title').className = live ? 'negative' : 'positive';
  $('#execution-mode-copy').textContent = live ? 'Real contracts are placed on the linked Deriv account.' : 'Practice execution with transparent simulated P/L.';
  // Simulated execution is an active, healthy state (green); LIVE is armed, so
  // it takes the amber caution dot while the title stays red.
  $('#mode-dot').className = `status-dot ${live ? 'warn' : ''}`;
}

function syncBoardControls(config) {
  const frozen = !!(config.maintenance && config.maintenance.enabled);
  const free = !config.licenseRequired;
  const mt = $('#board-maintenance'), fr = $('#board-free'), st = $('#board-state');
  if (mt) mt.checked = frozen;
  if (fr) fr.checked = free;
  if (st) {
    st.textContent = frozen ? 'MAINTENANCE' : 'LIVE';
    st.className = 'tag ' + (frozen ? 'warn' : 'live');
  }
  renderFootprint();
}
async function renderFootprint() {
  const box = $('#board-footprint');
  if (!box) return;
  try {
    const h = await api('/api/health');
    const m = h.memory || {};
    box.innerHTML = [
      `<span>MEMORY <b>${m.usedMb ?? '—'} / ${m.limitMb ?? '—'} MB</b></span>`,
      `<span>USED <b>${m.pct ?? '—'}%</b></span>`,
      `<span>UPTIME <b>${Math.round((h.uptime || 0) / 60)}m</b></span>`,
      `<span>FEED <b>${h.deriv && h.deriv.live ? 'DERIV LIVE' : 'SIMULATOR'}</b></span>`,
      `<span>ENGINE <b>${esc((h.engine && h.engine.defaultStrategy) || '—')}</b></span>`
    ].join('');
  } catch (e) { box.textContent = 'Footprint unavailable.'; }
}
async function applyBoardState() {
  const wantFrozen = $('#board-maintenance').checked;
  const wantFree = $('#board-free').checked;
  const cfg = state.config || {};
  const isFrozen = !!(cfg.maintenance && cfg.maintenance.enabled);
  const isFree = !cfg.licenseRequired;
  try {
    if (wantFrozen !== isFrozen) {
      if (wantFrozen && !confirm('Take the board down for clients? Their bots are flattened and every trade action is refused until you switch it back on.')) { syncBoardControls(cfg); return; }
      const r = await api('/api/admin/maintenance', { method: 'PUT', body: { enabled: wantFrozen, message: wantFrozen ? 'We are upgrading the Springbok engine. Trading is paused for a short while.' : '', version: cfg.version } });
      toast(wantFrozen ? `Board frozen — ${r.stopped || 0} client bot(s) stopped.` : 'Board live again.', wantFrozen ? 'warn' : 'success', 6000);
    }
    if (wantFree !== isFree) {
      if (!wantFree && !confirm('Require license keys again? Every client is signed out until you send them a key.')) { syncBoardControls(state.config); return; }
      const r = await api('/api/admin/license-required', { method: 'PUT', body: { required: !wantFree } });
      toast(wantFree ? 'Free mode on — anyone can try the bot.' : `Keys required — ${r.loggedOut || 0} client session(s) ended.`, wantFree ? 'success' : 'warn', 6000);
    }
    await loadPublicConfig(); await loadAdminConfig();
  } catch (e) { toast(e.message, 'error'); }
}
$('#board-save').onclick = applyBoardState;
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
    const [users, licenses, stats] = await Promise.all([api('/api/admin/users'), api('/api/admin/licenses'), api('/api/admin/stats')]);
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
    const f = $('#integration-form'); f.elements.derivAppId.value = data.config.derivAppId; f.elements.derivOAuthMode.value = data.config.derivOAuthMode; f.elements.googleClientId.value = data.config.googleClientId;
    syncBoardControls(data.config);
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
$('#menu-btn').onclick = () => { $('#sidebar').classList.add('open'); $('#sidebar-scrim').classList.add('visible'); };
$('#sidebar-scrim').onclick = () => { $('#sidebar').classList.remove('open'); $('#sidebar-scrim').classList.remove('visible'); };
$('#modal-close').onclick = closeModal;
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
    const d = (state.user && state.user.deriv) || null;
    const isReal = !!(state.bot && state.bot.live && d && !d.isVirtual);
    const mode = isReal ? 'REAL' : (d ? 'DEMO' : 'SIMULATION');
    const money0 = n => (n == null || !Number.isFinite(Number(n))) ? '—' : `$${Number(n).toFixed(2)}`;
    const bal = isReal ? d.balance : (Number(body.startBalance) || (state.bot && state.bot.balance));
    const cap = Number(body.maxLossPerTrade) > 0 ? Number(body.maxLossPerTrade)
      : (Number(bal) > 0 ? Math.max(0.05, Number(bal) * 0.01) : null);
    const daily = Number(body.dailyLossLimit) > 0 ? Number(body.dailyLossLimit) : null;
    const cls = isReal ? 'real' : 'demo';
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
          <div class="tc-row"><span>Maximum loss per trade</span><b class="${cls}">${money0(cap)}</b></div>
          <div class="tc-row"><span>Stop trading after</span><b>${daily ? money0(daily) : 'no daily loss limit'}</b></div>
          <div class="tc-row"><span>Risk per trade</span><b>${Number(body.riskPerTrade) || 1}%</b></div>
        </div>
        <div class="tc-risk ${cls}">
          ${isReal
            ? '<b>You are trading REAL money.</b> Losses are real and are not refundable. Your maximum loss on a single trade is capped at the figure above, but a run of losses can still reduce your balance. Only continue with money you can afford to lose.'
            : (d
              ? '<b>This is a DEMO account.</b> No real funds are at risk — practice money only. Switching to your real account is required before any real contract can be placed.'
              : '<b>Simulation mode.</b> No Deriv account is linked, so nothing is placed on any market. These results are simulated.')}
        </div>
        <div class="tc-actions">
          <button type="button" class="btn btn-ghost" data-tc="cancel">Cancel</button>
          <button type="button" class="btn ${isReal ? 'btn-danger' : 'btn-primary'}" data-tc="ok">
            ${isReal ? 'I understand — trade real money' : 'Confirm and start'}
          </button>
        </div>
      </div>`;
    modal(html);
    const done = ok => {
      const close = document.querySelector('#modal-close');
      if (close) close.click();
      document.querySelectorAll('#modal-content [data-tc]').forEach(b => { b.onclick = null; });
      resolve(ok);
    };
    document.querySelectorAll('#modal-content [data-tc]').forEach(b => {
      b.onclick = () => done(b.dataset.tc === 'ok');
    });
    const closeBtn = document.querySelector('#modal-close');
    if (closeBtn) { const prev = closeBtn.onclick; closeBtn.onclick = ev => { if (prev) prev(ev); resolve(false); }; }
  });
}

$('#quick-bot-form').onsubmit = async e => {
  e.preventDefault(); const btn = $('#start-bot'), body = Object.fromEntries(new FormData(e.target));
  const symEl = e.target.elements.symbol;
  body.symbol = (symEl && symEl.value) || state.symbol;
  state.symbol = body.symbol;
  if ($('#symbol-select')) $('#symbol-select').value = body.symbol;
  const balEl = e.target.elements.startBalance;
  const declared = balEl ? Number(balEl.value) : 0;
  if (declared > 0) body.startBalance = declared;
  body.trailing = e.target.elements.trailing.checked;
  body.autoRisk = e.target.elements.autoRisk.checked;
  body.riskPerTrade = Number(e.target.elements.riskPerTrade.value) || 1;
  body.strategy = e.target.elements.strategy.value || 'auto';
  body.preset = e.target.elements.preset ? e.target.elements.preset.value : 'safe';
  body.lockInProfit = e.target.elements.lockInProfit ? e.target.elements.lockInProfit.checked : true;
  body.maxLossPerTrade = Number(e.target.elements.maxLossPerTrade && e.target.elements.maxLossPerTrade.value) || 0;
  body.dailyLossLimit = Number(e.target.elements.dailyLossLimit && e.target.elements.dailyLossLimit.value) || 0;
  body.maxTrades = Number(e.target.elements.maxTrades.value) || 1;
  body.aggression = Number(e.target.elements.aggression.value) || 6;
  if (!body.autoRisk) body.lots = Number(e.target.elements.lots.value) || 0.01;

  /* Nothing starts until the client has seen and accepted the risks. This runs on
     EVERY press — there is no way to skip it. */
  if (!(await confirmTrade(body))) return toast('Trade cancelled — no position was opened.', 'warn');

  setBusy(btn, true, 'Starting…');
  try { const data = await api('/api/bot/start', { method: 'POST', body }); state.bot = Object.assign(data.bot, { simulation: data.simulation }); updateBot(state.bot); renderSignal(data.signal); const warm = data.simulation && data.simulation.waiting === 'warming-up' ? ` · warming up ${data.simulation.ticks}/${data.simulation.warmup} ticks` : ''; toast(`Springboks engine started on ${data.bot.symbol} in ${data.bot.live ? 'LIVE' : 'simulation'} mode${warm}.`); }
  catch (err) { toast(err.message, 'error'); } finally { setBusy(btn, false); }
};
async function stopBot(path = '/api/bot/stop') {
  try { const data = await api(path, { method: 'POST' }); state.bot = data.bot; updateBot(data.bot); toast('Engine stopped. Open positions were closed.', 'warn'); }
  catch (e) { toast(e.message, 'error'); }
}
$('#stop-bot').onclick = () => stopBot();
$('#emergency-close').onclick = () => { if (confirm('Stop the engine and close every open position now?')) stopBot('/api/bot/closeall'); };
$('#refresh-engine').onclick = () => resyncEngine('soft');
// strategy / risk changes apply immediately, even mid-run
const botSymEl = $('#bot-symbol');
if (botSymEl) botSymEl.onchange = e => { e.target.dataset.touched = '1'; state.symbol = e.target.value; };
$('#bot-strategy').onchange = async e => {
  await saveBotSettings({ strategy: e.target.value });
  renderStrategySelect(); updateBot(state.bot);
  toast(e.target.value === 'auto' ? 'Auto strategy engaged.' : `${strategyName(e.target.value)} selected.`);
};
$('#risk-per-trade').oninput = updateRiskUI;
$('#risk-per-trade').onchange = async e => {
  await saveBotSettings({ riskPerTrade: Number(e.target.value) });
  toast(`Risk per trade set to ${Number(e.target.value).toFixed(1)}%.`);
};
$('#quick-bot-form').elements.autoRisk.onchange = async e => {
  updateRiskUI();
  await saveBotSettings({ autoRisk: e.target.checked });
  updateBot(state.bot);
};

/* Deriv */
$('#deriv-token-form').onsubmit = async e => {
  e.preventDefault(); const btn = $('button[type="submit"]', e.target); setBusy(btn, true, 'Verifying…');
  try { const data = await api('/api/deriv/link', { method: 'POST', body: { token: $('#deriv-token').value } }); state.user.deriv = data.deriv; state.user.cashier = data.cashier; $('#deriv-token').value = ''; renderWallet(); toast(`Deriv ${data.deriv.isVirtual ? 'demo' : 'real'} account linked.`); }
  catch (err) { toast(err.message, 'error', 5500); } finally { setBusy(btn, false); }
};
/* Show whether the linked account can actually trade, and say so in plain words.
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
    if (r.ready) { box.classList.add('ok'); text.textContent = 'Connected — real trading armed on ' + (r.account && r.account.loginid || 'your account') + '.'; }
    else if (r.reason === 'demo-account') { box.classList.add('warn'); text.textContent = 'DEMO account connected — practice funds only. Switch to real to risk real money.'; }
    else if (r.reason === 'not-armed') { box.classList.add('warn'); text.textContent = 'Account connected. Real trading is not armed yet.'; }
    else { box.classList.add('bad'); text.textContent = r.message || 'The Deriv connection could not be confirmed.'; }
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
  try { const data = await api('/api/deriv/refresh', { method: 'POST' }); state.user.deriv = data.deriv; renderWallet(); toast('Deriv balance refreshed.'); }
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

  const money0 = n => (n == null || !Number.isFinite(Number(n))) ? '—' : `$${Number(n).toFixed(2)}`;
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
    renderAccountBar(); updateExecutionMode();
    return toast('Simulation mode — nothing is placed on any market.', 'warn');
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
      'Real money can be lost. The bot stays in simulation until you separately arm live execution.'
    );
    if (!ok) return;
  }
  try {
    const res = await api('/api/deriv/account', { method: 'POST', body: { loginid: pick.loginid } });
    state.user.deriv = res.deriv;
    state.bot.live = res.live;
    if ($('#live-toggle')) $('#live-toggle').checked = !!res.live;
    renderWallet(); renderAccountChoice(); updateExecutionMode();
    toast(mode === 'demo' ? 'DEMO account selected. No real money is at risk.' : 'REAL account selected. Arm live execution when you are ready.', mode === 'demo' ? 'success' : 'warn');
  } catch (err) { toast(err.message, 'error'); }
};

$('#live-toggle').onchange = async e => {
  if (e.target.checked) { $('#live-confirm-wrap').classList.remove('hidden'); return; }
  $('#live-confirm-wrap').classList.add('hidden'); $('#live-confirm').checked = false;
  try { const data = await api('/api/bot/live', { method: 'POST', body: { live: false } }); state.bot.live = data.live; updateBot(state.bot); updateExecutionMode(); toast('Switched to simulated execution.', 'warn'); }
  catch (err) { e.target.checked = true; toast(err.message, 'error'); }
};
$('#confirm-live').onclick = async e => {
  if (!$('#live-confirm').checked) return toast('Confirm the real-money risk acknowledgement first.', 'warn');
  setBusy(e.currentTarget, true, 'Enabling…');
  try {
    const data = await api('/api/bot/live', { method: 'POST', body: { live: true, confirm: true, stake: $('#live-stake').value } });
    state.bot.live = data.live; state.bot.liveStake = data.liveStake; $('#live-confirm-wrap').classList.add('hidden'); $('#live-confirm').checked = false;
    updateBot(state.bot); updateExecutionMode(); toast('LIVE execution enabled. Real-money contracts will be placed when the engine qualifies an entry.', 'warn', 6000);
  } catch (err) {
    $('#live-toggle').checked = false;
    $('#live-confirm-wrap').classList.add('hidden');
    /* If the account is a demo one, say exactly what to do about it. */
    toast(err.message || 'Could not enable live execution.', 'error', 7000);
    if (/demo/i.test(err.message || '')) {
      const st = $('#account-status');
      if (st) st.textContent = 'This is a DEMO account — switch to your REAL account above to trade real money.';
    }
  } finally { setBusy(e.currentTarget, false); }
};

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
  setBusy(e.currentTarget, true);
  try { const data = await api('/api/admin/backup', { method: 'POST' }); renderBackups(data.backups); toast('Private local snapshot created.'); }
  catch (err) { toast(err.message, 'error'); } finally { setBusy(e.currentTarget, false); }
};
$('#refresh-desk').onclick = loadDesk;

/* Boot */
(async function init() {
  $('#license-field').classList.remove('hidden');
  try { state.config = await api('/api/config/public'); updateFeed(state.config.derivStatus, state.config.derivLastError); $('#app-version').textContent = state.config.version; if (state.config.derivStatus === 'live') setLoginStatus('Deriv market feed connected · Encrypted credentials', 'ok'); } catch (e) {}
  try { const me = await api('/api/auth/me'); await showApp(me); }
  catch (e) { showAuth(); }
})();
