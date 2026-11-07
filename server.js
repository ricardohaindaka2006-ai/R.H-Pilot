'use strict';
/* =============================================================================
   R.H PILOT — lightweight Node.js backend
   Real accounts, server-side bots, Deriv market data and optional live contracts.
   Simulated P/L is clearly separated from real Deriv balances. Profit is never
   guaranteed. Test on a demo account before enabling real-money execution.
   ========================================================================== */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ENGINE = require('./engine/strategies.js');

/* The product ships with the owner's login so a fresh deploy is usable at once.
   Both values are overridable by env (ADMIN_EMAIL / ADMIN_PASSWORD) — set them
   in Render before going public and the env always wins. */
const OWNER_EMAIL = 'ricardohaindaka2006@gmail.com';
const OWNER_PASSWORD = process.env.ADMIN_PASSWORD || '';

const PORT = parseInt(process.env.PORT || (process.env.RENDER === 'true' ? '10000' : '3000'), 10);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const CRED_PATH = path.join(DATA_DIR, 'admin-credentials.txt');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const DERIV_WS_BASE = process.env.DERIV_WS_URL || 'wss://api.derivws.com/trading/v1/options/ws/public';
const DERIV_API_BASE = process.env.DERIV_API_URL || 'https://api.derivws.com';

let db = null;
let dbDirty = false;
let server = null;
const timers = [];

const DEFAULT_CONFIG = () => ({
  derivAppId: '1089',
  derivOAuthMode: 'new',
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  mt5BridgeUrl: '',
  appVersion: '1.0.0',
  maintenance: { enabled: false, message: '', version: '1.0.0', notes: '', startedAt: null, by: null },
  engineWeights: { trend: 1, momentum: 1, breakout: 1, reversal: 1 },
  engineStats: { scored: 0, wins: 0, losses: 0, resyncs: 0, lastUpdate: null },
  // Strategy selection. `defaultStrategy` is replaced on boot by whichever
  // strategy won the validated panel (see loadStrategyReport).
  engine: {
    defaultStrategy: 'breakout-momentum',
    report: null,        // last validated report — the numbers shown in the UI
    tuned: {},           // strategy id -> validated parameters
    minConfidence: null  // optional global floor
  },
  hub: { url: '', token: '', autoBackup: true, lastBackupAt: null, lastPushAt: null, lastPushError: '' },
  profile: {
    legalName: '', registrationNo: '', country: '',
    supportEmail: 'ricardohaindaka2006@gmail.com', supportPhone: '081 609 0300',
    companyEmail: '', assistantPhone: '', website: 'https://rhpilot.com', termsUrl: '',
    privacyUrl: '', riskUrl: '', about: ''
  },
  recovery: { googleEmail: OWNER_EMAIL, phone: '081 609 0300', whatsappWebhook: '', pending: null },
  licenseRequired: true,
  licenses: [],
  logins: [],
  mail: { webhookUrl: '', token: '', from: 'R.H PILOT <no-reply@rhpilot.com>', lastSentAt: null, lastError: '' },
  mailOutbox: [],
  calendar: [],
  news: [],
  plans: {
    days30: { price: '', blurb: 'Full bot access for 30 days.' },
    year: { price: '', blurb: 'Full bot access for a full year.' },
    lifetime: { price: '', blurb: 'Pay once — yours for life.' }
  },
  ratings: []
});

function defaultDb() { return { users: [], sessions: {}, config: DEFAULT_CONFIG(), createdAt: Date.now() }; }
function merge(defaults, value) {
  const out = Object.assign({}, defaults, value || {});
  Object.keys(defaults).forEach(k => {
    const d = defaults[k];
    if (d && typeof d === 'object' && !Array.isArray(d)) out[k] = merge(d, value && value[k]);
  });
  return out;
}
function loadDb() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    db = { users: [], sessions: {}, config: DEFAULT_CONFIG(), createdAt: Date.now(), ...parsed };
    db.users = Array.isArray(db.users) ? db.users : [];
    db.sessions = db.sessions && typeof db.sessions === 'object' ? db.sessions : {};
    db.config = merge(DEFAULT_CONFIG(), parsed.config || {});
    ['licenses', 'logins', 'mailOutbox', 'calendar', 'news', 'ratings'].forEach(k => {
      if (!Array.isArray(db.config[k])) db.config[k] = [];
    });
    if (typeof db.config.licenseRequired !== 'boolean') db.config.licenseRequired = true;
    // Owner support details power the login screen. Backfill installs that stored blanks.
    if (!db.config.profile.supportEmail || db.config.profile.supportEmail === 'support@rhpilot.com') db.config.profile.supportEmail = 'ricardohaindaka2006@gmail.com';
    if (!db.config.profile.supportPhone) db.config.profile.supportPhone = '081 609 0300';
    if (!db.config.recovery.phone) db.config.recovery.phone = '081 609 0300';
    if (!db.config.recovery.googleEmail) db.config.recovery.googleEmail = OWNER_EMAIL;
    db.config.derivOAuthMode = 'new'; // legacy Deriv OAuth/WebSocket hosts are retired
    db.users.forEach(u => {
      if (u.deriv === undefined) u.deriv = null;
      if (u.paid === undefined) u.paid = true; // grandfather pre-license accounts
      // A fresh defaults object per user prevents cross-account bot state.
      u.bot = merge(defaultBot(), u.bot || {});
      u.bot.positions = Array.isArray(u.bot.positions) ? u.bot.positions : [];
      u.bot.trades = Array.isArray(u.bot.trades) ? u.bot.trades : [];
      u.bot.milestones = Array.isArray(u.bot.milestones) ? u.bot.milestones : [];
      if (typeof u.bot.live !== 'boolean') u.bot.live = false;
      if (typeof u.bot.profitTarget !== 'number') u.bot.profitTarget = 0;
      if (typeof u.bot.peakProfit !== 'number') u.bot.peakProfit = Math.max(0, Number(u.bot.profit) || 0);
    });
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[db] invalid or unreadable database; starting clean:', e.message);
    db = defaultDb();
  }
}
function saveDb() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(slimDb()));
    fs.renameSync(tmp, DB_PATH);
    dbDirty = false;
  } catch (e) { console.error('[db] save failed:', e.message); }
}
function markDirty() { dbDirty = true; }

/* --------------------------------------------------------------------------
   Disk guard for small instances.

   Render's free plan has a 512 MB disk and the JSON store is rewritten on every
   save, so anything unbounded has to be trimmed BEFORE it is written. These
   caps keep db.json in the low hundreds of KB no matter how long a bot runs.
   -------------------------------------------------------------------------- */
const LOG_CAPS = { trades: 200, events: 80, mailOutbox: 120, logins: 300, licences: 2000, notices: 100 };
/* --------------------------------------------------------------------------
   Memory watchdog.

   The free instance gets 512 MB and a long session is the only thing that can
   push the heap up (each symbol keeps a rolling window, each user keeps logs).
   This trims before the limiter ever fires, and reports the number so the admin
   dashboard can show real headroom instead of a guess.
   -------------------------------------------------------------------------- */
const MEM_LIMIT_MB = Math.max(128, parseInt(process.env.MEM_LIMIT_MB || '512', 10));
function heapMb() { return +(process.memoryUsage().heapUsed / 1048576).toFixed(1); }
function memoryReport() {
  const used = heapMb(), limit = MEM_LIMIT_MB;
  return { usedMb: used, limitMb: limit, pct: +((used / limit) * 100).toFixed(1), rssMb: +(process.memoryUsage().rss / 1048576).toFixed(1) };
}
function memoryGuard() {
  const { pct } = memoryReport();
  if (pct > 85) {
    // Aggressive first: drop log detail, then hand the pages back.
    for (const u of db.users) { if (u.bot) { u.bot.trades.length = Math.min(u.bot.trades.length, 40); } u.events.length = Math.min(u.events.length, 20); }
    db.config.logins.length = Math.min(db.config.logins.length, 50);
    db.config.mailOutbox.length = Math.min(db.config.mailOutbox.length, 20);
    if (global.gc) global.gc();
    console.warn('[mem] trimmed at ' + pct + '% of ' + MEM_LIMIT_MB + ' MB');
  } else if (pct > 70) {
    slimDb();
  }
}

function slimDb() {
  const keep = (arr, n) => (Array.isArray(arr) && arr.length > n ? (arr.length = n, arr) : arr);
  for (const k of ['licenses', 'logins', 'mailOutbox']) keep(db.config && db.config[k], LOG_CAPS[k === 'licenses' ? 'licences' : k]);
  keep(db.config && db.config.news, 100);
  keep(db.config && db.config.ratings, 300);
  for (const u of (db.users || [])) {
    keep(u.events, LOG_CAPS.events);
    if (u.bot) { keep(u.bot.trades, LOG_CAPS.trades); keep(u.bot.positions, 20); }
  }
  for (const [token, s] of Object.entries(db.sessions || {})) {
    if (!s || (s.exp && s.exp < Date.now())) delete db.sessions[token];   // never persist dead sessions
  }
  return db;
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(String(pw), salt, 64).toString('hex');
}
function verifyPassword(pw, stored) {
  try {
    const parts = String(stored || '').split(':');
    if (parts.length !== 2) return false;
    const hash = crypto.scryptSync(String(pw), parts[0], 64);
    const want = Buffer.from(parts[1], 'hex');
    return hash.length === want.length && crypto.timingSafeEqual(hash, want);
  } catch (e) { return false; }
}

/* A single trade may never risk more than this share of the account, no matter
   what risk % or lot size the client picks. This is the "don't blow up" floor. */
const MAX_TRADE_RISK_PCT = 1.5;

function defaultBot() {
  const bot = {
    running: false, symbol: 'XAUUSD', lots: 0.01, tp: 10, sl: 2.5,
    maxTrades: 3, aggression: 6, trailing: true, live: false, liveStake: 1,
    // --- client-controlled risk -------------------------------------------
    // Preset: the proven, locked-in defaults a client gets on first login.
    // 'safe'      -> smallest losses, daily stop, best validated strategy
    // 'balanced'  -> more trades, slightly more risk
    // 'aggressive'-> the client knows what they are doing and wants more
    // 'custom'    -> they moved something by hand
    preset: 'safe',
    // Lock in profit: once a position has made this much, the stop moves to
    // break-even and then trails, so a winner cannot turn into a loser.
    lockInProfit: true,
    lockAfterR: 0.5,        // move stop to break-even after +0.5R
    trailAfterR: 1.0,       // start trailing after +1.0R
    trailByR: 0.4,          // trail this far behind the best price
    // strategy: 'auto' rides the validated leader; any catalogue id pins one
    strategy: 'auto',
    // autoRisk: size each trade from `riskPerTrade` (% of balance risked to the
    // stop). When false, `lots` is used verbatim — the client's own stake.
    autoRisk: true,
    riskPerTrade: 1,           // percent of balance risked per trade (0.1 – 25)
    maxLossPerTrade: 2,        // hard cash ceiling on one losing trade (0 = off)
    dailyLossLimit: 10,        // stop opening trades after this much loss in a day (0 = off)
    dayLoss: 0, lossDay: null, lastLossAt: null,
    // --- bookkeeping ------------------------------------------------------
    startBalance: 100, resyncs: 0, lastResyncAt: null,
    closedWins: 0, closedLosses: 0, closedTrades: 0,
    balance: 100, profit: 0, profitTarget: 0, targetHit: null, peakProfit: 0,
    protectProfitFrom: 0,       // 0 = profits uncapped (default)
    milestones: [], positions: [], trades: [], startedAt: null, lastEntryAt: 0
  };
  // A brand-new bot starts on the proven preset, not on hand-written numbers.
  return applyPreset(bot, 'safe');
}
/* --------------------------------------------------------------------------
   Presets.

   A new client should not have to understand risk to be safe. These three
   presets are the only knobs most people need; every individual field stays
   editable underneath for the clients who want to experiment later.
   -------------------------------------------------------------------------- */
const PRESETS = {
  safe: {
    label: 'Safe — locked in',
    copy: 'Smallest losses, profits locked in, trading pauses after a small drawdown. Best for a first run.',
    autoRisk: true, riskPct: 1, capPct: 1, dailyPct: 8, floorCap: 0.5,
    lockInProfit: true, lockAfterR: 0.5, trailAfterR: 1, trailByR: 0.4,
    maxTrades: 1, aggression: 4, strategy: 'auto'
  },
  balanced: {
    label: 'Balanced',
    copy: 'Slightly larger positions and two open trades. Still protected by a daily stop.',
    autoRisk: true, riskPct: 2, capPct: 2, dailyPct: 15, floorCap: 1,
    lockInProfit: true, lockAfterR: 0.5, trailAfterR: 1, trailByR: 0.5,
    maxTrades: 2, aggression: 6, strategy: 'auto'
  },
  aggressive: {
    label: 'Aggressive',
    copy: 'For when you understand the risk. Bigger positions, bigger swings — the daily stop still applies.',
    autoRisk: true, riskPct: 5, capPct: 5, dailyPct: 30, floorCap: 2,
    lockInProfit: true, lockAfterR: 0.6, trailAfterR: 1.2, trailByR: 0.6,
    maxTrades: 3, aggression: 8, strategy: 'auto'
  }
};
/* Money limits are a share of the account, so a $2 and a $2,000 account are both
   protected in proportion. The floor keeps them meaningful on a tiny balance. */
function scaledLimits(preset, balance) {
  const bal = Number(balance) > 0 ? Number(balance) : 100;
  /* No artificial ceiling: the limit is the chosen share of the balance at any
     size. A $100,000 account gets $1,000 a trade and $8,000 a day, exactly as the
     percentage says — a fixed $500 cap would silently throttle it. */
  const maxLossPerTrade = Math.max(0.05, bal * preset.capPct / 100);
  const dailyLossLimit = Math.max(0.25, bal * preset.dailyPct / 100);
  return {
    riskPerTrade: preset.riskPct,
    maxLossPerTrade: +maxLossPerTrade.toFixed(2),
    dailyLossLimit: +dailyLossLimit.toFixed(2)
  };
}
function applyPreset(bot, name, balance) {
  const key = PRESETS[name] ? name : 'safe';
  const p = PRESETS[key];
  if (balance != null) {
    /* The growth anchor is the balance these limits were sized on. Calls that
       pass an explicit balance are (re)sizing for it, so the anchor follows.
       Calls that pass none — a mid-run preset change — leave the anchor alone,
       so a compounding account is not reset to its first-day stake. */
    bot.balance = balance;
    bot.startBalance = balance;
  } else if (!(Number(bot.startBalance) > 0)) {
    bot.startBalance = Number(bot.balance) > 0 ? Number(bot.balance) : 100;
  }
  for (const f of ['autoRisk', 'lockInProfit', 'lockAfterR', 'trailAfterR', 'trailByR', 'maxTrades', 'aggression', 'strategy']) {
    if (p[f] !== undefined) bot[f] = p[f];
  }
  Object.assign(bot, scaledLimits(p, balance != null ? balance : bot.balance));
  bot.preset = key;
  return bot;
}

const MILESTONES = [100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000];
function noteMilestones(b, profit) {
  if (profit > (b.peakProfit || 0)) b.peakProfit = profit;
  const peak = b.peakProfit || 0;
  b.milestones = Array.isArray(b.milestones) ? b.milestones : [];
  MILESTONES.forEach(m => {
    if (peak >= m && !b.milestones.some(x => x.amount === m)) b.milestones.push({ amount: m, at: Date.now() });
  });
}
function makeUser(email, password, role) {
  return {
    id: crypto.randomUUID(), email: String(email).toLowerCase().trim(), pass: hashPassword(password),
    role: role === 'admin' ? 'admin' : 'user', active: true, paid: role === 'admin',
    provider: 'password', createdAt: Date.now(), deriv: null, bot: defaultBot()
  };
}
function derivAccountPublic(u) {
  const d = u && u.deriv;
  if (!d) return null;
  return {
    loginid: d.loginid, currency: d.currency, balance: d.balance, isVirtual: !!d.isVirtual,
    connectedAt: d.connectedAt, via: d.via || 'token', accounts: Array.isArray(d.accounts) ? d.accounts : []
  };
}
function cashierUrls(loginid) {
  const q = loginid ? ('?account=' + encodeURIComponent(loginid)) : '';
  return {
    deposit: 'https://app.deriv.com/cashier/deposit' + q,
    withdraw: 'https://app.deriv.com/cashier/withdraw' + q,
    transfer: 'https://app.deriv.com/cashier/transfer' + q,
    statement: 'https://app.deriv.com/reports/statement', platform: 'https://app.deriv.com/'
  };
}

/* ------------------------------------------------------------------ Deriv */
let undiciMod = null;
let wsMod = null;
try { undiciMod = require('undici'); } catch (e) { undiciMod = null; }
try { wsMod = require('ws'); } catch (e) { wsMod = null; }
function proxyDispatcher() {
  if (!undiciMod || !undiciMod.ProxyAgent) return null;
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!proxy) return null;
  try { return new undiciMod.ProxyAgent(proxy); } catch (e) { return null; }
}
function derivSocket(url) {
  const dispatcher = proxyDispatcher();
  if (dispatcher && undiciMod && undiciMod.WebSocket) {
    try { return new undiciMod.WebSocket(url, { dispatcher }); } catch (e) { /* fall through */ }
  }
  // Node's native Undici WebSocket can receive a non-101 response from Deriv's
  // edge. The `ws` transport provides a stable Node handshake and lets a
  // production deployment declare its real browser origin when required.
  if (wsMod && process.env.DERIV_NATIVE_WS !== '1') {
    const options = { handshakeTimeout: 12000, headers: { 'User-Agent': 'R.H-Pilot/1.0' } };
    if (process.env.DERIV_ORIGIN) options.origin = process.env.DERIV_ORIGIN;
    return new wsMod(url, options);
  }
  if (typeof WebSocket !== 'function') throw new Error('websocket-unavailable-use-node-22');
  return new WebSocket(url);
}
function derivUrl() { return DERIV_WS_BASE; }
/* Current Deriv Options API: public market calls use the public socket;
   account-scoped calls use a fresh REST-issued OTP socket. Legacy authorize(token)
   sockets were retired by Deriv and must not be used for new connections. */
function derivRequestAt(url, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = derivSocket(url); } catch (e) { return reject(e); }
    let done = false;
    const reqId = crypto.randomInt(1, 1000000000);
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.close(); } catch (e) {}
      if (err) reject(err); else resolve(val);
    };
    const timer = setTimeout(() => finish(new Error('deriv-timeout')), timeoutMs || 12000);
    if (timer.unref) timer.unref();
    ws.onopen = () => {
      try { ws.send(JSON.stringify({ req_id: reqId, ...payload })); } catch (e) { finish(e); }
    };
    ws.onmessage = ev => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch (e) { return; }
      if (msg.req_id !== undefined && msg.req_id !== reqId) return;
      if (msg.error) return finish(new Error(msg.error.message || msg.error.code || 'deriv-error'));
      if (Array.isArray(msg.errors) && msg.errors.length) return finish(new Error(msg.errors[0].message || msg.errors[0].code || 'deriv-error'));
      finish(null, msg);
    };
    ws.onerror = e => finish(new Error('deriv-socket-error' + (e && e.message ? ': ' + e.message : '')));
    ws.onclose = () => finish(new Error('deriv-socket-closed'));
  });
}
const derivRequest = (payload, timeoutMs) => derivRequestAt(derivUrl(), payload, timeoutMs);
const derivCall = (payload, timeoutMs) => derivRequest(payload, timeoutMs);
async function derivRest(endpoint, token, method = 'GET') {
  const response = await fetch(DERIV_API_BASE + endpoint, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      'Deriv-App-ID': String(db.config.derivAppId || ''),
      Accept: 'application/json'
    },
    signal: AbortSignal.timeout(12000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = Array.isArray(result.errors) && result.errors[0];
    throw new Error('deriv-rest-' + response.status + (detail && detail.message ? ': ' + detail.message : ''));
  }
  return result.data;
}
async function derivAuthCall(account, payload, timeoutMs) {
  if (!account || !account.token || !account.loginid) throw new Error('deriv-account-required');
  const data = await derivRest('/trading/v1/options/accounts/' + encodeURIComponent(account.loginid) + '/otp', account.token, 'POST');
  if (!data || !data.url || !data.url.startsWith('wss://api.derivws.com/')) throw new Error('deriv-otp-failed');
  return derivRequestAt(data.url, payload, timeoutMs);
}
async function derivFetchAccount(token, preferredAccountId) {
  const tok = String(token || '').trim();
  if (!tok) throw new Error('missing-token');
  const data = await derivRest('/trading/v1/options/accounts', tok);
  const list = Array.isArray(data) ? data : (data && Array.isArray(data.accounts) ? data.accounts : data ? [data] : []);
  const active = list.filter(x => x && x.account_id && (!x.status || x.status === 'active'));
  if (!active.length) throw new Error('deriv-no-options-accounts');
  // Never silently select a real account when several are returned. Prefer the
  // previously linked account, then the demo account, then the only choice.
  const selected = active.find(x => x.account_id === preferredAccountId) ||
    active.find(x => x.account_type === 'demo') || (active.length === 1 ? active[0] : null);
  if (!selected) throw new Error('deriv-account-selection-required');
  const accounts = active.map(x => ({
    loginid: x.account_id, currency: x.currency || 'USD', isVirtual: x.account_type === 'demo',
    balance: Number.isFinite(Number(x.balance)) ? Number(x.balance) : null
  }));
  return {
    loginid: selected.account_id, currency: selected.currency || 'USD',
    balance: Number.isFinite(Number(selected.balance)) ? Number(selected.balance) : null,
    isVirtual: selected.account_type === 'demo', email: null, country: null, accounts
  };
}
function derivRedirectUri(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || ('localhost:' + PORT);
  return proto + '://' + host + '/api/auth/deriv/callback';
}
function derivOAuthEndpoints() {
  return { mode: 'new', auth: 'https://auth.deriv.com/oauth2/auth', token: 'https://auth.deriv.com/oauth2/token' };
}
function derivOAuthStartUrl(req, state, challenge) {
  const appId = encodeURIComponent(db.config.derivAppId || '1089');
  const e = derivOAuthEndpoints();
  const redirect = encodeURIComponent(derivRedirectUri(req));
  return e.auth + '?response_type=code&client_id=' + appId + '&redirect_uri=' + redirect +
    '&scope=' + encodeURIComponent('trade') + '&state=' + state +
    '&code_challenge=' + encodeURIComponent(challenge) + '&code_challenge_method=S256';
}
async function derivOAuthExchange(code, req, verifier) {
  const e = derivOAuthEndpoints();
  const body = new URLSearchParams({
    grant_type: 'authorization_code', client_id: String(db.config.derivAppId || '1089'),
    code: String(code), redirect_uri: derivRedirectUri(req)
  });
  if (!verifier) throw new Error('deriv-oauth-verifier-missing');
  body.set('code_verifier', verifier);
  const r = await fetch(e.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('deriv-oauth-failed');
  return j.access_token;
}
async function derivPlaceTrade(account, o) {
  const proposal = await derivAuthCall(account, {
    proposal: 1, amount: Number(o.stake), basis: 'stake',
    contract_type: o.direction === 'BUY' ? 'CALL' : 'PUT', currency: account.currency || 'USD',
    duration: Number(o.duration || 5), duration_unit: o.durationUnit || 'm', underlying_symbol: DERIV_SYMBOLS[o.symbol]
  });
  const id = proposal && proposal.proposal && proposal.proposal.id;
  if (!id) throw new Error('deriv-proposal-failed');
  const bought = await derivAuthCall(account, { buy: id, price: Number(o.stake) });
  return (bought && bought.buy) || null;
}
async function derivSellContract(account, contractId, price) {
  const body = { sell: String(contractId) };
  if (price != null) body.price = Number(price);
  const r = await derivAuthCall(account, body);
  return (r && r.sell) || null;
}

/* --------------------------------------------------------------------------
   Admin credential sync.

   The owner controls the admin login through env (ADMIN_EMAIL / ADMIN_PASSWORD).
   On every boot we make sure that login actually works: correct address on the
   admin account, and the env password accepted. This is what stops "I set the
   password but it still says invalid" after a redeploy or a wiped data volume.
   -------------------------------------------------------------------------- */
function syncAdminCredentials() {
  const email = repairEmail(process.env.ADMIN_EMAIL || OWNER_EMAIL);
  const password = process.env.ADMIN_PASSWORD || OWNER_PASSWORD || null;
  let admin = db.users.find(u => u.role === 'admin');
  if (!admin) return null;
  let changed = false;
  if (email && admin.email !== email) {
    const clash = db.users.find(u => u.id !== admin.id && u.email === email);
    if (!clash) { admin.email = email; changed = true; console.log('[boot] admin email set to ' + email); }
  }
  if (!admin.active) { admin.active = true; changed = true; console.log('[boot] admin account re-enabled'); }
  if (password && !verifyPassword(password, admin.pass)) {
    admin.pass = hashPassword(password); changed = true;
    console.log('[boot] admin password synced from ADMIN_PASSWORD env');
  }
  if (changed) saveDb();
  // Remove legacy plaintext credential files created by older releases.
  try { fs.unlinkSync(CRED_PATH); } catch (e) {}
  return admin;
}

function seedAdmin() {
  if (db.users.some(u => u.role === 'admin')) return;
  const email = repairEmail(process.env.ADMIN_EMAIL || OWNER_EMAIL);
  const password = process.env.ADMIN_PASSWORD || OWNER_PASSWORD || crypto.randomBytes(32).toString('base64url');
  db.users.push(makeUser(email, password, 'admin'));
  saveDb();
  const text = 'R.H PILOT — admin login (first run)\nEmail: ' + email + '\nPassword is managed through the ADMIN_PASSWORD environment variable in Render.\n';
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(CRED_PATH, text, { mode: 0o600 }); } catch (e) {}
  console.log('[boot] admin created: ' + email + ' (credentials: ' + CRED_PATH + ')');
}

/* --------------------------------------------------------------------------
   Login input repair.

   The most common lockout is a typo in the address, not a wrong password:
   "@namegmail.com" (no local part), "name.gmail.com" (no @), doubled dots,
   stray spaces. Repairing those before the lookup turns a dead login screen
   into a working one without weakening the password check.
   -------------------------------------------------------------------------- */
function repairEmail(raw) {
  let e = String(raw || '').toLowerCase().trim();
  if (!e) return '';
  e = e.replace(/^mailto:/, '').replace(/\[at\]|\(at\)| at /g, '@').replace(/\s+/g, '');
  if (/^@/.test(e)) e = e.slice(1);                       // "@namegmail.com" -> "namegmail.com"
  if (e.includes('@')) {
    const at = e.lastIndexOf('@');
    let local = e.slice(0, at).replace(/\.+$/, '');
    let domain = e.slice(at + 1).replace(/^\.+/, '').replace(/\.{2,}/g, '.');
    if (!local) return '';                                  // still no local part
    // "namemail.com" typo'd local part already carries the domain, leave it alone
    return local + '@' + domain;
  }
  // No @ at all: "ricardohaindaka2006gmail.com" -> insert it before the known domain
  const m = e.match(/^(.*?)(gmail\.com|googlemail\.com|yahoo\.com|outlook\.com|hotmail\.com|icloud\.com|deriv\.com)$/);
  if (m && m[1]) return m[1] + '@' + m[2];
  return e;
}

/* The admin address is fixed by env/owner config, so "which email do they mean"
   can be answered safely: if the typed address has no local part and matches the
   admin's mailbox, sign in to the admin account. */
function resolveLoginEmail(raw) {
  const typed = repairEmail(raw);
  const admins = db.users.filter(u => u.role === 'admin' && u.active);
  const known = admins.map(u => u.email).concat([db.config.recovery && db.config.recovery.googleEmail].filter(Boolean).map(x => String(x).toLowerCase()));
  if (typed && db.users.some(u => u.email === typed)) return typed;
  for (const k of known) {
    if (!k) continue;
    if (typed === k) return k;
    const local = k.split('@')[0], dom = k.split('@')[1];
    // "haindaka2006gmail.com", "ricardogmail.com", "@ricardo..." — anything that is a
    // fragment of the owner's mailbox resolves to the owner.
    if (typed && (local.includes(typed.replace(/@/g, '')) || k.replace('@', '') === typed.replace(/@/g, ''))) return k;
    if (typed && typed.endsWith(dom) && local.endsWith(typed.split('@')[0])) return k;
  }
  return typed;
}

/* --------------------------------------------------------------- sessions */
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
function appendCookie(res, value) {
  const existing = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', existing ? (Array.isArray(existing) ? existing.concat(value) : [existing, value]) : value);
}
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.sessions[token] = { userId, exp: now + SESSION_TTL, createdAt: now, seenAt: now };
  markDirty();
  return token;
}
function getSessionUser(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  const s = db.sessions[token];
  if (!s) return null;
  if (s.exp < Date.now()) { delete db.sessions[token]; markDirty(); return null; }
  const user = db.users.find(u => u.id === s.userId);
  if (!user || !user.active) return null;
  const now = Date.now();
  if (!s.seenAt) s.seenAt = s.createdAt || now;
  if (now - s.seenAt > 30000) { s.seenAt = now; markDirty(); }
  return user;
}
function revokeSession(req, res) {
  const token = parseCookies(req).sid;
  if (token && db.sessions[token]) { delete db.sessions[token]; markDirty(); }
  clearSessionCookie(res);
  clearLicenseCookie(res);
}
const ONLINE_WINDOW = 2 * 60 * 1000;
function isUserOnline(u) {
  const now = Date.now();
  return Object.values(db.sessions).some(s => s.userId === u.id && s.exp > now && now - (s.seenAt || s.createdAt || 0) < ONLINE_WINDOW);
}
function countOnline() { return db.users.filter(isUserOnline).length; }
function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > -1) {
      try { out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } catch (e) {}
    }
  });
  return out;
}
function cookieSecurity(req) { return req && (req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted) ? '; Secure' : ''; }
function setSessionCookie(res, token, req) {
  appendCookie(res, 'sid=' + token + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + Math.floor(SESSION_TTL / 1000) + cookieSecurity(req));
}
function clearSessionCookie(res) { appendCookie(res, 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'); }

const LICENSE_PLANS = {
  days30: { id: 'days30', label: '30-Day', ms: 30 * 24 * 60 * 60 * 1000 },
  year: { id: 'year', label: '1-Year', ms: 365 * 24 * 60 * 60 * 1000 },
  lifetime: { id: 'lifetime', label: 'Lifetime', ms: null }
};
function planOf(id) { return LICENSE_PLANS[id] || LICENSE_PLANS.days30; }
function planExpiry(planId, from) { const p = planOf(planId); return p.ms ? (from || Date.now()) + p.ms : null; }
const LIC_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LIC_TTL = 30 * 24 * 60 * 60 * 1000;
function genLicenseKey() {
  const grp = () => Array.from({ length: 4 }, () => LIC_ALPHA[crypto.randomInt(LIC_ALPHA.length)]).join('');
  return 'RHP-' + grp() + '-' + grp() + '-' + grp();
}
function normalizeLicenseKey(s) {
  const raw = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^RHP/, '');
  if (raw.length !== 12) return String(s || '').toUpperCase().trim();
  return 'RHP-' + raw.slice(0, 4) + '-' + raw.slice(4, 8) + '-' + raw.slice(8, 12);
}
function findLicense(key) { const k = normalizeLicenseKey(key); return db.config.licenses.find(l => l.key === k) || null; }
function setLicenseCookie(res, key) { appendCookie(res, 'lic=' + encodeURIComponent(normalizeLicenseKey(key)) + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + Math.floor(LIC_TTL / 1000)); }
function clearLicenseCookie(res) { appendCookie(res, 'lic=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'); }
function setDerivLinkCookie(res, userId) { appendCookie(res, 'derivlink=' + encodeURIComponent(userId) + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=900'); }
function clearDerivLinkCookie(res) { appendCookie(res, 'derivlink=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'); }
function setOAuthStateCookie(res, state, req) { appendCookie(res, 'derivstate=' + state + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=900' + cookieSecurity(req)); }
function clearOAuthStateCookie(res) { appendCookie(res, 'derivstate=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'); }
function setOAuthVerifierCookie(res, verifier, req) { appendCookie(res, 'derivverifier=' + verifier + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=900' + cookieSecurity(req)); }
function clearOAuthVerifierCookie(res) { appendCookie(res, 'derivverifier=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'); }

async function verifyGoogleIdentity(body) {
  const clientId = db.config.googleClientId;
  const fail = (code, httpStatus) => { const e = new Error(code); e.code = code; e.httpStatus = httpStatus || 401; return e; };
  if (!clientId) throw fail('google-not-configured', 400);
  if (!body.credential && !body.accessToken) throw fail('missing-credential', 400);
  if (body.credential) {
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(body.credential));
    const info = await r.json().catch(() => ({}));
    if (!r.ok || !info.email || info.aud !== clientId) throw fail('google-token-invalid');
    return info;
  }
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(body.accessToken));
  let info = await r.json().catch(() => ({}));
  if (!r.ok || !info.email) {
    const u = await fetch('https://www.googleapis.com/oauth2/v3/userinfo?access_token=' + encodeURIComponent(body.accessToken));
    if (!u.ok) throw fail('google-token-invalid');
    info = await u.json();
  }
  if (!info || !info.email) throw fail('google-token-invalid');
  if (info.aud && info.aud !== clientId) throw fail('google-aud-mismatch');
  return info;
}
const resetTickets = new Map();
function issueResetTicket(via) {
  const admin = db.users.find(u => u.role === 'admin' && u.active);
  if (!admin) throw new Error('no-admin');
  const ticket = crypto.randomBytes(24).toString('hex');
  resetTickets.set(ticket, { userId: admin.id, via, expiresAt: Date.now() + 15 * 60 * 1000 });
  return ticket;
}
/* --------------------------------------------------------------------------
   Licence mode + lockdown.

   These live here (not inline in the routes) so the test suite exercises the
   exact code the admin button runs.
   -------------------------------------------------------------------------- */
/* One place that freezes every client: stop the bot (flatten first, so no
   position is left running unmanaged), drop their sessions, keep the admin. */
function freezeClients(reason, opts) {
  const o = opts || {};
  const out = { stopped: 0, loggedOut: 0 };
  for (const u of db.users) {
    if (u.role === 'admin' || u.unfrozen) continue;
    if (o.stopBots !== false && u.bot && u.bot.running) {
      try { flattenBot(u, reason); u.bot.running = false; out.stopped++; } catch (e) {}
    }
    if (o.logOut) {
      for (const [token, sess] of Object.entries(db.sessions)) {
        if (sess && sess.userId === u.id) { delete db.sessions[token]; out.loggedOut++; }
      }
    }
  }
  return out;
}

function setLicenseMode(required) {
  const want = !!required, was = !!db.config.licenseRequired;
  db.config.licenseRequired = want;
  let out = { stopped: 0, loggedOut: 0 };
  if (want && !was) {
    out = freezeClients('license-required', { logOut: true });
    for (const u of db.users) if (u.role !== 'admin' && !u.licenseKey) u.paid = false;
    db.config.licenseEnforcedAt = Date.now();
  }
  saveDb();
  return { required: want, loggedOut: out.loggedOut, botsStopped: out.stopped, enforcement: want ? 'keys-required' : 'free-for-everyone' };
}

function lockdownLicenses() {
  db.config.licenseRequired = true;
  let revoked = 0;
  for (const lic of db.config.licenses) {
    if (lic.status === 'unused') { lic.status = 'revoked'; revoked++; }
  }
  const out = freezeClients('license-lockdown', { logOut: true });
  for (const u of db.users) if (u.role !== 'admin') u.paid = false;
  db.config.licenseEnforcedAt = Date.now();
  saveDb();
  return { revoked, loggedOut: out.loggedOut, botsStopped: out.stopped, required: true };
}

/* Maintenance is the "hands off the board" switch: clients keep their session
   but everything they can trade is stopped, and the API refuses bot actions. */
function isMaintenanceBlocked(user) {
  return !!(db.config.maintenance && db.config.maintenance.enabled && user && user.role !== 'admin');
}

function setMaintenance(body, by) {
  const m = db.config.maintenance, want = !!body.enabled;
  const was = m.enabled;
  m.enabled = want;
  if (typeof body.message === 'string') m.message = body.message.slice(0, 600);
  if (typeof body.notes === 'string') m.notes = body.notes.slice(0, 2000);
  if (typeof body.version === 'string' && body.version.trim()) { m.version = body.version.trim(); db.config.appVersion = m.version; }
  let stopped = 0;
  if (want && !was) {
    m.startedAt = Date.now(); m.by = by || 'admin';
    stopped = freezeClients('maintenance', { logOut: false }).stopped;
  }
  if (!want) { m.startedAt = null; m.stoppedBots = 0; }
  else m.stoppedBots = stopped;
  saveDb();
  return { maintenance: m, stopped };
}

/* Google-verified admin recovery. Separated from the route so it is testable;
   the network verifier is swappable so tests never touch Google. */
let googleVerifier = verifyGoogleIdentity;
function setGoogleVerifier(fn) { googleVerifier = typeof fn === 'function' ? fn : verifyGoogleIdentity; }
async function recoverViaGoogle(body) {
  const rc = db.config.recovery, admin = db.users.find(u => u.role === 'admin' && u.active);
  if (!admin) throw Object.assign(new Error('no-admin'), { httpStatus: 404, code: 'no-admin' });
  const info = await googleVerifier(body);
  const email = String(info.email || '').toLowerCase();
  const allowed = [rc.googleEmail, admin.google && admin.google.email].filter(Boolean).map(x => String(x).toLowerCase());
  if (!allowed.length) throw Object.assign(new Error('recovery-google-unset'), { httpStatus: 400, code: 'recovery-google-unset' });
  if (!allowed.includes(email)) throw Object.assign(new Error('google-not-authorized'), { httpStatus: 403, code: 'google-not-authorized' });
  return { ok: true, ticket: issueResetTicket('google'), email: admin.email };
}

async function resetAdminPassword(ticket, password) {
  const t = resetTickets.get(String(ticket || ''));
  if (!t || Date.now() > t.expiresAt) throw Object.assign(new Error('ticket-invalid'), { httpStatus: 400, code: 'ticket-invalid' });
  const pw = String(password || '');
  if (pw.length < 8) throw Object.assign(new Error('password-too-short'), { httpStatus: 400, code: 'password-too-short' });
  const admin = db.users.find(u => u.id === t.userId && u.role === 'admin' && u.active);
  if (!admin) throw Object.assign(new Error('no-admin'), { httpStatus: 404, code: 'no-admin' });
  admin.pass = hashPassword(pw);
  Object.keys(db.sessions).forEach(k => { if (db.sessions[k].userId === admin.id) delete db.sessions[k]; });
  resetTickets.delete(String(ticket)); db.config.recovery.pending = null; markDirty();
  return { ok: true, email: admin.email };
}

function maskEmail(e) {
  const s = String(e || ''), at = s.indexOf('@');
  if (at < 1) return '•••';
  return s.slice(0, Math.min(2, at)) + '•••' + s.slice(at);
}
function maskPhone(p) {
  const s = String(p || '').replace(/\s+/g, '');
  return s.length < 4 ? '•••' : s.slice(0, 3) + '•••' + s.slice(-2);
}
function licenseCheck(req, providedKey) {
  if (!db.config.licenseRequired) return { ok: true, lic: null, off: true };
  const key = providedKey || parseCookies(req).lic || '';
  if (!key) return { ok: false, error: 'license-required' };
  const lic = findLicense(key);
  if (!lic) return { ok: false, error: 'license-invalid' };
  if (lic.status === 'revoked') return { ok: false, error: 'license-revoked' };
  if (lic.expiresAt && Date.now() > lic.expiresAt) {
    lic.status = 'expired'; markDirty();
    return { ok: false, error: 'license-expired', plan: lic.plan || 'days30', expiredAt: lic.expiresAt };
  }
  return { ok: true, lic };
}
function bindLicense(lic, user) {
  if (!lic) return true;
  if (lic.boundUserId && lic.boundUserId !== user.id) return false;
  if (!lic.boundUserId) {
    lic.boundUserId = user.id; lic.boundEmail = user.email; lic.redeemedAt = Date.now();
    if (!lic.expiresAt) lic.expiresAt = planExpiry(lic.plan || 'days30', lic.redeemedAt);
  }
  if (lic.status === 'unused' || lic.status === 'expired') lic.status = 'active';
  user.paid = true; user.licenseKey = lic.key; user.licensePlan = lic.plan || 'days30'; user.licenseExpiresAt = lic.expiresAt || null;
  markDirty();
  return true;
}
function licenseBindingError(res) {
  return sendJson(res, 409, { error: 'license-bound', message: 'This license key is already linked to another account.' });
}
function recordLogin(user, provider, req) {
  const ip = (req && (req.headers['x-forwarded-for'] || req.socket.remoteAddress)) || 'unknown';
  db.config.logins.unshift({
    at: Date.now(), email: user.email, userId: user.id, role: user.role, provider: provider || user.provider || 'email',
    ip: String(ip).split(',')[0].trim(), ua: String((req && req.headers['user-agent']) || '').slice(0, 160)
  });
  if (db.config.logins.length > 300) db.config.logins.length = 300;
  markDirty();
}
async function sendMail(msg) {
  const entry = { id: crypto.randomBytes(6).toString('hex'), at: Date.now(), to: msg.to, subject: msg.subject, text: String(msg.text || '').slice(0, 4000), delivered: false, error: '' };
  const m = db.config.mail;
  if (m.webhookUrl) {
    try {
      const r = await fetch(m.webhookUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(m.token ? { Authorization: 'Bearer ' + m.token } : {}) },
        body: JSON.stringify({ from: m.from, to: msg.to, subject: msg.subject, text: msg.text })
      });
      entry.delivered = r.ok;
      if (!r.ok) entry.error = 'http-' + r.status;
      m.lastSentAt = Date.now(); m.lastError = entry.delivered ? '' : entry.error;
    } catch (e) { entry.error = e.message; m.lastError = e.message; }
  } else entry.error = 'no-mail-provider-configured';
  db.config.mailOutbox.unshift(entry);
  if (db.config.mailOutbox.length > 200) db.config.mailOutbox.length = 200;
  markDirty();
  return entry;
}
function broadcastMail(subject, text, audience) {
  const targets = db.users.filter(u => audience === 'all' ? true : u.role !== 'admin');
  targets.forEach(u => { sendMail({ to: u.email, subject, text }).catch(e => console.error('[mail]', e.message)); });
  return targets.length;
}
function buildCalendar() {
  const now = new Date(), events = [];
  const firstWeekday = (y, m, wd, weeks) => {
    const d = new Date(Date.UTC(y, m, 1));
    d.setUTCDate(1 + ((wd - d.getUTCDay() + 7) % 7) + 7 * weeks);
    return d;
  };
  for (let i = 0; i < 3; i++) {
    const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
    const y = base.getUTCFullYear(), m = base.getUTCMonth();
    const nfp = firstWeekday(y, m, 5, 0); nfp.setUTCHours(13, 30, 0, 0);
    events.push({ date: nfp.getTime(), time: '13:30 UTC', title: 'US Non-Farm Payrolls (NFP)', impact: 'high', country: 'US', note: 'First Friday of the month. High volatility on USD pairs and gold.' });
    const cpi = firstWeekday(y, m, 2, 1); cpi.setUTCHours(13, 30, 0, 0);
    events.push({ date: cpi.getTime(), time: '13:30 UTC', title: 'US CPI — Inflation', impact: 'high', country: 'US', note: 'Consumer Price Index. Large moves on USD and indices.' });
    const retail = new Date(Date.UTC(y, m, 16)); retail.setUTCHours(13, 30, 0, 0);
    events.push({ date: retail.getTime(), time: '13:30 UTC', title: 'US Retail Sales', impact: 'medium', country: 'US', note: 'Consumer spending. Moves USD and risk sentiment.' });
  }
  ['2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16', '2026-11-04', '2026-12-16'].forEach(s => {
    const t = Date.parse(s + 'T19:00:00Z');
    if (!isNaN(t)) events.push({ date: t, time: '19:00 UTC', title: 'FOMC — Fed Rate Decision', impact: 'high', country: 'US', note: 'Fed decision + press conference. The biggest scheduled market mover.' });
  });
  (db.config.calendar || []).forEach(e => {
    const t = e && e.at ? Date.parse(e.at) : NaN;
    if (!isNaN(t)) events.push({ date: t, time: e.time || '', title: e.title || 'Event', impact: e.impact || 'medium', country: e.country || '', note: e.note || '', custom: true });
  });
  return events.filter(e => e.date >= now.getTime() - 6 * 60 * 60 * 1000).sort((a, b) => a.date - b.date).slice(0, 40);
}
function marketAdvisor() {
  const rows = Object.keys(DERIV_SYMBOLS).map(key => {
    const h = hist[key] || [], n = Math.min(h.length, 60), price = peekPrice(key);
    let changePct = 0, vol = 0;
    if (n >= 6) {
      const s = h.slice(-n), first = s[0], last = s[s.length - 1];
      changePct = first ? ((last - first) / first) * 100 : 0;
      const rets = [];
      for (let i = 1; i < s.length; i++) rets.push((s[i] - s[i - 1]) / (s[i - 1] || 1));
      const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
      vol = Math.sqrt(rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (rets.length || 1)) * 100;
    }
    return { symbol: key, price, changePct, volatility: vol, score: n >= 6 ? Math.round(Math.abs(changePct) * 22 + vol * 14) : 0, samples: n };
  });
  rows.sort((a, b) => b.score - a.score);
  return rows.map((r, i) => ({ ...r, rank: i + 1, verdict: r.samples < 6 ? 'warming-up' : (i === 0 ? 'best-today' : (r.score >= 8 ? 'active' : 'quiet')) }));
}

function sendJson(res, code, obj) {
  if (res.writableEnded) return;
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function redirect(res, location) { res.writeHead(302, { Location: location }); res.end(); }
function readBody(req, limit) {
  limit = limit || 1024 * 256;
  return new Promise((resolve, reject) => {
    let size = 0, settled = false;
    const chunks = [];
    req.on('data', c => {
      if (settled) return;
      size += c.length;
      if (size > limit) { settled = true; reject(new Error('payload-too-large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return;
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(new Error('bad-json')); }
    });
    req.on('error', e => { if (!settled) reject(e); });
  });
}
function publicUser(u) {
  return {
    id: u.id, email: u.email, role: u.role, active: u.active, provider: u.provider, createdAt: u.createdAt,
    paid: u.role === 'admin' || u.paid === true || !db.config.licenseRequired,
    licenseKey: u.licenseKey || null, licensePlan: u.licensePlan || null, licenseExpiresAt: u.licenseExpiresAt || null,
    deriv: derivAccountPublic(u), cashier: cashierUrls(u.deriv && u.deriv.loginid),
    google: u.google ? { email: u.google.email, linkedAt: u.google.linkedAt } : null, hasPassword: !!u.pass,
    manualSeen: u.manualSeen === true, manualText: db.config.manualText || null,
    realArmed: canTradeReal(u)
  };
}
function publicBot(b) {
  /* The client must see the limit that applies RIGHT NOW, not only the one set
     at start, so the dashboard can show the truth as the account compounds. */
  try {
    const cap = liveCap(b), daily = liveDailyLimit(b);
    return Object.assign({}, b, {
      liveCap: Number.isFinite(cap) ? +cap.toFixed(2) : 0,
      liveDailyLimit: daily == null ? 0 : +daily.toFixed(2)
    });
  } catch (e) { return b; }
}
const attempts = new Map();
function tooManyAttempts(ip) {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > 60000) { attempts.delete(ip); return false; }
  return rec.count >= 12;
}
function noteAttempt(ip) {
  const rec = attempts.get(ip) || { count: 0, first: Date.now() };
  if (Date.now() - rec.first > 60000) { rec.count = 0; rec.first = Date.now(); }
  rec.count++; attempts.set(ip, rec);
}

/* --------------------------------------------------------------- market */
const DERIV_SYMBOLS = {
  XAUUSD: 'frxXAUUSD', XAGUSD: 'frxXAGUSD', EURUSD: 'frxEURUSD', GBPUSD: 'frxGBPUSD',
  USDJPY: 'frxUSDJPY', USDCAD: 'frxUSDCAD', AUDUSD: 'frxAUDUSD', NZDUSD: 'frxNZDUSD', EURGBP: 'frxEURGBP',
  VOL10: 'R_10', VOL25: 'R_25', VOL50: 'R_50', VOL75: 'R_75', VOL100: 'R_100', CRASH500: 'CRASH500', BOOM1000: 'BOOM1000'
};
const SIM = {
  XAUUSD: { price: 2385.5 }, XAGUSD: { price: 28.44 }, EURUSD: { price: 1.0872 }, GBPUSD: { price: 1.2714 },
  USDJPY: { price: 151.32 }, USDCAD: { price: 1.3585 }, AUDUSD: { price: 0.6598 }, NZDUSD: { price: 0.6012 }, EURGBP: { price: 0.855 },
  VOL10: { price: 6450.12 }, VOL25: { price: 2680.45 }, VOL50: { price: 240.1 }, VOL75: { price: 105320 }, VOL100: { price: 1580.75 },
  CRASH500: { price: 8120.4 }, BOOM1000: { price: 9540.88 }
};
const SIM_TICK_PCT = 0.00025;
/* Springboks hot path: track the newest tick per symbol so the engine reacts on
   every fresh price instead of on a fixed 100 ms sweep. */
const lastEvalAt = Object.create(null);
const EVAL_MIN_GAP_MS = 25;
Object.keys(SIM).forEach(k => { SIM[k].vol = SIM[k].price * SIM_TICK_PCT; });
const SYM_BY_DERIV = {};
Object.keys(DERIV_SYMBOLS).forEach(k => { SYM_BY_DERIV[DERIV_SYMBOLS[k]] = k; });
const market = {}, simPrice = {}, simDrift = {};
let derivWs = null, derivRetries = 0, derivLive = false;
let derivStatus = 'connecting', derivLastError = '', derivLastTickAt = null;
let derivReconnectTimer = null;
let shuttingDown = false;

function initMarket() { Object.keys(SIM).forEach(k => { simPrice[k] = SIM[k].price; market[k] = { price: SIM[k].price, epoch: Math.floor(Date.now() / 1000), at: 0, source: 'sim' }; }); }
function connectDeriv() {
  if (shuttingDown) return;
  if (derivWs) { try { derivWs.close(); } catch (e) {} }
  const dispatcher = proxyDispatcher();
  let ws;
  try {
    ws = dispatcher && undiciMod && undiciMod.WebSocket ? new undiciMod.WebSocket(derivUrl(), { dispatcher }) : derivSocket(derivUrl());
  } catch (e) { derivLastError = e.message; derivStatus = 'offline'; scheduleDeriv(); return; }
  derivStatus = 'connecting'; derivWs = ws;
  ws.onopen = () => {
    derivRetries = 0; derivStatus = 'connecting'; derivLastError = '';
    console.log('[deriv] public market socket connected' + (dispatcher ? ' (via proxy)' : ''));
    // The current Options API has a smaller/different product menu than the
    // retired legacy API. Discover it instead of producing one error per
    // unsupported symbol.
    try { ws.send(JSON.stringify({ active_symbols: 'brief', req_id: 1 })); } catch (e) {}
  };
  ws.onmessage = ev => {
    let msg;
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch (e) { return; }
    if (msg.error) { derivLastError = msg.error.message || msg.error.code || 'error'; return; }
    if (Array.isArray(msg.errors) && msg.errors.length) { derivLastError = msg.errors[0].message || msg.errors[0].code || 'error'; return; }
    if (msg.msg_type === 'active_symbols' && Array.isArray(msg.active_symbols)) {
      const offered = new Set(msg.active_symbols.map(x => x.symbol || x.underlying_symbol).filter(Boolean));
      let subscriptions = 0;
      Object.entries(DERIV_SYMBOLS).forEach(([key, derivSymbol]) => {
        if (!offered.has(derivSymbol)) return;
        subscriptions++;
        try { ws.send(JSON.stringify({ ticks: derivSymbol, subscribe: 1 })); } catch (e) {}
      });
      if (!subscriptions) derivLastError = 'None of the configured instruments are offered by the current Options market feed.';
      console.log('[deriv] subscribed to ' + subscriptions + ' offered instruments');
      return;
    }
    if (msg.msg_type === 'tick' && msg.tick) {
      const key = SYM_BY_DERIV[msg.tick.symbol], q = parseFloat(msg.tick.quote);
      if (!key || !Number.isFinite(q)) return;
      derivLive = true; derivLastTickAt = Date.now(); derivStatus = 'live';
      market[key] = { price: q, epoch: msg.tick.epoch || Math.floor(Date.now() / 1000), at: Date.now(), source: 'live' };
      notePrice(key, q);
      evaluateSymbol(key, q); // react on the tick itself, not only on the safety loop
      pushToSubscribers(key);
    }
  };
  ws.onerror = e => { derivLastError = (e && e.message) || 'socket error'; };
  ws.onclose = () => {
    if (derivWs === ws) derivWs = null;
    derivLive = false; derivStatus = 'offline';
    if (!derivLastError) derivLastError = 'Market socket disconnected; simulator fallback active.';
    scheduleDeriv();
  };
}
function scheduleDeriv() {
  if (shuttingDown) return;
  if (derivReconnectTimer) clearTimeout(derivReconnectTimer);
  const delay = Math.min(30000, 1000 * Math.pow(2, derivRetries++));
  derivReconnectTimer = setTimeout(connectDeriv, delay);
  if (derivReconnectTimer.unref) derivReconnectTimer.unref();
}
function currentPrice(key) {
  const m = market[key];
  if (m && m.source === 'live' && Date.now() - m.at < 8000) return m.price;
  const s = SIM[key] || { price: 1, vol: 0.001 };
  simPrice[key] = simPrice[key] || s.price;
  let d = simDrift[key] || 0;
  d = Math.max(-0.00022, Math.min(0.00022, d * 0.99 + (Math.random() - 0.5) * 0.00018));
  simDrift[key] = d;
  simPrice[key] += (Math.random() - 0.5) * s.vol * 2 + simPrice[key] * d + (s.price - simPrice[key]) * 0.00004;
  if (!(simPrice[key] > 0)) simPrice[key] = s.price;
  market[key] = { price: simPrice[key], epoch: Math.floor(Date.now() / 1000), at: Date.now(), source: 'sim' };
  notePrice(key, market[key].price);
  return market[key].price;
}
function peekPrice(key) {
  const m = market[key];
  if (m && m.price) return m.price;
  const s = SIM[key] || { price: 1 };
  market[key] = { price: s.price, epoch: Math.floor(Date.now() / 1000), at: Date.now(), source: 'sim' };
  return s.price;
}
function resetMarket(key) {
  hist[key] = []; simDrift[key] = 0;
  const s = SIM[key] || { price: 1 };
  simPrice[key] = market[key] && market[key].price ? market[key].price : s.price;
}
function sourceOf(key) { const m = market[key]; return m && m.source === 'live' && Date.now() - m.at < 8000 ? 'live' : 'sim'; }
function latencyOf(key) { const m = market[key]; return m && m.source === 'live' ? Math.max(1, Date.now() - m.epoch * 1000) : null; }
const sseClients = new Map();
function pushToSubscribers(key) {
  const m = market[key];
  if (!m) return;
  const payload = 'data: ' + JSON.stringify({ symbol: key, price: m.price, epoch: m.epoch, source: sourceOf(key), latency: latencyOf(key) }) + '\n\n';
  for (const [res, meta] of sseClients) {
    if (meta.symbol !== key) continue;
    try { res.write(payload); } catch (e) { sseClients.delete(res); }
  }
}

/* --------------------------------------------------------- scalping engine */
/* --------------------------------------------------------------------------
   Contract value — the fair-ticket model.

   The price scales here differ by five orders of magnitude (EURUSD ~1.09 vs
   VOL75 ~105,000), so a fixed "value per point" throws the risk model completely
   off: on gold the smallest ticket risked 34% of a $100 account.

   Instead one lot is pegged to a *fixed notional per unit of price*: 1.00 of
   price movement is worth $100 per lot. A stake of 1.00 therefore behaves the
   same on every market, and the client's risk in dollars is exactly what the
   engine calculated. This is a simulated contract, not Deriv's own sizing — in
   LIVE mode the stake that goes to Deriv is `liveStake`, untouched.
   -------------------------------------------------------------------------- */
const NOTIONAL_PER_PRICE_UNIT = 100;
function pointValue(key) { return NOTIONAL_PER_PRICE_UNIT; }
function contractSize(key, pos) { return Math.max(0.01, pos.lots * pointValue(key)); }
const HIST_MAX = 180;
const hist = {};
function notePrice(key, price) {
  if (!Number.isFinite(price) || price <= 0) return;
  const h = hist[key] || (hist[key] = []);
  if (h.length && h[h.length - 1] === price) return;
  h.push(price); if (h.length > HIST_MAX) h.shift();
}
function ema(arr, period) {
  if (arr.length < period) return null;
  const k = 2 / (period + 1);
  let e = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
  return e;
}
function rsi(arr, period) {
  if (arr.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = arr.length - period; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1]; if (d >= 0) gain += d; else loss -= d;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  const rs = (gain / period) / (loss / period);
  return 100 - 100 / (1 + rs);
}
/* --------------------------------------------------------------------------
   Best pair right now.

   The client picks the market, but the bot should say which one is moving and
   tradeable at this moment. We score every pair with the same signal vote used
   to enter, and prefer the one with the firmest edge that also has enough history
   to trade. The answer changes as the market changes, so it is computed on call
   rather than stored.
   -------------------------------------------------------------------------- */
function bestPair() {
  let best = null;
  for (const key of Object.keys(DERIV_SYMBOLS)) {
    const h = hist[key];
    if (!h || h.length < 30) continue;                 // not enough ticks yet
    const s = signalScore(key);
    if (!s || !s.votes) continue;
    const strength = Math.abs(s.score || 0);
    const atrPct = (SIM[key] ? SIM[key].vol : 0) / Math.max(1e-9, (SIM[key] || {}).price || 1);
    // A touch of volatility preference: enough movement to pay, not so much that a stop is meaningless.
    const volFit = 1 - Math.min(1, Math.abs(atrPct - 0.00025) / 0.0009);
    const rank = strength * (0.6 + 0.4 * volFit);
    if (!best || rank > best.rank) {
      best = { symbol: key, rank, score: s.score || 0, direction: (s.score || 0) > 0 ? 'BUY' : 'SELL', ticks: h.length };
    }
  }
  return best;
}

function signalScore(key) {
  const h = hist[key];
  if (!h || h.length < 30) return { score: 0, entry: 0, votes: null };
  const ref = SIM[key] || { price: 1, vol: 0.001 };
  const rel = Math.abs(ref.vol) / Math.abs(ref.price || 1) || 0.00001;
  const last = h[h.length - 1], w = db.config.engineWeights;
  const votes = { trend: 0, momentum: 0, breakout: 0, reversal: 0 };
  const fast = ema(h, 5), slow = ema(h, 20);
  if (fast != null && slow != null && slow) {
    const spread = (fast - slow) / slow;
    if (spread > rel * 0.35) votes.trend = 1; else if (spread < -rel * 0.35) votes.trend = -1;
  }
  const n = Math.min(8, h.length - 1);
  const roc = (last - h[h.length - 1 - n]) / (Math.abs(ref.price) || 1);
  if (roc > rel * 0.25) votes.momentum = 1; else if (roc < -rel * 0.25) votes.momentum = -1;
  const win = h.slice(-40);
  if (win.length >= 20) {
    const hi = Math.max(...win.slice(0, -1)), lo = Math.min(...win.slice(0, -1)), margin = rel * 0.15;
    if (last > hi + margin) votes.breakout = 1; else if (last < lo - margin) votes.breakout = -1;
  }
  const r = rsi(h, 14);
  if (r != null) { if (r <= 30) votes.reversal = 1; else if (r >= 70) votes.reversal = -1; }
  const entry = votes.trend * w.trend + votes.momentum * w.momentum + votes.breakout * w.breakout;
  return { score: entry + votes.reversal * w.reversal, entry, votes };
}
function learnFrom(votes, won, dir) {
  if (!votes || !dir) return;
  const w = db.config.engineWeights, keys = ['trend', 'momentum', 'breakout', 'reversal'], good = won ? 1 : -1;
  let touched = false;
  keys.forEach(k => {
    if (!votes[k]) return;
    const withDir = votes[k] === dir ? 1 : -1;
    w[k] = Math.min(2.5, Math.max(0.25, w[k] + 0.05 * good * withDir)); touched = true;
  });
  if (!touched) return;
  const scale = 4 / (keys.reduce((a, k) => a + w[k], 0) || 1);
  keys.forEach(k => { w[k] = Math.min(2.5, Math.max(0.25, w[k] * scale)); });
  const s = db.config.engineStats;
  s.lastUpdate = Date.now(); if (won) s.wins++; else s.losses++;
  markDirty();
}
/* --------------------------------------------------------------------------
   Real-money gate.

   There is exactly ONE place that decides whether a real order may be sent.
   A bot may only trade real money when the client has explicitly armed it AND
   the linked Deriv account is a real account. A DEMO account can never place a
   real contract, and a SIMULATED bot never touches money at all — so switching
   between demo and real can never leak a real order.
   -------------------------------------------------------------------------- */
function canTradeReal(user) {
  const b = user && user.bot, d = user && user.deriv;
  if (!b || !b.live) return false;                 // client has not armed real trading
  if (!d || !d.token) return false;                // nothing linked
  if (d.isVirtual) return false;                   // DEMO account — never real money
  return true;
}
function placeLive(user, pos) {
  const acc = user.deriv;
  if (!canTradeReal(user)) {
    /* Refuse loudly rather than silently: a live bot on a demo account is a
       configuration the client should see, not one we paper over. */
    if (user.bot.live) pos.liveSkipped = acc && acc.isVirtual ? 'demo-account' : 'not-armed';
    return;
  }
  pos.livePending = true;
  derivPlaceTrade(acc, { symbol: user.bot.symbol, direction: pos.dir, stake: Math.max(0.35, Number(user.bot.liveStake) || 1), duration: 5, durationUnit: 'm' }).then(buy => {
    pos.livePending = false;
    const id = buy && (buy.contract_id || buy.contractId);
    if (id) pos.contractId = id;
    else pos.liveFailed = true;
    // The simulated TP/SL may have fired while the buy was in flight. Never
    // leave a newly opened real contract unmanaged in that case.
    if (pos.closeRequested && id) derivSellContract(acc, id).catch(e => { derivLastError = 'deriv-sell: ' + e.message; });
  }).catch(e => {
    pos.livePending = false; pos.liveFailed = true; derivLastError = 'deriv-buy: ' + e.message;
    console.error('[deriv] buy failed:', e.message);
  });
}
function closeLive(user, pos) {
  const acc = user.deriv;
  if (!canTradeReal(user)) return;
  if (!pos.contractId) { pos.closeRequested = true; return; }
  derivSellContract(acc, pos.contractId).catch(e => { derivLastError = 'deriv-sell: ' + e.message; console.error('[deriv] sell failed:', e.message); });
}
function evaluate(user) {
  const bot = user.bot;
  if (!bot.running) return;
  const key = bot.symbol, price = peekPrice(key), age = Date.now();
  const s = signalScore(key);
  const ctx = marketContext(key);
  const sel = strategyFor(bot);
  const params = sel.params;

  /* ---- manage open positions with the strategy's own geometry ---------- */
  const tp = Math.abs(bot.tp), sl = Math.abs(bot.sl);
  for (let i = bot.positions.length - 1; i >= 0; i--) {
    const pos = bot.positions[i];
    if (!pos) continue;

    // Positions with no strategy metadata (legacy or manually opened) are
    // still risk-managed: they use the account's own $ take-profit and stop.
    if (!pos.strategy) {
      const cash = (price - pos.entry) * (pos.dir === 'BUY' ? 1 : -1) * contractSize(key, pos);
      if (cash > (pos.peak || 0)) pos.peak = cash;
      if (cash >= tp) { closePos(user, i, price, 'take-profit'); continue; }
      if (cash <= -sl) { closePos(user, i, price, 'stop-loss'); continue; }
      if (bot.trailing && pos.peak >= tp * 0.6 && cash <= pos.peak - sl * 0.6) { closePos(user, i, price, 'trailing'); continue; }
      if (pos.peak >= tp * 0.75 && cash <= 0.15 * tp) { closePos(user, i, price, 'breakeven-lock'); continue; }
      pos.ticks = (pos.ticks || 0) + 1;
      continue;
    }

    // Strategy positions carry ATR-based targets.
    const atr = pos.atr || (ctx && ctx.atr) || 0;
    if (!pos.tpPrice && atr > 0) {
      const lv = ENGINE.levelsFor(pos.dir === 'BUY' ? 1 : -1, pos.entry, atr, { exit: { tp: params.tp, sl: params.sl } });
      pos.tpPrice = lv.tpPrice; pos.slPrice = lv.slPrice; pos.tpDist = lv.tpDist; pos.slDist = lv.slDist; pos.atr = atr;
    }
    const dir1 = pos.dir === 'BUY' ? 1 : -1;
    const profit = (price - pos.entry) * dir1;
    const prog = pos.tpDist ? profit / pos.tpDist : 0;
    /* --- profit lock-in ----------------------------------------------------
       A winner must not be allowed to turn into a loser. Once the trade is up
       `lockAfterR` of its own risk, the stop moves to break-even; once it is up
       `trailAfterR`, the stop follows the best price by `trailByR`. This is the
       part that turns "closed in profit" into a rule instead of luck. */
    const rUnit = pos.slDist || 0;                    // 1R in price terms
    if (bot.lockInProfit !== false && rUnit > 0) {
      const gainR = profit / rUnit;
      if (!pos.beTriggered && gainR >= (bot.lockAfterR || 0.5)) {
        pos.beTriggered = true;
        pos.slPrice = pos.entry + dir1 * Math.max(atr * 0.02, Math.abs(pos.entry) * 0.000002);
        pos.lockedAtR = +(gainR.toFixed(2));
      }
      if (pos.beTriggered && gainR >= (bot.trailAfterR || 1)) {
        const trailPrice = price - dir1 * rUnit * (bot.trailByR || 0.4);
        // only ever tighten, never loosen
        if (dir1 === 1 ? trailPrice > pos.slPrice : trailPrice < pos.slPrice) pos.slPrice = trailPrice;
      }
    } else if (!pos.beTriggered && params.be < 1 && prog >= params.be) {
      pos.beTriggered = true;
      // move the stop to break-even plus a hair of cost
      pos.slPrice = pos.entry + dir1 * Math.max(atr * 0.04, Math.abs(pos.entry) * 0.000004);
    }
    if (pos.tpPrice != null && (dir1 === 1 ? price >= pos.tpPrice : price <= pos.tpPrice)) { closePos(user, i, price, 'take-profit'); continue; }
    if (pos.slPrice != null && (dir1 === 1 ? price <= pos.slPrice : price >= pos.slPrice)) {
      closePos(user, i, price, pos.beTriggered ? 'profit-locked' : 'stop-loss'); continue;
    }
    const holdTicks = pos.holdTicks || params.hold || 0;
    if (holdTicks && (pos.ticks || 0) >= holdTicks) { closePos(user, i, price, 'time-stop'); continue; }
    pos.ticks = (pos.ticks || 0) + 1;
    if (pos.profitPeak == null || profit > pos.profitPeak) pos.profitPeak = profit;
  }

  checkProfitGuard(user);
  if (!bot.running || bot.targetHit) { markDirty(); return; }
  db.config.engineStats.scored++;

  /* ---- entries --------------------------------------------------------- */
  const minGap = Math.max(400, 2600 - bot.aggression * 220);
  if (age - (bot.lastEntryAt || 0) < minGap) { markDirty(); return; }
  if (bot.positions.length >= bot.maxTrades) { markDirty(); return; }
  if (bot.positions.length && !bot.hedge) {
    // never stack opposing exposure
    const last = bot.positions[bot.positions.length - 1];
    if (last && last.ticks != null && last.ticks < 6) { markDirty(); return; }
  }

  // The daily loss limit is checked before a signal is even considered: once the
  // client has lost their chosen amount for the day, no new trade opens.
  /* The daily stop exists to stop a LOSING day, never a winning one. The limit is
     a share of the balance, so if it were allowed to fire while the account is up
     it would become a profit ceiling ($12,500 on a $100,000 account). Trading only
     pauses when the session is DOWN and the day's drawdown has reached the
     client's figure. While net profitable the stop is fully disengaged. */
  if (bot.profit <= 0 && dailyLimitHit(bot)) {
    if (!bot.limitHitNoted) {
      bot.limitHitNoted = true;
      bot.running = false;
      bot.stoppedReason = 'daily-loss-limit';
      console.log('[risk] daily loss limit reached for a bot — trading paused');
    }
    markDirty(); return;
  }
  bot.limitHitNoted = false;

  const sig = chooseSignal(ctx, bot);
  if (!sig) { markDirty(); return; }

  const dir = sig.dir;
  const lastPos = bot.positions[bot.positions.length - 1];
  if (lastPos && lastPos.dir === (dir === 1 ? 'SELL' : 'BUY')) { markDirty(); return; }

  const atr = (ctx && ctx.atr) || Math.abs(price) * 0.0004;
  const lv = ENGINE.levelsFor(dir, price, atr, { exit: { tp: sig.tp, sl: sig.sl } });
  const lots = sizeFor(user, bot, price, atr, lv.slDist);
  if (!(lots > 0)) { markDirty(); return; }   // the budget cannot cover one contract
  const position = {
    id: crypto.randomUUID(), dir: dir === 1 ? 'BUY' : 'SELL', lots,
    entry: price, peak: 0, at: age, score: s.score, votes: s.votes,
    strategy: sig.strategy, confidence: Number(sig.confidence.toFixed(3)),
    atr, tpPrice: lv.tpPrice, slPrice: lv.slPrice, tpDist: lv.tpDist, slDist: lv.slDist,
    holdTicks: sig.hold, ticks: 0, beTriggered: false, profitPeak: 0
  };
  bot.positions.push(position);
  bot.lastEntryAt = age;
  if (bot.live) placeLive(user, position);
  markDirty();
}
function closePos(user, index, price, cause) {
  const bot = user.bot, pos = bot.positions[index];
  if (!pos) return null;
  bot.positions.splice(index, 1);
  let pnl = (price - pos.entry) * (pos.dir === 'BUY' ? 1 : -1) * contractSize(bot.symbol, pos);

  /* The loss cap is a promise, not an estimate. A gap through the stop can make
   * the fill worse than the size calculation assumed, which is how a "$1 cap"
   * becomes a $1.45 loss. The client's ceiling is enforced on the RESULT: any
   * overshoot beyond it is absorbed as slippage, so a single trade can never cost
   * more than the amount chosen. Wins are never touched. */
  if (pnl < 0) {
    const ceiling = liveCap(bot);
    if (pnl < -ceiling) pnl = -ceiling;
  }
  bot.balance += pnl; bot.profit += pnl;
  bot.trades.unshift({ symbol: bot.symbol, dir: pos.dir, lots: pos.lots, entry: pos.entry, exit: price, pnl, cause, at: Date.now(), score: pos.score, strategy: pos.strategy || null, confidence: pos.confidence || null });
  if (bot.trades.length > 200) bot.trades.pop();
  // Cumulative tallies outlive the 200-row display log, so the win rate in the
  // UI is the session's real win rate and not the last 200 trades.
  bot.closedTrades = (bot.closedTrades || 0) + 1;
  if (pnl > 0) bot.closedWins = (bot.closedWins || 0) + 1; else bot.closedLosses = (bot.closedLosses || 0) + 1;
  noteDayLoss(bot, pnl);
  const byStrat = (db.config.engineStats.byStrategy = db.config.engineStats.byStrategy || {});
  if (pos.strategy) {
    const rec = byStrat[pos.strategy] || (byStrat[pos.strategy] = { wins: 0, losses: 0, pnl: 0 });
    if (pnl > 0) rec.wins++; else rec.losses++;
    rec.pnl += pnl;
  }
  learnFrom(pos.votes, pnl > 0, pos.dir === 'BUY' ? 1 : -1);
  if (bot.live) closeLive(user, pos);
  checkProfitGuard(user); markDirty();
  return pnl;
}
function flattenBot(user, cause) {
  const b = user && user.bot;
  if (!b) return;
  b.running = false;
  const price = peekPrice(b.symbol);
  let guard = 0;
  while (b.positions.length && guard++ < 500) closePos(user, b.positions.length - 1, price, cause || 'stopped');
  b.stoppedAt = Date.now();
  markDirty();
}
function checkProfitGuard(user) {
  const b = user.bot;
  if (!b) return;
  if (b.profit > (b.peakProfit || 0)) b.peakProfit = b.profit;
  noteMilestones(b, b.profit);
  if (b.profitTarget > 0 && b.profit >= b.profitTarget && !b.targetHit) {
    b.targetHit = { at: Date.now(), target: b.profitTarget, profit: b.profit };
    b.running = false; b.stoppedAt = Date.now();
    b.stoppedReason = 'profit-target';
    console.log('[target] reached for ' + user.email + ': $' + b.profit.toFixed(2));
  }
  /* There is deliberately NO ceiling on profit: a good day is allowed to run to
     any amount. The only optional brake is `protectProfitFrom` — once the session
     has banked at least that much, the bot stops if it gives back ALL of it (back
     to break-even). It never trims a run, only stops a banked profit becoming a
     loss. Default 0 = off, so profits are uncapped. */
  if (b.running && b.protectProfitFrom > 0 && b.profitTarget <= 0
      && b.peakProfit >= b.protectProfitFrom && b.profit <= 0) {
    b.running = false; b.stoppedAt = Date.now(); b.stoppedReason = 'profit-protected';
    console.log('[target] banked peak protected, stopped at break-even for ' + user.email);
  }
}

/* ------------------------------------------------------- strategy helpers */

/** Resolve the strategy a bot should trade, with its validated parameters. */
function strategyFor(bot) {
  const cfg = db.config.engine || {};
  const wanted = bot && bot.strategy && bot.strategy !== 'auto' ? bot.strategy : cfg.defaultStrategy;
  const id = ENGINE.STRATEGIES[wanted] ? wanted : ENGINE.STRATEGY_IDS[0];
  return { id, params: ENGINE.paramsFor(id, cfg.tuned && cfg.tuned[id]) };
}

/** The full catalogue with validated numbers, best win rate first. */
/* --------------------------------------------------------------------------
   Strategy grades.

   A client should never have to read a table to know which strategy to trust.
   The grade is derived from the validated, out-of-sample numbers only:
   win rate first, then expectancy and profit factor as the tie-breakers, so a
   high hit-rate that still loses money can never be graded BEST.
   -------------------------------------------------------------------------- */
const GRADES = [
  { key: 'best', label: 'BEST', tone: 'gold' },
  { key: 'excellent', label: 'EXCELLENT', tone: 'green' },
  { key: 'good', label: 'GOOD', tone: 'teal' },
  { key: 'average', label: 'AVERAGE', tone: 'amber' },
  { key: 'weak', label: 'WEAK', tone: 'red' }
];
function gradeStrategy(test, row) {
  if (!test || !test.trades) return GRADES[4].key;
  const win = test.winRate || 0, exp = test.expectancyR == null ? -1 : test.expectancyR;
  const pf = test.profitFactor == null ? 0 : test.profitFactor;
  const pays = exp > 0 && pf > 1;
  if (!pays) return win >= 0.7 ? 'average' : 'weak';
  if (win >= 0.95 && pf >= 4 && test.trades >= 800) return 'best';
  if (win >= 0.9 && pf >= 2) return 'excellent';
  if (win >= 0.85 && pf >= 1.5) return 'good';
  return 'average';
}

function strategyCatalogue() {
  const cfg = db.config.engine || {};
  const report = cfg.report;
  const byId = {};
  if (report && Array.isArray(report.strategies)) for (const row of report.strategies) byId[row.strategy] = row;
  return ENGINE.STRATEGY_IDS.map(id => {
    const def = ENGINE.STRATEGIES[id];
    const row = byId[id];
    const test = row && row.test ? row.test : null;
    return {
      id, name: def.name, tagline: def.tagline,
      regimes: def.regimes, exit: def.exit,
      tuned: !!(cfg.tuned && cfg.tuned[id]),
      // validated, out-of-sample numbers only — never the training numbers
      winRate: test ? test.winRate : null,
      trades: test ? test.trades : null,
      avgWinR: test ? test.avgWinR : null,
      avgLossR: test ? test.avgLossR : null,
      scratches: test ? test.scratches : null,
      expectancyR: test ? test.expectancyR : null,
      profitFactor: test && test.profitFactor != null ? test.profitFactor : null,
      maxDrawdownR: test ? test.maxDrawdownR : null,
      byReason: test ? test.byReason : null,
      crossFamily: row && row.crossFamily ? row.crossFamily : null,
      viable: row ? !!row.viable : null,
      profitable: test ? (test.expectancyR > 0 && (test.profitFactor == null || test.profitFactor > 1)) : null,
      grade: gradeStrategy(test, row)          // BEST / EXCELLENT / GOOD / AVERAGE / WEAK
    };
  }).sort((a, b) => (b.winRate || 0) - (a.winRate || 0));
}

/**
 * Load the validated report and seat the default strategy.
 * The default is the MOST WINS among the strategies that also pay — a 98% win
 * rate with negative expectancy never gets the seat.
 */
function loadStrategyReport() {
  try {
    const candidates = [
      path.join(ROOT, 'data', 'strategy-stats.json'),
      path.join(ROOT, 'engine', 'strategy-report.json')
    ];
    const file = candidates.find(f => fs.existsSync(f));
    if (!file) return false;
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!report || !Array.isArray(report.strategies)) return false;
    db.config.engine = db.config.engine || {};
    db.config.engine.report = report;
    const tuned = {};
    for (const row of report.strategies) if (row.params) tuned[row.strategy] = row.params;
    db.config.engine.tuned = tuned;
    const viable = report.strategies
      .filter(r => r.test && r.test.trades >= 100 && r.test.expectancyR > 0
        && (r.test.profitFactor == null || r.test.profitFactor > 1))
      .sort((a, b) => b.test.winRate - a.test.winRate);
    const chosen = viable.length ? viable[0].strategy : (report.best || db.config.engine.defaultStrategy);
    if (ENGINE.STRATEGIES[chosen]) db.config.engine.defaultStrategy = chosen;
    console.log('[engine] ' + report.strategies.length + ' strategies validated; default = ' + db.config.engine.defaultStrategy);
    return true;
  } catch (e) { console.error('[engine:report]', e.message); return false; }
}

/** Shared market context for a symbol, or null while the feed warms up. */
function marketContext(key) {
  const series = hist[key];
  if (!Array.isArray(series) || series.length < ENGINE.WARMUP + 2) return null;
  return ENGINE.buildContext(series, series.length - 1, { weights: db.config.engineWeights });
}

/**
 * Pick this tick's signal.
 *  - a pinned strategy may only fire itself
 *  - 'auto' prefers the validated leader, and lets another strategy take the
 *    trade when it produces a more confident signal in a regime that suits it
 */
function chooseSignal(ctx, bot) {
  if (!ctx) return null;
  const sel = strategyFor(bot);
  if (bot.strategy !== 'auto') return ENGINE.signalFor(ctx, sel.id, sel.params);
  const candidates = [];
  const lead = ENGINE.signalFor(ctx, sel.id, sel.params);
  if (lead) candidates.push(lead);
  for (const id of ENGINE.STRATEGY_IDS) {
    if (id === sel.id) continue;
    const cfg = db.config.engine.tuned && db.config.engine.tuned[id];
    const sig = ENGINE.signalFor(ctx, id, cfg);
    if (sig) candidates.push(sig);
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.confidence - a.confidence || (a.strategy === sel.id ? -1 : 1));
  return candidates[0];
}

/**
 * Position size.
 *
 * Two modes, and the client chooses:
 *  - autoRisk ON  -> risk `riskPerTrade` % of balance between entry and stop.
 *                    Bigger risk = bigger position = bigger P/L per trade.
 *  - autoRisk OFF -> the client's own lot size (`lots`) is used verbatim.
 */
function sizeFor(user, bot, price, atr, slDist) {
  if (!bot.autoRisk) return Math.min(100, Math.max(0.01, Number(bot.lots) || 0.01));
  const pct = Math.max(0.1, Math.min(25, Number(bot.riskPerTrade) || 1)) / 100;
  /* A balance must be a finite positive number. A corrupt or non-numeric value
     would otherwise flow into the lot calculation and produce NaN, which poisons
     a position. Fall back to the starting balance, then to 100. */
  const rawBal = Number(bot.balance);
  const bal = Number.isFinite(rawBal) && rawBal > 0 ? rawBal : (Number(bot.startBalance) > 0 ? Number(bot.startBalance) : 100);
  const perPoint = pointValue(bot.symbol);
  const lossPerLot = Math.max(slDist, price * 0.00002) * perPoint;
  if (!(lossPerLot > 0)) return bot.lots;

  // --- what the risk % asks for -------------------------------------------------
  let riskCash = Math.max(0.01, bal * pct) * compoundingStep(bot);

  // --- hard cash cap per trade --------------------------------------------------
  // The client sets a ceiling in money ("never lose more than $2 on one trade"),
  // which is what a person actually thinks in. Whichever is lower wins.
  const capCash = liveCap(bot);
  if (Number.isFinite(capCash)) riskCash = Math.min(riskCash, capCash);

  // --- never let one loss take a big bite out of the account --------------------
  // Even with a wide stop, a single trade may not risk more than MAX_TRADE_RISK_PCT.
  riskCash = Math.min(riskCash, bal * (MAX_TRADE_RISK_PCT / 100));

  // --- don't spend the remaining daily budget on one trade ----------------------
  const left = dailyLossBudget(bot);
  if (left != null) riskCash = Math.min(riskCash, Math.max(0, left));

  /* Lot step adapts to the account size.
   *
   * A fixed 0.01 step means a $2 account cannot open anything at all, and on a
   * small account rounding UP to the step can multiply the intended risk. So the
   * step scales with the account: micro accounts trade in 0.0001 clips, larger
   * ones in 0.001, and the value is always floored — never rounded up into a risk
   * the client did not choose. */
  const step = bal < 25 ? 0.00005 : bal < 500 ? 0.00025 : 0.001;
  const lots = Math.floor((riskCash / lossPerLot) / step) * step;
  if (lots <= 0) {
    /* A micro account still deserves a trade. If the client's own per-trade cap
     * can fund one clip, allow it even when the percentage cannot — the cap IS
     * the risk limit they set, so honouring it is correct. */
    const cap = liveCap(bot);
    if (Number.isFinite(cap)) {
      /* The floor clip is still bounded by the risk percentage — the cap only
         says "never more than this", it must never authorise more than the
         client's chosen risk. */
      const allowed = Math.min(cap, bal * pct, bal * (MAX_TRADE_RISK_PCT / 100));
      const byCap = Math.floor((allowed / lossPerLot) / 0.00005) * 0.00005;
      if (byCap > 0) return Number(Math.min(50, byCap).toFixed(5));
    }
    return 0;
  }
  return Number(Math.min(50, lots).toFixed(5));
}

/* --------------------------------------------------------------------------
   Compounding profit lock.

   On a tiny balance the goal is not to bank $20 and stop — it is to grow $2 into
   $30 and keep going. So the guard has two parts:
     - lock a share of every winner (the stop moves to break-even, then trails), so
       winnings are never handed back;
     - step the stake up as the balance grows and down as it shrinks, so the
       account compounds instead of betting a fixed clip forever.
   -------------------------------------------------------------------------- */
function compoundingStep(bot) {
  if (bot.compound === false) return 1;
  const start = Number(bot.startBalance) || 100;
  const bal = Number(bot.balance) || start;
  // stake scales with equity, capped at 3x so a lucky run cannot 8x the risk
  return Math.max(0.25, Math.min(3, bal / start));
}

/* --------------------------------------------------------------------------
   Daily loss limit.

   The killer is not one bad trade, it is a bad *run* inside one session. Once
   the bot has lost the client's chosen amount for the day it stops opening new
   trades, closes nothing forcibly, and reports why. This is the guard that
   stops an account being walked down before it ever gets to the profitable part.
   -------------------------------------------------------------------------- */
const DAILY_LOSS_KEY = () => new Date().toISOString().slice(0, 10);   // YYYY-MM-DD (UTC)
function rollDay(bot) {
  const day = DAILY_LOSS_KEY();
  if (bot.lossDay !== day) { bot.lossDay = day; bot.dayLoss = 0; bot.limitHitNoted = false; }
}
/* --------------------------------------------------------------------------
   Live money limits.

   Every limit starts as a share of the balance the client declared, then is
   re-derived from the balance in hand on every call. That is what lets a $2
   account grow into $10, $50, $200 and risk accordingly — without a restart,
   and without a frozen dollar figure holding the account back.
   -------------------------------------------------------------------------- */
/* Upper bound for a client-supplied figure: a fifth of the account, so a typo can
   never set a loss limit larger than the balance itself. */
function capCeiling(bot) {
  const bal = Number(bot.balance) > 0 ? Number(bot.balance) : 100;
  return Math.max(0.5, bal * 0.2);
}
function liveCap(bot) {
  const start = Number(bot.startBalance) > 0 ? Number(bot.startBalance) : (Number(bot.balance) > 0 ? Number(bot.balance) : 100);
  const bal = Number(bot.balance) > 0 ? Number(bot.balance) : start;
  const raw = Number(bot.maxLossPerTrade);
  /* 0 is a legitimate choice meaning "no cash ceiling" — the hard 1.5% account
     limit still applies. A MISSING or CORRUPT value (NaN, negative, undefined)
     is different: it must never silently mean "no ceiling at all", because that
     is how one trade becomes an account-ending loss. Those fall back to 1%. */
  if (Number.isFinite(raw) && raw === 0) {
    return Math.max(0.01, bal * (MAX_TRADE_RISK_PCT / 100));
  }
  const cap = Number.isFinite(raw) && raw > 0 ? raw : start * 0.01;
  /* The client's ceiling is re-expressed against the balance in hand, so it
     grows with the account. It is then held inside the hard 1.5% limit. */
  const scaled = cap * (bal / start);
  return Math.max(0.01, Math.min(scaled, bal * (MAX_TRADE_RISK_PCT / 100)));
}
function liveDailyLimit(bot) {
  const limit = Number(bot.dailyLossLimit);
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const start = Number(bot.startBalance) > 0 ? Number(bot.startBalance) : (Number(bot.balance) > 0 ? Number(bot.balance) : 100);
  const bal = Number(bot.balance) > 0 ? Number(bot.balance) : start;
  /* Same idea for the daily figure: it follows the balance, and is only ever
     used to stop a LOSING day (a winning session is never limit-hit). */
  const scaled = limit * (bal / start);
  return Math.max(0.05, Math.min(scaled, bal * 3));
}


function dailyLossBudget(bot) {
  const limit = liveDailyLimit(bot);
  if (limit == null) return null;                                     // no limit set
  if (bot.lossDay !== DAILY_LOSS_KEY()) return limit;                 // fresh day, full budget
  return Math.max(0, limit - Math.abs(Math.min(0, bot.dayLoss || 0)));
}
function noteDayLoss(bot, pnl, at) {
  const day = DAILY_LOSS_KEY();
  if (bot.lossDay !== day) { bot.lossDay = day; bot.dayLoss = 0; }
  if (pnl < 0) bot.dayLoss = (bot.dayLoss || 0) + pnl;
  bot.lastLossAt = pnl < 0 ? (at || Date.now()) : bot.lastLossAt;

  /* While the session is net profitable the daily stop must not fire: the client
     is up, not down. The guard exists to stop a losing day, not to interrupt a
     winning one. So whenever profit covers the day's drawdown we reset the clock. */
  if (bot.profit > 0 && Math.abs(bot.dayLoss || 0) <= bot.profit) {
    bot.dayLoss = 0;
    if (bot.limitHitNoted) { bot.limitHitNoted = false; }
  }
}
function dailyLimitHit(bot) {
  /* A winning session can never be limit-hit, whatever the day's drawdown was. */
  if (Number(bot.profit) > 0) return false;
  const left = dailyLossBudget(bot);
  return left != null && left <= 0;
}

/**
 * RESYNC — the refresh control.
 *
 * A scalper that has streamed for hours drifts: stale ticks inflate ATR, a
 * position outlives the edge that opened it, the balance counter wanders away
 * from reality, and the entry cooldown can strand the bot. Resync cleans all
 * four up and records an auditable event.
 */
function resyncBot(user, opts) {
  const o = opts || {};
  const bot = user && user.bot;
  if (!bot) return null;
  const t0 = Date.now();
  const key = bot.symbol;
  const price = peekPrice(key);
  const report = { at: t0, mode: o.mode === 'hard' ? 'hard' : 'soft', symbol: key, closed: [], ticksDropped: 0, balanceBefore: bot.balance, balanceAfter: bot.balance, repaired: [] };

  // 1. retire positions that outlived their time stop
  const sel = strategyFor(bot);
  const maxHold = Math.max((sel.params && sel.params.hold) || 420, 60);
  for (let i = bot.positions.length - 1; i >= 0; i--) {
    const pos = bot.positions[i];
    if (!pos) continue;
    const ticks = pos.ticks || 0;
    const ageMs = t0 - (pos.at || t0);
    if (!(ticks >= maxHold || ageMs > 30 * 60 * 1000)) continue;
    const pnl = closePos(user, i, price, 'resync');
    report.closed.push({ dir: pos.dir, ticks, ageMs, pnl });
  }

  // 2. drop stale / frozen ticks so ATR cannot stay skewed
  const series = Array.isArray(hist[key]) ? hist[key] : [];
  const fresh = [];
  let last = null, dropped = 0;
  for (const v of series) {
    if (!Number.isFinite(v) || v <= 0) { dropped++; continue; }
    if (last != null && v === last) { dropped++; continue; }
    fresh.push(v); last = v;
  }
  const keep = o.mode === 'hard' ? 140 : 400;
  if (fresh.length > keep) { dropped += fresh.length - keep; fresh.splice(0, fresh.length - keep); }
  hist[key] = fresh;
  report.ticksDropped = dropped;

  // 3. re-anchor the books
  const start = Number.isFinite(bot.startBalance) ? bot.startBalance : 100;
  const expected = start + (Number(bot.profit) || 0);
  if (Math.abs((bot.balance || 0) - expected) > 0.005) {
    report.repaired.push({ field: 'balance', drift: Number(((bot.balance || 0) - expected).toFixed(4)) });
    bot.balance = expected;
  }
  if (!bot.positions.length && bot.targetHit && expected < Math.abs(bot.profitTarget || 0)) {
    bot.targetHit = null; bot.running = true;
    report.repaired.push({ field: 'targetHit', note: 'cleared stale target latch' });
  }

  // 4. clear the cooldown so a fresh edge is not blocked
  if (o.mode === 'hard') { bot.lastEntryAt = 0; report.repaired.push({ field: 'cooldown' }); }

  bot.resyncs = (bot.resyncs || 0) + 1;
  bot.lastResyncAt = t0;
  report.balanceAfter = bot.balance;
  report.ms = Date.now() - t0;
  report.advice = report.closed.length
    ? 'Retired ' + report.closed.length + ' expired position(s); the bot is flat and ready.'
    : (fresh.length < 60 ? 'Feed rebuilt — the engine needs about 60 ticks to re-warm before it enters.' : 'Engine resynced; no exposure needed closing.');
  db.config.engineStats.resyncs = (db.config.engineStats.resyncs || 0) + 1;
  db.config.engineStats.lastResyncAt = t0;
  if (!Array.isArray(user.events)) user.events = [];
  user.events.unshift({ at: t0, kind: 'resync', message: report.advice });
  if (user.events.length > 80) user.events.length = 80;
  markDirty();
  return report;
}

/* --------------------------------------------------------------- backups */
function snapshot() { return { app: 'R.H PILOT', taken: Date.now(), version: db.config.appVersion, data: db }; }
function hubMeta() { const h = db.config.hub; return { url: h.url, autoBackup: h.autoBackup, hasToken: !!h.token, lastBackupAt: h.lastBackupAt, lastPushAt: h.lastPushAt, lastPushError: h.lastPushError }; }
function writeBackup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const id = 'backup-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json', file = path.join(BACKUP_DIR, id);
  fs.writeFileSync(file, JSON.stringify(snapshot()));
  db.config.hub.lastBackupAt = Date.now(); markDirty();
  return { id, bytes: fs.statSync(file).size, at: db.config.hub.lastBackupAt };
}
function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json')).map(f => {
      const st = fs.statSync(path.join(BACKUP_DIR, f)); return { id: f, bytes: st.size, at: st.mtimeMs };
    }).sort((a, b) => b.at - a.at).slice(0, 40);
  } catch (e) { return []; }
}
async function pushToHub() {
  const h = db.config.hub;
  if (!h.url) throw new Error('no-hub-url');
  const headers = { 'Content-Type': 'application/json', ...(h.token ? { Authorization: 'Bearer ' + h.token } : {}) };
  const r = await fetch(h.url, { method: 'POST', headers, body: JSON.stringify(snapshot()) });
  if (!r.ok) throw new Error('hub-http-' + r.status);
  h.lastPushAt = Date.now(); h.lastPushError = ''; saveDb(); return hubMeta();
}

/* ------------------------------------------------------------------ API */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8' };
async function api(req, res, url, body) {
  const p = url.pathname, method = req.method;
  if (p === '/api/health' && method === 'GET') {
    return sendJson(res, 200, {
      ok: true, version: db.config.appVersion, uptime: Math.floor(process.uptime()),
      maintenance: !!db.config.maintenance.enabled, licenseRequired: !!db.config.licenseRequired,
      memory: memoryReport(),
      deriv: { status: derivStatus, live: derivLive, lastTickAt: derivLastTickAt, lastError: derivLastError },
      engine: { symbols: Object.keys(DERIV_SYMBOLS).length, runningBots: db.users.filter(u => u.bot.running).length, defaultStrategy: db.config.engine.defaultStrategy }
    });
  }
  if (p === '/api/auth/me' && method === 'GET') {
    const u = getSessionUser(req); if (!u) return sendJson(res, 401, { error: 'not-authenticated' });
    return sendJson(res, 200, { user: publicUser(u), bot: publicBot(u.bot) });
  }
  if (p === '/api/auth/login' && method === 'POST') {
    const ip = req.socket.remoteAddress || 'x';
    if (tooManyAttempts(ip)) return sendJson(res, 429, { error: 'too-many-attempts' });
    const email = resolveLoginEmail(body.email), user = db.users.find(u => u.email === email);
    // Tell the difference between "wrong password" and "no such account" so the
    // login screen can say something useful instead of a generic failure.
    if (!user) { noteAttempt(ip); return sendJson(res, 401, { error: 'no-such-account', message: 'No account uses that email. Check the address, or use the exact admin address.' }); }
    if (!user.active) return sendJson(res, 403, { error: 'account-disabled', message: 'This account is disabled. Contact the admin.' });
    if (!verifyPassword(body.password, user.pass)) { noteAttempt(ip); return sendJson(res, 401, { error: 'invalid-credentials', message: 'Email recognised — that password is not right.' }); }
    if (user.role !== 'admin') {
      const lc = licenseCheck(req);
      if (!lc.ok) return sendJson(res, 403, { error: lc.error, message: 'Enter your license key to sign in.' });
      if (!bindLicense(lc.lic, user)) return licenseBindingError(res);
    }
    setSessionCookie(res, createSession(user.id), req); recordLogin(user, 'email', req);
    return sendJson(res, 200, { user: publicUser(user), bot: publicBot(user.bot) });
  }
  if (p === '/api/auth/register' && method === 'POST') {
    const email = String(body.email || '').toLowerCase().trim(), pw = String(body.password || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJson(res, 400, { error: 'bad-email' });
    if (pw.length < 8) return sendJson(res, 400, { error: 'weak-password', message: 'Password must be at least 8 characters.' });
    if (db.users.some(u => u.email === email)) return sendJson(res, 409, { error: 'email-taken' });
    const lc = licenseCheck(req);
    if (!lc.ok) return sendJson(res, 403, { error: lc.error, message: 'A valid license key is required to create an account.' });
    const user = makeUser(email, pw, 'user');
    if (!bindLicense(lc.lic, user)) return licenseBindingError(res);
    db.users.push(user); setSessionCookie(res, createSession(user.id), req); recordLogin(user, 'email', req); saveDb();
    return sendJson(res, 201, { user: publicUser(user), bot: publicBot(user.bot) });
  }
  if (p === '/api/auth/logout' && method === 'POST') {
    const token = parseCookies(req).sid;
    if (token) { delete db.sessions[token]; markDirty(); }
    clearSessionCookie(res); return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/config/public' && method === 'GET') {
    const m = db.config.maintenance, su = getSessionUser(req);
    const visible = su && su.role === 'admin' ? { ...m, enabled: false, adminBypass: true } : m;
    return sendJson(res, 200, {
      googleClientId: db.config.googleClientId || '', googleEnabled: !!db.config.googleClientId,
      derivAppId: db.config.derivAppId || '', derivOAuthMode: db.config.derivOAuthMode || 'new', derivOAuthEnabled: !!db.config.derivAppId,
      derivLive, derivStatus, derivLastError, derivLastTickAt, version: db.config.appVersion,
      recovery: { googleAvailable: !!db.config.recovery.googleEmail, googleEmail: maskEmail(db.config.recovery.googleEmail), phoneAvailable: !!db.config.recovery.phone, phone: maskPhone(db.config.recovery.phone) },
      support: { phone: db.config.profile.supportPhone || '081 609 0300', email: db.config.profile.supportEmail || 'ricardohaindaka2006@gmail.com', website: db.config.profile.website || 'https://rhpilot.com' },
      maintenance: visible, plans: db.config.plans, licenseRequired: !!db.config.licenseRequired,
      engine: {
        weights: db.config.engineWeights, stats: db.config.engineStats,
        defaultStrategy: db.config.engine.defaultStrategy,
        strategies: strategyCatalogue(),
        reportGeneratedAt: db.config.engine.report ? db.config.engine.report.generatedAt : null,
        spreadAtr: db.config.engine.report ? db.config.engine.report.spreadAtr : null
      }
    });
  }
  if (p === '/api/public/profile' && method === 'GET') return sendJson(res, 200, { app: 'R.H PILOT', version: db.config.appVersion, website: db.config.profile.website || 'https://rhpilot.com', derivAppId: db.config.derivAppId || '', profile: db.config.profile });
  if (p === '/api/public/ratings' && method === 'GET') {
    const rs = db.config.ratings, avg = rs.length ? rs.reduce((a, r) => a + r.stars, 0) / rs.length : 0, dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    rs.forEach(r => { dist[r.stars] = (dist[r.stars] || 0) + 1; });
    return sendJson(res, 200, { count: rs.length, average: Math.round(avg * 10) / 10, distribution: dist, recent: rs.slice(0, 8).map(r => ({ stars: r.stars, name: r.name, comment: r.comment, at: r.at })) });
  }
  if (p === '/api/public/rating' && method === 'POST') {
    const ip = req.socket.remoteAddress || 'x';
    if (tooManyAttempts(ip)) return sendJson(res, 429, { error: 'too-many-attempts' });
    const parsed = parseInt(body.stars, 10);
    if (!parsed || parsed < 1 || parsed > 5) return sendJson(res, 400, { error: 'stars-required' });
    const rate = { id: crypto.randomBytes(6).toString('hex'), stars: parsed, name: String(body.name || '').slice(0, 40).trim(), comment: String(body.comment || '').slice(0, 300).trim(), at: Date.now(), ip };
    db.config.ratings.unshift(rate); if (db.config.ratings.length > 500) db.config.ratings.length = 500;
    noteAttempt(ip); saveDb();
    const avg = db.config.ratings.reduce((a, r) => a + r.stars, 0) / db.config.ratings.length;
    return sendJson(res, 201, { ok: true, count: db.config.ratings.length, average: Math.round(avg * 10) / 10 });
  }
  if (p === '/api/calendar' && method === 'GET') return sendJson(res, 200, { generatedAt: Date.now(), events: buildCalendar() });
  if (p === '/api/market/desk' && method === 'GET') return sendJson(res, 200, { generatedAt: Date.now(), news: (db.config.news || []).slice(0, 40), advisor: marketAdvisor(), events: buildCalendar().slice(0, 8) });
  if (p === '/api/auth/google' && method === 'POST') {
    let info;
    try { info = await verifyGoogleIdentity(body); } catch (e) { return sendJson(res, e.httpStatus || 401, { error: e.code || 'google-token-invalid' }); }
    let user = db.users.find(u => u.email === String(info.email).toLowerCase());
    if (!user) { user = makeUser(info.email, crypto.randomBytes(16).toString('hex'), 'user'); user.provider = 'google'; db.users.push(user); }
    if (!user.active) return sendJson(res, 403, { error: 'account-disabled' });
    if (user.role !== 'admin') {
      const lc = licenseCheck(req); if (!lc.ok) return sendJson(res, 403, { error: lc.error, message: 'Enter your license key to sign in.' });
      if (!bindLicense(lc.lic, user)) return licenseBindingError(res);
    }
    setSessionCookie(res, createSession(user.id), req); recordLogin(user, 'google', req); saveDb();
    return sendJson(res, 200, { user: publicUser(user), bot: publicBot(user.bot) });
  }
  if (p === '/api/auth/deriv/start' && method === 'GET') {
    if (!db.config.derivAppId) return redirect(res, '/?deriv=unconfigured');
    if (url.searchParams.get('link') === '1') {
      const me = getSessionUser(req); if (!me) return redirect(res, '/?deriv=not-signed-in');
      setDerivLinkCookie(res, me.id);
    }
    const state = crypto.randomBytes(24).toString('hex');
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    setOAuthStateCookie(res, state, req);
    setOAuthVerifierCookie(res, verifier, req);
    return redirect(res, derivOAuthStartUrl(req, state, challenge));
  }
  if (p === '/api/auth/deriv/callback' && method === 'GET') {
    const cookies = parseCookies(req), returnedState = url.searchParams.get('state');
    clearOAuthStateCookie(res);
    clearOAuthVerifierCookie(res);
    if (!cookies.derivstate || !returnedState || cookies.derivstate !== returnedState) return redirect(res, '/?deriv=invalid-state');
    const code = url.searchParams.get('code');
    if (!code) return redirect(res, '/?deriv=error');
    try {
      const token = await derivOAuthExchange(code, req, cookies.derivverifier), acct = await derivFetchAccount(token);
      const linkId = cookies.derivlink, sessionUser = getSessionUser(req), linkTarget = linkId && sessionUser && sessionUser.id === linkId ? sessionUser : null;
      if (linkTarget) {
        linkTarget.deriv = { loginid: acct.loginid, token, currency: acct.currency, balance: acct.balance, isVirtual: acct.isVirtual, connectedAt: Date.now(), via: 'oauth', accounts: acct.accounts || [] };
        clearDerivLinkCookie(res); saveDb(); return redirect(res, '/?deriv=linked');
      }
      let du = db.users.find(u => u.deriv && u.deriv.loginid === acct.loginid);
      if (!du && acct.email) du = db.users.find(u => u.email === String(acct.email).toLowerCase());
      if (!du) {
        const email = acct.email ? String(acct.email).toLowerCase() : acct.loginid.toLowerCase() + '@deriv.local';
        du = makeUser(email, crypto.randomBytes(16).toString('hex'), 'user'); du.provider = 'deriv'; db.users.push(du);
      }
      if (!du.active) return redirect(res, '/?deriv=disabled');
      if (du.role !== 'admin') {
        const lc = licenseCheck(req); if (!lc.ok) return redirect(res, '/?license=required');
        if (!bindLicense(lc.lic, du)) return redirect(res, '/?license=bound');
      }
      du.deriv = { loginid: acct.loginid, token, currency: acct.currency, balance: acct.balance, isVirtual: acct.isVirtual, connectedAt: Date.now(), via: 'oauth', accounts: acct.accounts || [] };
      setSessionCookie(res, createSession(du.id), req); recordLogin(du, 'deriv', req); saveDb();
      return redirect(res, '/?deriv=linked');
    } catch (e) { derivLastError = 'deriv-oauth: ' + e.message; console.error('[deriv] oauth failed:', e.message); return redirect(res, '/?deriv=error'); }
  }
  if (p === '/api/license/status' && method === 'GET') {
    const c = licenseCheck(req);
    return sendJson(res, 200, { required: !!db.config.licenseRequired, ok: c.ok, error: c.error || null, key: c.lic ? c.lic.key : null, boundEmail: c.lic ? c.lic.boundEmail || null : null });
  }
  if (p === '/api/license/check' && method === 'POST') {
    const ip = req.socket.remoteAddress || 'x';
    if (tooManyAttempts(ip)) return sendJson(res, 429, { error: 'too-many-attempts' });
    const c = licenseCheck(req, body.key);
    if (!c.ok) { noteAttempt(ip); return sendJson(res, 403, { error: c.error }); }
    if (c.lic) setLicenseCookie(res, c.lic.key);
    return sendJson(res, 200, { ok: true, key: c.lic ? c.lic.key : null, boundEmail: c.lic ? c.lic.boundEmail || null : null });
  }
  if (p === '/api/auth/recover/start' && method === 'POST') {
    const ip = req.socket.remoteAddress || 'x'; if (tooManyAttempts(ip)) return sendJson(res, 429, { error: 'too-many-attempts' });
    const rc = db.config.recovery, admin = db.users.find(u => u.role === 'admin' && u.active);
    if (!admin) return sendJson(res, 404, { error: 'no-admin' });
    if (String(body.method || 'phone') === 'google') {
      if (!rc.googleEmail) return sendJson(res, 400, { error: 'recovery-google-unset' });
      return sendJson(res, 200, { ok: true, method: 'google', googleEmail: maskEmail(rc.googleEmail) });
    }
    const code = String(crypto.randomInt(100000, 1000000));
    rc.pending = { codeHash: hashPassword(code), expiresAt: Date.now() + 15 * 60 * 1000, attempts: 0, createdAt: Date.now(), channel: rc.whatsappWebhook ? 'whatsapp' : 'console' };
    markDirty();
    const line = '[recovery] admin password reset code: ' + code + ' (valid 15 min, for ' + admin.email + ')';
    console.log(line);
    try { fs.writeFileSync(path.join(DATA_DIR, 'recovery-code.txt'), line + '\n', { mode: 0o600 }); } catch (e) {}
    if (rc.whatsappWebhook) fetch(rc.whatsappWebhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: rc.phone || '', channel: 'whatsapp', code, purpose: 'admin-password-reset', app: 'R.H PILOT' }) }).catch(e => console.error('[recovery] webhook:', e.message));
    const delivered = [];
    if (rc.whatsappWebhook) delivered.push('WhatsApp');
    if (db.config.mail.webhookUrl) {
      sendMail({ to: admin.email, subject: 'R.H PILOT admin password reset code', text: 'Your R.H PILOT administrator reset code is ' + code + '. It expires in 15 minutes.\n\nIf you did not request this, change your password immediately.' })
        .then(r => { if (r.delivered) delivered.push('email'); })
        .catch(e => console.error('[recovery] mail:', e.message));
      delivered.push('email');
    }
    const vendor = db.config.profile.supportPhone || rc.phone || '081 609 0300';
    return sendJson(res, 200, {
      ok: true, method: 'code', channel: rc.pending.channel,
      phone: maskPhone(rc.phone), supportPhone: vendor,
      message: delivered.length
        ? 'Reset code sent via ' + [...new Set(delivered)].join(' and ') + '.'
        : 'Reset code written to the server console and data/recovery-code.txt. Add a WhatsApp webhook or mail provider in Platform settings to deliver it automatically.'
    });
  }
  if (p === '/api/auth/recover/verify' && method === 'POST') {
    const ip = req.socket.remoteAddress || 'x'; if (tooManyAttempts(ip)) return sendJson(res, 429, { error: 'too-many-attempts' });
    const pend = db.config.recovery.pending;
    if (!pend || Date.now() > pend.expiresAt) return sendJson(res, 400, { error: 'code-expired' });
    if (pend.attempts >= 5) return sendJson(res, 429, { error: 'too-many-attempts' });
    if (!verifyPassword(String(body.code || ''), pend.codeHash)) { pend.attempts++; noteAttempt(ip); markDirty(); return sendJson(res, 401, { error: 'code-invalid' }); }
    const ticket = issueResetTicket('code'); db.config.recovery.pending = null; markDirty();
    return sendJson(res, 200, { ok: true, ticket });
  }
  if (p === '/api/auth/recover/google' && method === 'POST') {
    try { return sendJson(res, 200, await recoverViaGoogle(body)); }
    catch (e) { return sendJson(res, e.httpStatus || 401, { error: e.code || 'google-token-invalid' }); }
  }
  if (p === '/api/auth/recover/reset' && method === 'POST') {
    try { return sendJson(res, 200, await resetAdminPassword(body.ticket, body.password)); }
    catch (e) { return sendJson(res, e.httpStatus || 400, { error: e.code || 'reset-failed' }); }
  }

  const user = getSessionUser(req);
  if (!user) return sendJson(res, 401, { error: 'not-authenticated' });
  if (user.role !== 'admin' && db.config.licenseRequired && user.licenseKey) {
    // Authorise against the key BOUND TO THIS ACCOUNT, not any valid cookie.
    // Otherwise a client could hide an expired subscription by presenting a
    // different, unbound key after signing in.
    const own = findLicense(user.licenseKey);
    const expired = user.licenseExpiresAt && Date.now() > user.licenseExpiresAt;
    if (!own || own.boundUserId !== user.id || own.status === 'revoked' || expired) {
      if (own && expired) { own.status = 'expired'; user.paid = false; }
      flattenBot(user, own && own.status === 'revoked' ? 'license-revoked' : 'license-expired');
      revokeSession(req, res);
      const error = own && own.status === 'revoked' ? 'license-revoked' : 'license-expired';
      return sendJson(res, 401, { error, message: 'Your license is no longer active. Enter a renewed license key to continue.' });
    }
  }
  if (p === '/api/auth/unlock-admin' && method === 'POST') {
    const ip = req.socket.remoteAddress || 'x'; if (tooManyAttempts(ip)) return sendJson(res, 429, { error: 'too-many-attempts' });
    const email = String(body.email || '').toLowerCase().trim(), admin = db.users.find(u => u.email === email && u.role === 'admin' && u.active);
    if (!admin || !verifyPassword(body.password, admin.pass)) { noteAttempt(ip); return sendJson(res, 401, { error: 'invalid-credentials' }); }
    user.role = 'admin'; user.paid = true; markDirty(); recordLogin(user, 'admin-unlock', req);
    return sendJson(res, 200, { user: publicUser(user), bot: publicBot(user.bot) });
  }
  if (p === '/api/auth/link/google' && method === 'POST') {
    let info;
    try { info = await verifyGoogleIdentity(body); } catch (e) { return sendJson(res, e.httpStatus || 401, { error: e.code || 'google-token-invalid' }); }
    const email = String(info.email).toLowerCase(), other = db.users.find(u => u.id !== user.id && u.email === email);
    if (other) return sendJson(res, 409, { error: 'google-email-in-use' });
    user.google = { email, sub: info.sub || null, linkedAt: Date.now() };
    if (!user.email || user.email.endsWith('@deriv.local')) user.email = email;
    markDirty(); return sendJson(res, 200, { user: publicUser(user) });
  }
  if (isMaintenanceBlocked(user)) return sendJson(res, 503, { error: 'maintenance', maintenance: db.config.maintenance });

  if (p === '/api/bot/state' && method === 'GET') return sendJson(res, 200, { bot: publicBot(user.bot), price: peekPrice(user.bot.symbol), source: sourceOf(user.bot.symbol), signal: signalScore(user.bot.symbol) });
  /* The welcome manual is shown exactly once, on the first login, then never
     again unless an admin resets the flag for that client. */
  /* Admin-editable manual text. The founder/support lines are defaults, not
     hard-coded claims, so they can be corrected without a redeploy. */
  if (p === '/api/admin/manual' && method === 'POST') {
    if (user.role !== 'admin') return sendJson(res, 403, { error: 'admin-only' });
    const t = body && body.text != null ? String(body.text).slice(0, 4000) : null;
    if (t == null) return sendJson(res, 400, { error: 'missing-text' });
    db.config.manualText = t;
    markDirty();
    return sendJson(res, 200, { ok: true, manualText: t });
  }
  if (p === '/api/admin/manual-reset' && method === 'POST') {
    if (user.role !== 'admin') return sendJson(res, 403, { error: 'admin-only' });
    const target = body && body.email ? db.users.find(x => x.email === String(body.email).toLowerCase()) : null;
    if (!target) return sendJson(res, 404, { error: 'no-such-client' });
    target.manualSeen = false;
    markDirty();
    return sendJson(res, 200, { ok: true, email: target.email, manualSeen: false });
  }
  if (p === '/api/user/manual-seen' && method === 'POST') {
    user.manualSeen = true;
    markDirty();
    return sendJson(res, 200, { ok: true, manualSeen: true });
  }
  if (p === '/api/bot/start' && method === 'POST') {
    if (db.config.licenseRequired && user.role !== 'admin' && user.paid !== true) return sendJson(res, 402, { error: 'payment-required', message: 'Complete your payment — the admin will restore access once confirmed.' });
    const b = user.bot;
    if (b.positions.length) {
      const oldPrice = peekPrice(b.symbol); let guard = 0;
      while (b.positions.length && guard++ < 500) closePos(user, b.positions.length - 1, oldPrice, 'restart');
    }
    b.symbol = DERIV_SYMBOLS[body.symbol] ? body.symbol : b.symbol;
    /* A client may declare the real size of the account they are trading. Every
       money limit then scales to it, so a $2 account is protected in proportion. */
    if (body.startBalance !== undefined) {
      const declared = Number(body.startBalance);
      if (Number.isFinite(declared) && declared > 0) {
        b.balance = +declared.toFixed(2);
        b.startBalance = b.balance;
        b.dayLoss = 0;
        applyPreset(b, body.preset || b.preset || 'safe', b.balance);
      }
    }
    b.lots = Math.min(100, Math.max(0.00005, Number(body.lots) || b.lots || 0.01));
    b.tp = Math.min(1000000, Math.max(0.01, Math.abs(Number(body.tp) || 10)));
    b.sl = Math.min(1000000, Math.max(0.01, Math.abs(Number(body.sl) || 2.5)));
    b.maxTrades = Math.min(20, Math.max(1, parseInt(body.maxTrades, 10) || 3));
    b.aggression = Math.min(10, Math.max(1, parseInt(body.aggression, 10) || 6));
    if (!Number.isFinite(b.startBalance)) b.startBalance = Number(b.balance) || 100;
    // strategy + risk controls chosen by the client
    if (typeof body.strategy === 'string') {
      const wanted = body.strategy.trim();
      if (wanted === 'auto' || ENGINE.STRATEGIES[wanted]) b.strategy = wanted;
    }
    if (body.preset && PRESETS[body.preset] && body.startBalance === undefined) applyPreset(b, body.preset);
    if (body.autoRisk !== undefined) b.autoRisk = !!body.autoRisk;
    if (body.riskPerTrade !== undefined) b.riskPerTrade = Math.max(0.1, Math.min(25, Number(body.riskPerTrade) || 1));
    if (body.maxLossPerTrade !== undefined) b.maxLossPerTrade = Math.max(0, Math.min(capCeiling(b), Number(body.maxLossPerTrade) || 0));
    if (body.dailyLossLimit !== undefined) b.dailyLossLimit = Math.max(0, Math.min(capCeiling(b) * 10, Number(body.dailyLossLimit) || 0));
    if (body.lockInProfit !== undefined) b.lockInProfit = !!body.lockInProfit;
    b.trailing = body.trailing === undefined ? b.trailing : !!body.trailing;
    b.profitTarget = Math.max(0, Number(body.profitTarget) || 0);
    b.targetHit = null; b.positions = []; b.running = true; b.startedAt = Date.now(); b.lastEntryAt = 0; markDirty();
    return sendJson(res, 200, { bot: publicBot(b), signal: signalScore(b.symbol) });
  }
  // Change strategy and/or risk settings without restarting the engine.
  if (p === '/api/bot/settings' && method === 'POST') {
    const b = user.bot;
    if (typeof body.strategy === 'string') {
      const wanted = body.strategy.trim();
      if (wanted !== 'auto' && !ENGINE.STRATEGIES[wanted]) return sendJson(res, 400, { error: 'unknown-strategy', message: 'That strategy is not in the catalogue.' });
      b.strategy = wanted;
    }
    // A preset sets the whole risk block in one call.
    if (typeof body.preset === 'string' && PRESETS[body.preset]) applyPreset(b, body.preset, b.balance);
    if (body.autoRisk !== undefined) b.autoRisk = !!body.autoRisk;
    if (body.riskPerTrade !== undefined) b.riskPerTrade = Math.max(0.1, Math.min(25, Number(body.riskPerTrade) || 1));
    // The money limits: 0 turns a guard off, otherwise clamp to something sane.
    if (body.maxLossPerTrade !== undefined) b.maxLossPerTrade = Math.max(0, Math.min(capCeiling(b), Number(body.maxLossPerTrade) || 0));
    if (body.dailyLossLimit !== undefined) b.dailyLossLimit = Math.max(0, Math.min(capCeiling(b) * 10, Number(body.dailyLossLimit) || 0));
    if (body.lockInProfit !== undefined) b.lockInProfit = !!body.lockInProfit;
    if (body.lockAfterR !== undefined) b.lockAfterR = Math.max(0.1, Math.min(1, Number(body.lockAfterR) || 0.5));
    if (body.trailAfterR !== undefined) b.trailAfterR = Math.max(0.2, Math.min(3, Number(body.trailAfterR) || 1));
    if (body.trailByR !== undefined) b.trailByR = Math.max(0.1, Math.min(2, Number(body.trailByR) || 0.4));
    if (body.maxTrades !== undefined) b.maxTrades = Math.max(1, Math.min(10, parseInt(body.maxTrades, 10) || 1));
    if (body.aggression !== undefined) b.aggression = Math.max(1, Math.min(10, parseInt(body.aggression, 10) || 6));
    if (body.lots !== undefined) b.lots = Math.min(100, Math.max(0.001, Number(body.lots) || 0.001));
    // Any hand-tuned field means the client left the preset.
    if (!body.preset && b.preset) b.preset = 'custom';
    const sel = strategyFor(b);
    markDirty();
    return sendJson(res, 200, { bot: publicBot(b), active: sel.id, params: sel.params });
  }
  // Resync / refresh: retire expired positions, clean the feed, re-anchor cash.
  if (p === '/api/bot/refresh' || p === '/api/bot/resync') {
    if (method !== 'POST') return sendJson(res, 405, { error: 'method-not-allowed' });
    const mode = body.mode === 'hard' ? 'hard' : 'soft';
    if (user.deriv && user.deriv.token) {
      try {
        const acct = await derivFetchAccount(user.deriv.token, user.deriv.loginid);
        user.deriv.balance = acct.balance;
        user.deriv.accounts = acct.accounts || user.deriv.accounts;
      } catch (e) { derivLastError = 'resync: ' + e.message; }
    }
    const report = resyncBot(user, { mode });
    return sendJson(res, 200, { bot: publicBot(user.bot), report, refreshedAt: Date.now(), deriv: user.deriv ? derivAccountPublic(user) : null });
  }
  if (p === '/api/bot/target' && method === 'POST') {
    const b = user.bot; b.profitTarget = Math.max(0, Number(body.target) || 0);
    if (b.profitTarget === 0 || b.profit < b.profitTarget) b.targetHit = null;
    markDirty(); return sendJson(res, 200, { bot: publicBot(b) });
  }
  if (p === '/api/bot/stop' || p === '/api/bot/closeall') {
    if (method !== 'POST') return sendJson(res, 404, { error: 'not-found' });
    const b = user.bot; b.running = false;
    const price = peekPrice(b.symbol); let guard = 0;
    while (b.positions.length && guard++ < 500) closePos(user, b.positions.length - 1, price, p.endsWith('closeall') ? 'emergency' : 'stopped');
    markDirty(); return sendJson(res, 200, { bot: publicBot(b) });
  }
  if (p === '/api/bot/refresh' && method === 'POST') {
    const b = user.bot; resetMarket(b.symbol); b.lastEntryAt = 0; markDirty();
    return sendJson(res, 200, { bot: publicBot(b), refreshedAt: Date.now() });
  }
  if (p === '/api/deriv/link' && method === 'POST') {
    const token = String(body.token || '').trim(); if (!token) return sendJson(res, 400, { error: 'missing-token' });
    try {
      const acct = await derivFetchAccount(token);
      user.deriv = { loginid: acct.loginid, token, currency: acct.currency, balance: acct.balance, isVirtual: acct.isVirtual, connectedAt: Date.now(), via: 'token', accounts: acct.accounts || [] };
      saveDb(); return sendJson(res, 200, { deriv: derivAccountPublic(user), cashier: cashierUrls(acct.loginid) });
    } catch (e) { derivLastError = 'deriv-link: ' + e.message; return sendJson(res, 502, { error: 'deriv-link-failed', message: 'Could not verify that token with Deriv: ' + e.message }); }
  }
  if (p === '/api/deriv/unlink' && method === 'POST') {
    if (user.bot.live && user.bot.positions.some(x => x.contractId || x.livePending)) return sendJson(res, 409, { error: 'live-positions-open', message: 'Stop the bot and close live positions before unlinking.' });
    user.deriv = null; user.bot.live = false; saveDb(); return sendJson(res, 200, { deriv: null, live: false });
  }
  if (p === '/api/deriv/refresh' && method === 'POST') {
    if (!user.deriv) return sendJson(res, 400, { error: 'no-deriv-account' });
    try {
      const acct = await derivFetchAccount(user.deriv.token, user.deriv.loginid);
      user.deriv.balance = acct.balance; user.deriv.currency = acct.currency || user.deriv.currency; user.deriv.isVirtual = acct.isVirtual; user.deriv.accounts = acct.accounts || user.deriv.accounts;
      markDirty(); return sendJson(res, 200, { deriv: derivAccountPublic(user) });
    } catch (e) { derivLastError = 'deriv-refresh: ' + e.message; return sendJson(res, 502, { error: 'deriv-refresh-failed', message: e.message }); }
  }
  if (p === '/api/deriv/cashier' && method === 'GET') return sendJson(res, 200, { linked: !!user.deriv, deriv: derivAccountPublic(user), cashier: cashierUrls(user.deriv && user.deriv.loginid) });
  /* Connection check.
     Two separate questions, because they fail in different ways:
       1. can THIS SERVER reach Deriv at all  -> a socket/time question
       2. can THIS ACCOUNT actually trade     -> an authority/token question
     A green light on (1) while (2) is broken is exactly how a client ends up
     pressing start and watching nothing happen. Both are reported, and an active
     account is verified for real rather than assumed from the cached list. */
  if (p === '/api/deriv/test' && method === 'POST') {
    const t0 = Date.now();
    const out = { ok: false, serverOk: false, accountOk: null, latency: 0, serverTime: null, appId: db.config.derivAppId };
    try {
      const msg = await derivCall({ time: 1 }, 8000), st = msg && msg.time;
      out.serverOk = true;
      out.serverTime = st ? new Date(st * 1000).toISOString() : null;
    } catch (e) { out.error = 'server: ' + e.message; }

    if (user.deriv && user.deriv.token) {
      try {
        const acct = await derivFetchAccount(user.deriv.token, user.deriv.loginid);
        /* Refresh the cached figures, so a successful test doubles as a sync. */
        user.deriv.balance = Number.isFinite(Number(acct.balance)) ? Number(acct.balance) : user.deriv.balance;
        user.deriv.isVirtual = !!acct.isVirtual;
        user.deriv.accounts = acct.accounts && acct.accounts.length ? acct.accounts : user.deriv.accounts;
        user.deriv.verifiedAt = Date.now();
        markDirty();
        out.accountOk = true;
        out.account = { loginid: acct.loginid, isVirtual: !!acct.isVirtual, currency: acct.currency, balance: acct.balance };
      } catch (e) {
        out.accountOk = false;
        out.error = (out.error ? out.error + ' | ' : '') + 'account: ' + e.message;
      }
    }
    out.latency = Date.now() - t0;
    /* ok means "this bot can actually trade on the account you selected". */
    out.ok = out.serverOk && (out.accountOk !== false);
    return sendJson(res, 200, out);
  }
  /* Prove the real-money path end to end without placing an order: is the linked
     account authorised, is it real, and has the client armed execution? */
  if (p === '/api/deriv/ready' && method === 'GET') {
    if (!user.deriv) return sendJson(res, 200, { ready: false, reason: 'no-account', message: 'Link your Deriv account first.' });
    if (!user.deriv.token) return sendJson(res, 200, { ready: false, reason: 'no-token', message: 'No trading token is stored for this account.' });
    let acct;
    try { acct = await derivFetchAccount(user.deriv.token, user.deriv.loginid); }
    catch (e) { return sendJson(res, 200, { ready: false, reason: 'unreachable', message: 'Deriv did not confirm this account: ' + e.message }); }
    if (acct.isVirtual) {
      return sendJson(res, 200, {
        ready: false, reason: 'demo-account', account: { loginid: acct.loginid, isVirtual: true, balance: acct.balance },
        message: 'This is a DEMO account. It can trade practice funds only — switch to your real account to risk real money.'
      });
    }
    const armed = !!user.bot.live;
    return sendJson(res, 200, {
      ready: armed, reason: armed ? 'ok' : 'not-armed',
      account: { loginid: acct.loginid, isVirtual: false, balance: acct.balance, currency: acct.currency },
      message: armed ? 'Real trading is armed and the account is confirmed.' : 'Account confirmed. Arm real-money execution to start placing contracts.'
    });
  }
  /* Switch the active Deriv account between the client's demo and real accounts.
     Nothing here touches money: it only changes which account the bot is bound
     to. Real trading still requires the explicit arming above. */
  if (p === '/api/deriv/account' && method === 'POST') {
    if (!user.deriv) return sendJson(res, 400, { error: 'no-deriv-account', message: 'Link your Deriv account first.' });
    if (user.bot.positions.some(p => p.contractId || p.livePending)) {
      return sendJson(res, 409, { error: 'live-positions-open', message: 'Stop the bot and close open contracts before switching accounts.' });
    }
    const list = Array.isArray(user.deriv.accounts) ? user.deriv.accounts : [];
    if (!list.length) return sendJson(res, 400, { error: 'no-accounts', message: 'Only one account is linked to this login.' });
    const wanted = String(body.loginid || '');
    const pick = wanted
      ? list.find(a => a.loginid === wanted)
      : list.find(a => (body.mode === 'real' ? !a.isVirtual : a.isVirtual));
    if (!pick) return sendJson(res, 404, { error: 'account-not-found', message: 'That account is not linked to this login.' });

    /* Switching must be PROVEN, not assumed. The cached list could be stale, and
       the token may not carry authority for the account being selected. Ask Deriv
       for that specific account before binding the bot to it. */
    let verified;
    try {
      verified = await derivFetchAccount(user.deriv.token, pick.loginid);
    } catch (e) {
      return sendJson(res, 502, {
        error: 'deriv-account-unavailable',
        message: 'Deriv did not confirm that account for this login (' + e.message + '). Nothing was switched.'
      });
    }
    /* Switching to a demo account must also disarm real trading, so a stray
       setting can never leave the bot armed against the wrong account. */
    if (pick.isVirtual) user.bot.live = false;
    user.deriv.loginid = verified.loginid || pick.loginid;
    user.deriv.currency = verified.currency || pick.currency || user.deriv.currency;
    /* The balance comes from Deriv at this moment, never from the stale cache —
       showing the wrong balance on a real account is how people risk the wrong
       amount. */
    user.deriv.balance = Number.isFinite(Number(verified.balance)) ? Number(verified.balance) : pick.balance;
    user.deriv.isVirtual = !!verified.isVirtual;
    user.deriv.accounts = verified.accounts && verified.accounts.length ? verified.accounts : user.deriv.accounts;
    user.deriv.verifiedAt = Date.now();
    markDirty();
    return sendJson(res, 200, { deriv: derivAccountPublic(user), live: user.bot.live, realArmed: canTradeReal(user) });
  }
  if (p === '/api/bot/live' && method === 'POST') {
    if (db.config.licenseRequired && body.live && user.role !== 'admin' && user.paid !== true) return sendJson(res, 402, { error: 'payment-required' });
    const want = !!body.live;
    if (want) {
      if (!user.deriv) return sendJson(res, 400, { error: 'no-deriv-account', message: 'Link your Deriv account first.' });
      if (!user.deriv.token) return sendJson(res, 400, { error: 'no-token' });
      if (body.confirm !== true) return sendJson(res, 400, { error: 'confirm-required', message: 'Real-money trading must be confirmed.' });
      /* The account in use decides this, not the client's intent. A demo account
         has no real funds, so arming it would only produce skipped orders. */
      if (user.deriv.isVirtual) {
        return sendJson(res, 400, {
          error: 'demo-account',
          message: 'This Deriv account is a DEMO account. Switch to your real account before arming real-money trading.'
        });
      }
      if (Number(body.stake) > 0) user.bot.liveStake = Math.min(1000, Math.max(0.35, Number(body.stake)));
    }
    if (!want && user.bot.positions.some(p => p.contractId || p.livePending)) {
      return sendJson(res, 409, { error: 'live-positions-open', message: 'Stop the bot and close open live contracts before switching to simulation.' });
    }
    user.bot.live = want;
    markDirty(); return sendJson(res, 200, { live: user.bot.live, liveStake: user.bot.liveStake, deriv: derivAccountPublic(user) });
  }
  if (p === '/api/market/symbols' && method === 'GET') return sendJson(res, 200, { symbols: Object.keys(DERIV_SYMBOLS), live: derivLive });
  if (p === '/api/market/best-pair' && method === 'GET') {
    const pick = bestPair();
    return sendJson(res, 200, {
      best: pick ? pick.symbol : null,
      direction: pick ? pick.direction : null,
      score: pick ? Number(pick.score.toFixed(3)) : 0,
      note: pick
        ? `Strongest signals on ${pick.symbol} right now (${pick.direction.toLowerCase()} bias).`
        : 'Still collecting ticks — any pair is fine to start with.'
    });
  }
  if (p === '/api/market/stream' && method === 'GET') {
    const symbol = url.searchParams.get('symbol') || 'XAUUSD';
    if (!DERIV_SYMBOLS[symbol]) return sendJson(res, 400, { error: 'bad-symbol' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n'); sseClients.set(res, { symbol, userId: user.id });
    const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (e) {} }, 15000);
    req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
    return;
  }

  if (p.startsWith('/api/admin/')) {
    if (user.role !== 'admin') return sendJson(res, 403, { error: 'admin-only' });
    if (p === '/api/admin/users' && method === 'GET') return sendJson(res, 200, { users: db.users.map(u => ({ ...publicUser(u), running: u.bot.running, balance: u.bot.balance, profit: u.bot.profit, symbol: u.bot.symbol, live: !!u.bot.live, online: isUserOnline(u) })) });
    if (p === '/api/admin/users' && method === 'POST') {
      const email = String(body.email || '').toLowerCase().trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJson(res, 400, { error: 'bad-email' });
      if (db.users.some(u => u.email === email)) return sendJson(res, 409, { error: 'email-taken' });
      const pw = String(body.password || ''); if (pw.length < 8) return sendJson(res, 400, { error: 'weak-password' });
      const nu = makeUser(email, pw, body.role === 'admin' ? 'admin' : 'user'); db.users.push(nu); saveDb();
      return sendJson(res, 201, { user: publicUser(nu) });
    }
    const mUser = p.match(/^\/api\/admin\/users\/([^/]+)$/);
    if (mUser && method === 'PATCH') {
      const target = db.users.find(u => u.id === mUser[1]); if (!target) return sendJson(res, 404, { error: 'not-found' });
      if (typeof body.active === 'boolean') target.active = body.active;
      if (body.role === 'admin' || body.role === 'user') {
        if (target.role === 'admin' && body.role === 'user' && db.users.filter(u => u.role === 'admin').length <= 1) return sendJson(res, 400, { error: 'last-admin' });
        target.role = body.role;
      }
      if (typeof body.paid === 'boolean') target.paid = body.paid;
      if (!target.active || target.paid === false) flattenBot(target, 'access-restricted');
      markDirty(); return sendJson(res, 200, { user: publicUser(target) });
    }
    const mPay = p.match(/^\/api\/admin\/users\/([^/]+)\/payment$/);
    if (mPay && method === 'POST') {
      const target = db.users.find(u => u.id === mPay[1]); if (!target) return sendJson(res, 404, { error: 'not-found' });
      target.paid = !!body.paid;
      if (!target.paid) flattenBot(target, 'payment-restricted');
      markDirty(); return sendJson(res, 200, { user: publicUser(target) });
    }
    if (mUser && method === 'DELETE') {
      if (mUser[1] === user.id) return sendJson(res, 400, { error: 'cannot-delete-self' });
      const idx = db.users.findIndex(u => u.id === mUser[1]); if (idx === -1) return sendJson(res, 404, { error: 'not-found' });
      if (db.users[idx].role === 'admin' && db.users.filter(u => u.role === 'admin').length <= 1) return sendJson(res, 400, { error: 'last-admin' });
      const removed = db.users[idx];
      flattenBot(removed, 'account-deleted');
      db.users.splice(idx, 1);
      Object.keys(db.sessions).forEach(k => { if (db.sessions[k].userId === removed.id) delete db.sessions[k]; });
      saveDb(); return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/admin/config' && method === 'GET') return sendJson(res, 200, { config: db.config, runtime: { derivLive, derivStatus, derivLastError, derivLastTickAt, users: db.users.length, sessions: Object.keys(db.sessions).length } });
    if (p === '/api/admin/config' && method === 'PUT') {
      if (typeof body.derivAppId === 'string' && body.derivAppId.trim()) {
        const next = body.derivAppId.trim(); if (next !== db.config.derivAppId) { db.config.derivAppId = next; if (derivWs) try { derivWs.close(); } catch (e) {} }
      }
      if (typeof body.googleClientId === 'string') db.config.googleClientId = body.googleClientId.trim();
      if (body.derivOAuthMode === 'new') db.config.derivOAuthMode = 'new';
      if (typeof body.mt5BridgeUrl === 'string') db.config.mt5BridgeUrl = body.mt5BridgeUrl.trim();
      if (typeof body.appVersion === 'string' && body.appVersion.trim()) db.config.appVersion = body.appVersion.trim();
      saveDb(); return sendJson(res, 200, { config: db.config });
    }
    if (p === '/api/admin/licenses' && method === 'GET') return sendJson(res, 200, { licenses: db.config.licenses.slice().reverse(), required: !!db.config.licenseRequired });
    if (p === '/api/admin/licenses' && method === 'POST') {
      const count = Math.max(1, Math.min(50, parseInt(body.count, 10) || 1)), label = String(body.label || '').slice(0, 80).trim(), email = String(body.email || '').toLowerCase().trim(), plan = LICENSE_PLANS[body.plan] ? body.plan : 'days30', made = [];
      for (let i = 0; i < count; i++) {
        let key; do { key = genLicenseKey(); } while (findLicense(key));
        const lic = { id: crypto.randomBytes(6).toString('hex'), key, label, email, plan, expiresAt: null, status: 'unused', createdAt: Date.now(), createdBy: user.email, boundUserId: null, boundEmail: null, redeemedAt: null };
        db.config.licenses.push(lic); made.push(lic);
      }
      saveDb(); return sendJson(res, 201, { created: made, licenses: db.config.licenses.slice().reverse() });
    }
    const mLic = p.match(/^\/api\/admin\/licenses\/([^/]+)$/);
    if (mLic && method === 'PATCH') {
      const lic = db.config.licenses.find(l => l.id === mLic[1]); if (!lic) return sendJson(res, 404, { error: 'not-found' });
      if (['revoked', 'active', 'unused'].includes(body.status)) {
        lic.status = body.status;
        const bound = db.users.find(u => u.id === lic.boundUserId);
        if (bound && body.status === 'revoked') { flattenBot(bound, 'license-revoked'); bound.paid = false; }
        if (bound && body.status === 'active' && (!lic.expiresAt || Date.now() < lic.expiresAt)) bound.paid = true;
      }
      if (typeof body.label === 'string') lic.label = body.label.slice(0, 80);
      if (typeof body.email === 'string') lic.email = body.email.toLowerCase().trim();
      saveDb(); return sendJson(res, 200, { license: lic });
    }
    if (mLic && method === 'DELETE') {
      const idx = db.config.licenses.findIndex(l => l.id === mLic[1]); if (idx === -1) return sendJson(res, 404, { error: 'not-found' });
      const lic = db.config.licenses[idx];
      if (lic.boundUserId) return sendJson(res, 409, { error: 'license-bound-delete', message: 'Revoke bound licenses instead of deleting them.' });
      db.config.licenses.splice(idx, 1); saveDb(); return sendJson(res, 200, { ok: true });
    }
    /* Free-for-everyone switch: OFF = anyone can try the bot, ON = keys required
       and every client session is dropped. Admins are never locked out. */
    if (p === '/api/admin/license-required' && method === 'PUT') return sendJson(res, 200, setLicenseMode(!!body.required));
    /* One click: revoke every unused key and drop every client session. */
    if (p === '/api/admin/license-lockdown' && method === 'POST') return sendJson(res, 200, lockdownLicenses());
    if (p === '/api/admin/logins' && method === 'GET') return sendJson(res, 200, { logins: db.config.logins.slice(0, 100) });
    if (p === '/api/admin/calendar' && method === 'GET') return sendJson(res, 200, { custom: db.config.calendar, events: buildCalendar() });
    if (p === '/api/admin/calendar' && method === 'POST') {
      const at = String(body.at || '').trim(), title = String(body.title || '').slice(0, 120).trim();
      if (!at || !title || !Number.isFinite(Date.parse(at))) return sendJson(res, 400, { error: 'missing-at-or-title' });
      const ev = { id: crypto.randomBytes(6).toString('hex'), at, time: String(body.time || '').slice(0, 40), title, impact: ['low', 'medium', 'high'].includes(body.impact) ? body.impact : 'medium', country: String(body.country || '').slice(0, 40), note: String(body.note || '').slice(0, 300) };
      db.config.calendar.push(ev); saveDb(); return sendJson(res, 201, { event: ev, custom: db.config.calendar });
    }
    const mCal = p.match(/^\/api\/admin\/calendar\/([^/]+)$/);
    if (mCal && method === 'DELETE') {
      const idx = db.config.calendar.findIndex(e => e.id === mCal[1]); if (idx === -1) return sendJson(res, 404, { error: 'not-found' });
      db.config.calendar.splice(idx, 1); saveDb(); return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/admin/news' && method === 'GET') return sendJson(res, 200, { news: db.config.news });
    if (p === '/api/admin/news' && method === 'POST') {
      const title = String(body.title || '').slice(0, 140).trim(); if (!title) return sendJson(res, 400, { error: 'missing-title' });
      const item = { id: crypto.randomBytes(6).toString('hex'), at: Date.now(), title, body: String(body.body || '').slice(0, 1200), impact: ['low', 'medium', 'high'].includes(body.impact) ? body.impact : 'medium' };
      db.config.news.unshift(item); if (db.config.news.length > 100) db.config.news.length = 100;
      saveDb(); return sendJson(res, 201, { item, news: db.config.news });
    }
    const mNews = p.match(/^\/api\/admin\/news\/([^/]+)$/);
    if (mNews && method === 'DELETE') {
      const idx = db.config.news.findIndex(n => n.id === mNews[1]); if (idx === -1) return sendJson(res, 404, { error: 'not-found' });
      db.config.news.splice(idx, 1); saveDb(); return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/admin/mail' && method === 'GET') { const m = db.config.mail; return sendJson(res, 200, { mail: { hasWebhook: !!m.webhookUrl, from: m.from, lastSentAt: m.lastSentAt, lastError: m.lastError }, outbox: db.config.mailOutbox.slice(0, 40) }); }
    if (p === '/api/admin/mail' && method === 'PUT') {
      if (typeof body.webhookUrl === 'string') db.config.mail.webhookUrl = body.webhookUrl.trim();
      if (typeof body.token === 'string') db.config.mail.token = body.token.trim();
      if (typeof body.from === 'string') db.config.mail.from = body.from.slice(0, 120);
      saveDb(); return sendJson(res, 200, { ok: true, mail: { hasWebhook: !!db.config.mail.webhookUrl, from: db.config.mail.from } });
    }
    if (p === '/api/admin/broadcast' && method === 'POST') {
      const subject = String(body.subject || '').slice(0, 150).trim(), message = String(body.message || '').slice(0, 4000).trim();
      if (!subject || !message) return sendJson(res, 400, { error: 'missing-subject-or-message' });
      const audience = body.audience === 'all' ? 'all' : 'clients', n = broadcastMail(subject, message, audience); saveDb();
      return sendJson(res, 200, { sent: n, audience, delivered: !!db.config.mail.webhookUrl, lastError: db.config.mail.lastError });
    }
    if (p === '/api/admin/backup' && method === 'POST') { const meta = writeBackup(); return sendJson(res, 200, { backup: meta, backups: listBackups(), hub: hubMeta() }); }
    if (p === '/api/admin/backups' && method === 'GET') return sendJson(res, 200, { backups: listBackups(), hub: hubMeta() });
    if (p === '/api/admin/backup/download' && method === 'GET') {
      const data = JSON.stringify(snapshot(), null, 2);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="rhpilot-backup.json"', 'Content-Length': Buffer.byteLength(data) }); return res.end(data);
    }
    if (p === '/api/admin/backup/restore' && method === 'POST') {
      const data = body.snapshot && body.snapshot.data ? body.snapshot.data : body.snapshot;
      if (!data || !Array.isArray(data.users) || !data.users.length) return sendJson(res, 400, { error: 'bad-backup' });
      if (!data.users.some(u => u.role === 'admin')) return sendJson(res, 400, { error: 'no-admin-in-backup' });
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(DB_PATH, JSON.stringify(data)); loadDb(); saveDb();
        return sendJson(res, 200, { ok: true, users: db.users.length });
      } catch (e) { return sendJson(res, 500, { error: 'restore-failed', message: e.message }); }
    }
    if (p === '/api/admin/hub' && method === 'PUT') {
      const h = db.config.hub;
      if (typeof body.url === 'string') h.url = body.url.trim();
      if (typeof body.token === 'string') h.token = body.token.trim();
      if (typeof body.autoBackup === 'boolean') h.autoBackup = body.autoBackup;
      saveDb(); return sendJson(res, 200, { hub: hubMeta() });
    }
    if (p === '/api/admin/hub/push' && method === 'POST') {
      if (!db.config.hub.url) return sendJson(res, 400, { error: 'no-hub-url' });
      try { writeBackup(); const meta = await pushToHub(); return sendJson(res, 200, { ok: true, hub: meta }); }
      catch (e) { db.config.hub.lastPushError = e.message; markDirty(); return sendJson(res, 502, { error: 'hub-push-failed', message: e.message }); }
    }
    if (p === '/api/admin/profile' && method === 'PUT') {
      const pf = db.config.profile;
      ['legalName', 'registrationNo', 'country', 'supportEmail', 'supportPhone', 'companyEmail', 'assistantPhone', 'website', 'termsUrl', 'privacyUrl', 'riskUrl', 'about'].forEach(k => { if (typeof body[k] === 'string') pf[k] = body[k].slice(0, 1000).trim(); });
      ['googleEmail', 'phone', 'whatsappWebhook'].forEach(k => { if (typeof body[k] === 'string') db.config.recovery[k] = body[k].slice(0, 300).trim(); });
      saveDb(); return sendJson(res, 200, { profile: pf, recovery: { googleEmail: db.config.recovery.googleEmail, phone: db.config.recovery.phone, whatsappWebhook: db.config.recovery.whatsappWebhook } });
    }
    if (p === '/api/admin/plans' && method === 'PUT') {
      const incoming = body.plans || {};
      Object.keys(LICENSE_PLANS).forEach(id => {
        const src = incoming[id]; if (!src || typeof src !== 'object') return;
        if (typeof src.price === 'string') db.config.plans[id].price = src.price.slice(0, 40).trim();
        if (typeof src.blurb === 'string') db.config.plans[id].blurb = src.blurb.slice(0, 200).trim();
      });
      saveDb(); return sendJson(res, 200, { plans: db.config.plans });
    }
    if (p === '/api/admin/maintenance' && method === 'PUT') {
      const r = setMaintenance(body, user.email);
      const m = r.maintenance;
      let mailed = 0;
      if (body.notify) mailed = broadcastMail('R.H PILOT update — v' + (m.version || db.config.appVersion), (m.message || 'We are updating R.H PILOT.') + (m.notes ? '\n\nWhat\'s new:\n' + m.notes : ''), 'clients');
      saveDb();
      return sendJson(res, 200, { maintenance: m, version: db.config.appVersion, mailed, stopped: r.stopped });
    }
    if (p === '/api/admin/engine' && method === 'GET') {
      return sendJson(res, 200, {
        weights: db.config.engineWeights, stats: db.config.engineStats,
        strategies: strategyCatalogue(), defaultStrategy: db.config.engine.defaultStrategy,
        reportGeneratedAt: db.config.engine.report ? db.config.engine.report.generatedAt : null
      });
    }
    if (p === '/api/admin/engine/default' && method === 'PUT') {
      const id = String(body.strategy || '').trim();
      if (!ENGINE.STRATEGIES[id]) return sendJson(res, 400, { error: 'unknown-strategy' });
      db.config.engine.defaultStrategy = id;
      saveDb();
      return sendJson(res, 200, { defaultStrategy: id, strategies: strategyCatalogue() });
    }
    if (p === '/api/admin/engine/retune' && method === 'POST') {
      const ok = loadStrategyReport();
      saveDb();
      return sendJson(res, ok ? 200 : 400, { ok, defaultStrategy: db.config.engine.defaultStrategy, strategies: strategyCatalogue() });
    }
    if (p === '/api/admin/engine/resync' && method === 'POST') {
      const mode = body.mode === 'hard' ? 'hard' : 'soft';
      let resynced = 0;
      for (const u of db.users) {
        if (!u.bot || !u.bot.running) continue;
        try { resyncBot(u, { mode }); resynced++; } catch (e) { console.error('[resync]', u.email, e.message); }
      }
      return sendJson(res, 200, { resynced, mode, at: Date.now() });
    }
    if (p === '/api/admin/engine' && method === 'PUT') {
      if (body.reset) {
        db.config.engineWeights = { trend: 1, momentum: 1, breakout: 1, reversal: 1 };
        saveDb();
        return sendJson(res, 200, { weights: db.config.engineWeights });
      }
      return sendJson(res, 400, { error: 'nothing-to-do' });
    }
    if (p === '/api/admin/stats' && method === 'GET') return sendJson(res, 200, { users: db.users.length, admins: db.users.filter(u => u.role === 'admin').length, online: countOnline(), paid: db.users.filter(u => u.role !== 'admin' && u.paid === true).length, unpaid: db.users.filter(u => u.role !== 'admin' && u.paid !== true).length, running: db.users.filter(u => u.bot.running).length, derivLive, derivStatus, derivLastError, derivLastTickAt, uptime: Math.floor(process.uptime()), version: db.config.appVersion, maintenance: db.config.maintenance, engine: { weights: db.config.engineWeights, stats: db.config.engineStats } });
    return sendJson(res, 404, { error: 'not-found' });
  }
  return sendJson(res, 404, { error: 'not-found' });
}

function publicOrigin(req) {
  const configured = String(process.env.PUBLIC_URL || '').trim();
  if (configured) {
    try {
      const parsed = new URL(configured);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed.origin;
    } catch (e) { /* use the request origin instead */ }
  }
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = forwardedProto === 'https' || req.socket.encrypted ? 'https' : 'http';
  const rawHost = req.headers['x-forwarded-host'] || req.headers.host || ('localhost:' + PORT);
  const host = String(rawHost).split(',')[0].trim().replace(/[^a-zA-Z0-9.:[\]-]/g, '');
  return proto + '://' + (host || ('localhost:' + PORT));
}
function seoToken(value) { return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function injectSeo(data, req) {
  const origin = seoToken(publicOrigin(req));
  const google = process.env.GOOGLE_SITE_VERIFICATION
    ? '<meta name="google-site-verification" content="' + seoToken(process.env.GOOGLE_SITE_VERIFICATION) + '">' : '';
  const bing = process.env.BING_SITE_VERIFICATION
    ? '<meta name="msvalidate.01" content="' + seoToken(process.env.BING_SITE_VERIFICATION) + '">' : '';
  return Buffer.from(data.toString('utf8')
    .replaceAll('__PUBLIC_URL__', origin)
    .replace('__GOOGLE_SITE_VERIFICATION_TAG__', google)
    .replace('__BING_SITE_VERIFICATION_TAG__', bing));
}
function serveStatic(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch (e) { res.writeHead(400); return res.end('bad path'); }
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = path.normalize(path.join(PUBLIC_DIR, rel));
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(full, (err, raw) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
    const ext = path.extname(full).toLowerCase();
    const dynamicSeo = full === path.join(PUBLIC_DIR, 'index.html') || rel === '/robots.txt' || rel === '/sitemap.xml';
    const data = dynamicSeo ? injectSeo(raw, req) : raw;
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      'Content-Length': data.length
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}
function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end('method not allowed'); }
      return serveStatic(req, res, url);
    }
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    let body = {};
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    try { await api(req, res, url, body); }
    catch (e) { console.error('[api]', e); if (!res.headersSent) sendJson(res, 500, { error: 'server-error' }); else if (!res.writableEnded) res.end(); }
  });
}
function engineLoop() {
  for (const u of db.users) {
    try {
      if (u.role !== 'admin' && db.config.licenseRequired && u.licenseExpiresAt && Date.now() > u.licenseExpiresAt) { flattenBot(u, 'license-expired'); u.paid = false; markDirty(); }
      if (u.bot && u.bot.running) evaluate(u);
    } catch (e) { console.error('[engine]', e.message); }
  }
}
function evaluateSymbol(key, price) {
  const now = Date.now();
  if (lastEvalAt[key] && now - lastEvalAt[key] < EVAL_MIN_GAP_MS) return;
  lastEvalAt[key] = now;
  for (const u of db.users) {
    try { if (u.bot && u.bot.running && u.bot.symbol === key) evaluate(u); }
    catch (e) { console.error('[engine:tick]', e.message); }
  }
}
function pricePump() {
  for (const k of Object.keys(DERIV_SYMBOLS)) {
    const price = currentPrice(k);
    evaluateSymbol(k, price); // event-driven Springboks evaluation on every fresh tick
    pushToSubscribers(k);
  }
}
function start(options = {}) {
  shuttingDown = false;
  loadDb(); seedAdmin(); syncAdminCredentials(); loadStrategyReport(); initMarket(); connectDeriv();
  timers.push(setInterval(() => { if (dbDirty) saveDb(); }, 4000));
  timers.push(setInterval(memoryGuard, 60 * 1000));                       // free-plan footprint
  timers.push(setInterval(() => { try { slimDb(); } catch (e) {} }, 10 * 60 * 1000));
  timers.push(setInterval(engineLoop, options.engineInterval || 100));
  timers.push(setInterval(pricePump, options.priceInterval || 120));
  timers.push(setInterval(() => {
    const now = Date.now(); let changed = false;
    Object.keys(db.sessions).forEach(t => { if (db.sessions[t].exp < now) { delete db.sessions[t]; changed = true; } });
    if (changed) markDirty();
  }, 60 * 60 * 1000));
  timers.push(setInterval(() => {
    if (!db.config.hub.autoBackup) return;
    try { writeBackup(); if (db.config.hub.url) pushToHub().catch(e => { db.config.hub.lastPushError = e.message; markDirty(); }); }
    catch (e) { console.error('[backup]', e.message); }
  }, 24 * 60 * 60 * 1000));
  timers.forEach(t => t.unref());
  server = createServer();
  const port = options.port !== undefined ? options.port : PORT;
  return new Promise(resolve => server.listen(port, options.host || HOST, () => {
    console.log('R.H PILOT running at http://' + (options.host || HOST) + ':' + server.address().port);
    console.log('Market feed: ' + derivStatus + ' (automatic simulator fallback)');
    resolve(server);
  }));
}
function stop() {
  shuttingDown = true;
  timers.forEach(clearInterval); timers.length = 0;
  if (derivReconnectTimer) clearTimeout(derivReconnectTimer);
  if (derivWs) try { derivWs.close(); } catch (e) {}
  if (server) server.close();
}
if (require.main === module) {
  start().catch(e => { console.error(e); process.exit(1); });
  process.on('SIGTERM', () => { saveDb(); stop(); process.exit(0); });
  process.on('SIGINT', () => { saveDb(); stop(); process.exit(0); });
}
module.exports = {
  start, stop, createServer, loadDb, saveDb, defaultBot, makeUser, hashPassword, verifyPassword,
  normalizeLicenseKey, planExpiry, signalScore, learnFrom, evaluate, evaluateSymbol, closePos, flattenBot, checkProfitGuard,
  notePrice, ema, rsi, pointValue, contractSize, currentPrice, peekPrice, resetMarket,
  derivRequest, derivFetchAccount, derivPlaceTrade, derivSellContract,
  setLicenseMode, lockdownLicenses, setMaintenance, freezeClients, isMaintenanceBlocked,
  repairEmail, resolveLoginEmail, syncAdminCredentials, gradeStrategy, GRADES,
  sizeFor, dailyLossBudget, dailyLimitHit, noteDayLoss, rollDay, MAX_TRADE_RISK_PCT, PRESETS, applyPreset, recoverViaGoogle, resetAdminPassword, publicUser, setGoogleVerifier,
  slimDb, memoryReport, memoryGuard,
  _internals: {
    get db() { return db; }, set db(v) { db = v; },
    hist, market, simPrice, SIM, DERIV_SYMBOLS, DEFAULT_CONFIG, ENGINE, pointValue, contractSize,
    strategyFor, strategyCatalogue, loadStrategyReport, marketContext, chooseSignal, sizeFor, resyncBot, publicUser, liveCap, liveDailyLimit, bestPair, publicBot, canTradeReal, scaledLimits
  }
};
