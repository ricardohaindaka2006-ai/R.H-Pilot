'use strict';
/* =============================================================================
   R.H PILOT — lightweight Node.js backend
   Accounts, server-side paper bots and Deriv market data; new broker orders
   are blocked pending authoritative settlement/recovery. Paper P/L is not
   a Deriv balance. No win rate, profit or preservation of capital is guaranteed.
   ========================================================================== */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('node:util');
const crypto = require('crypto');
const ENGINE = require('./engine/strategies.js');
const PAPER = ENGINE.EXECUTION;
const RISK = require('./engine/risk.js');
const LIVE_SAFETY = Object.freeze({ enabled: false, reason: 'broker-reconciliation-required',
  message: 'New real-money orders are disabled: paper price-based results do not validate five-minute options. Broker-authoritative settlement, exposure and restart reconciliation must be implemented and demo-tested first.' });
function isBrokerPosition(p) { return !!(p && (p.execution === 'live' || p.contractId || p.livePending || p.liveFailed || p.liveAccountId || p.reconciliationRequired)); }
function hasBrokerExposure(user) { return !!(user && user.bot && user.bot.positions.some(isBrokerPosition)); }

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
let storageError = null;
let server = null;
const timers = [];

const DEFAULT_CONFIG = () => ({
  derivAppId: process.env.DERIV_APP_ID || '',
  derivOAuthMode: 'new',
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  mt5BridgeUrl: '',
  appVersion: '1.0.0',
  maintenance: { enabled: false, message: '', version: '1.0.0', notes: '', startedAt: null, by: null },
  engineWeights: { trend: 1, momentum: 1, breakout: 1, reversal: 1 },
  engineStats: { scored: 0, wins: 0, losses: 0, resyncs: 0, lastUpdate: null },
  // Paper auto follows a reference chosen on synthetic training families only.
  engine: {
    defaultStrategy: 'breakout-momentum',
    report: null,        // version-matched synthetic diagnostic shown in the UI
    tuned: {},           // frozen shipped parameters; never selected on test data
    revertHostile: ['breakout-momentum', 'macd-momentum', 'springbok-fusion'],   // fixed conservative gates, not a guaranteed regime classifier
    adaptiveEnabled: false, // learning is diagnostic only; not validated for decisions
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
function normaliseDb(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.users) ||
      (parsed.config !== undefined && (!parsed.config || typeof parsed.config !== 'object' || Array.isArray(parsed.config)))) throw new Error('Invalid database schema.');
  const next = { users: [], sessions: {}, config: DEFAULT_CONFIG(), createdAt: Date.now(), ...parsed };
  next.users = Array.isArray(next.users) ? next.users : [];
  next.sessions = next.sessions && typeof next.sessions === 'object' ? next.sessions : {};
  next.config = merge(DEFAULT_CONFIG(), parsed.config || {});
  // Never silently retain Deriv's retired public sample App ID in production.
  if (process.env.DERIV_APP_ID) next.config.derivAppId = String(process.env.DERIV_APP_ID).trim();
  else if (String(next.config.derivAppId || '') === '1089') next.config.derivAppId = '';
  ['licenses', 'logins', 'mailOutbox', 'calendar', 'news', 'ratings'].forEach(k => {
    if (!Array.isArray(next.config[k])) next.config[k] = [];
  });
  if (typeof next.config.licenseRequired !== 'boolean') next.config.licenseRequired = true;
  // Owner support details power the login screen. Backfill installs that stored blanks.
  if (!next.config.profile.supportEmail || next.config.profile.supportEmail === 'support@rhpilot.com') next.config.profile.supportEmail = 'ricardohaindaka2006@gmail.com';
  if (!next.config.profile.supportPhone) next.config.profile.supportPhone = '081 609 0300';
  if (!next.config.recovery.phone) next.config.recovery.phone = '081 609 0300';
  if (!next.config.recovery.googleEmail) next.config.recovery.googleEmail = OWNER_EMAIL;
  next.config.derivOAuthMode = 'new'; // legacy Deriv OAuth/WebSocket hosts are retired
  next.users.forEach(u => {
    if (u.deriv === undefined) u.deriv = null;
    if (u.paid === undefined) u.paid = true; // grandfather pre-license accounts
    if (u.bot !== undefined && (!u.bot || typeof u.bot !== 'object' || Array.isArray(u.bot))) throw new Error('Invalid persisted bot ledger.');
    for (const key of ['positions', 'trades']) {
      if (u.bot?.[key] !== undefined && !Array.isArray(u.bot[key])) throw new Error('Invalid persisted ' + key + ' ledger.');
    }
    // A fresh defaults object per user prevents cross-account bot state.
    if (u.bot && u.bot.risk !== undefined && !RISK.validState(u.bot.risk)) throw new Error('Invalid persisted risk ledger.');
    const hadRiskLedger = u.bot && u.bot.risk !== undefined;
    const previousModel = u.bot && u.bot.accountingVersion;
    u.bot = merge(defaultBot(), u.bot || {});
    if (!hadRiskLedger) delete u.bot.risk;
    if (previousModel !== PAPER.MODEL_VERSION) u.bot.performanceWarning = 'Legacy paper results used different accounting and are not reliable performance evidence.';
    u.bot.positions = Array.isArray(u.bot.positions) ? u.bot.positions : [];
    u.bot.trades = Array.isArray(u.bot.trades) ? u.bot.trades : [];
    u.bot.milestones = Array.isArray(u.bot.milestones) ? u.bot.milestones : [];
    if (u.bot.live) {
      for (const p of u.bot.positions) { p.execution = 'live'; p.reconciliationRequired = true; }
      u.bot.running = false; u.bot.stoppedReason = LIVE_SAFETY.reason;
    }
    if (u.bot.positions.some(isBrokerPosition)) {
      u.bot.running = false; u.bot.stoppedReason = LIVE_SAFETY.reason;
      for (const p of u.bot.positions) if (isBrokerPosition(p)) p.reconciliationRequired = true;
    }
    u.bot.live = false;
    u.bot.pendingEntry = null; u.bot.lastProcessedTick = null;
    if (typeof u.bot.profitTarget !== 'number') u.bot.profitTarget = 0;
    if (typeof u.bot.peakProfit !== 'number') u.bot.peakProfit = Math.max(0, Number(u.bot.profit) || 0);
    const risk = accountRisk(u.bot);
    if (risk.blocked && risk.reason !== 'loss-streak-cooldown' && !u.bot.positions.some(isBrokerPosition)) {
      u.bot.running = false; u.bot.stoppedReason = risk.reason;
    }
  });
  return next;
}
function loadDb() {
  try {
    if (fs.existsSync(DB_PATH + '.tmp')) throw new Error('Unfinished state write: review db.json and db.json.tmp before restarting.');
    const parsed = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    db = normaliseDb(parsed);
    storageError = null;
  } catch (e) {
    if (e.code === 'ENOENT' && !fs.existsSync(DB_PATH + '.tmp')) { db = defaultDb(); storageError = null; return; }
    db = null; storageError = 'risk-state-unavailable';
    throw new Error('Refusing to reset an unreadable or uncertain risk database: ' + e.message, { cause: e });
  }
}
function saveDb() {
  let fd = null, dirFd = null;
  try {
    if (!db) throw new Error('Database is not loaded.');
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    const tmp = DB_PATH + '.tmp';
    fd = fs.openSync(tmp, 'w', 0o600);
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, JSON.stringify(slimDb()));
    fs.fsyncSync(fd); fs.closeSync(fd); fd = null;
    fs.renameSync(tmp, DB_PATH);
    if (process.platform !== 'win32') {
      dirFd = fs.openSync(DATA_DIR, 'r'); fs.fsyncSync(dirFd); fs.closeSync(dirFd); dirFd = null;
    }
    dbDirty = false; storageError = null;
    return true;
  } catch (e) {
    if (!storageError) console.error('[db] risk-state save failed; entries halted:', e.message);
    storageError = 'risk-state-unavailable'; dbDirty = true;
    for (const u of db?.users || []) {
      if (!u.bot) continue;
      u.bot.running = false; u.bot.pendingEntry = null; u.bot.stoppedReason = storageError;
    }
    return false;
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch (e) { /* original failure retained */ }
    if (dirFd !== null) try { fs.closeSync(dirFd); } catch (e) { /* original failure retained */ }
  }
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
    if (u.bot) keep(u.bot.trades, LOG_CAPS.trades); // exposure records must NEVER be truncated
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

/* Planned stop risk, enforced at sizing. Gaps can exceed it; no guaranteed fills. */
const MAX_TRADE_RISK_PCT = RISK.POLICY.maxTradeRiskPct;
const MAX_OPEN_RISK_PCT = RISK.POLICY.maxOpenRiskPct;

function defaultBot() {
  const bot = {
    accountingVersion: PAPER.MODEL_VERSION,
    pendingEntry: null, lastProcessedTick: null, risk: RISK.newState(),
    ...PAPER.DEFAULT_EXECUTION,
    running: false, symbol: 'XAUUSD', lots: 0.01, tp: 10, sl: 2.5,
    maxTrades: 1, aggression: 3, trailing: true, live: false, liveStake: 1,
    // --- client-controlled risk -------------------------------------------
    // Presets are paper risk budgets, not evidence of profitable strategies.
    // 'safe'      -> smallest planned risk, daily stop, paper reference
    // 'balanced'  -> more trades, slightly more risk
    // 'aggressive'-> the client knows what they are doing and wants more
    // 'custom'    -> they moved something by hand
    preset: 'safe',
    // Profit-lock triggers move the stop; gaps can still turn a gain into a loss.
    lockInProfit: true,
    lockAfterR: 0.5,        // break-even trigger, not a guaranteed fill
    trailAfterR: 1.0,       // trail sooner after a +1R move
    trailByR: 0.35,         // retain more of an orderly move; gaps remain possible
    // 'auto' follows the synthetic training reference; a catalogue id pins one
    strategy: 'auto',
    // autoRisk: size each trade from `riskPerTrade` (% of balance risked to the
    // stop). Fixed lots are still constrained by all planned risk budgets.
    autoRisk: true, compoundProfits: true,
    riskPerTrade: 0.5,           // planned stop risk % (0.1 – 1.5)
    maxLossPerTrade: 0.5,        // optional tighter cap; 0 retains the mandatory $1 / 1.5% rail
    dailyLossLimit: 3,           // optional tighter cash budget; 0 still retains 3% / UTC day
    dayLoss: 0, dayPnl: 0, lossDay: null, dayStartBalance: null, dayLimitLatched: false, lastLossAt: null,
    // --- bookkeeping ------------------------------------------------------
    startBalance: 100, resyncs: 0, lastResyncAt: null,
    closedWins: 0, closedLosses: 0, closedScratches: 0, closedTrades: 0,
    balance: 100, profit: 0, profitTarget: 0, targetHit: null, peakProfit: 0,
    protectProfitFrom: 0,       // 0 = profits uncapped (default)
    milestones: [], positions: [], trades: [], startedAt: null, lastEntryAt: 0
  };
  // New paper bots use the smallest preset risk budget.
  return applyPreset(bot, 'safe');
}
/* --------------------------------------------------------------------------
   Presets.

   Conservative defaults reduce planned exposure, not guarantee safety. These
   presets are the only knobs most people need; every individual field stays
   editable underneath for the clients who want to experiment later.
   -------------------------------------------------------------------------- */
const PRESETS = {
  safe: {
    label: 'Conservative paper',
    copy: 'Smallest planned risk; daily loss stop and break-even/trailing triggers. Fills are not guaranteed.',
    autoRisk: true, compoundProfits: true, trailing: true, riskPct: 0.5, capPct: 0.5, dailyPct: 3,
    lockInProfit: true, lockAfterR: 0.5, trailAfterR: 1.0, trailByR: 0.35,
    maxTrades: 1, aggression: 3, strategy: 'auto'
  },
  balanced: {
    label: 'Balanced',
    copy: 'Slightly larger positions and two open trades. Still protected by a daily stop.',
    autoRisk: true, compoundProfits: true, trailing: true, riskPct: 1, capPct: 1, dailyPct: 3,
    lockInProfit: true, lockAfterR: 0.5, trailAfterR: 1.3, trailByR: 0.4,
    maxTrades: 2, aggression: 5, strategy: 'auto'
  },
  aggressive: {
    label: 'Aggressive',
    copy: 'For when you understand the risk. Bigger positions, bigger swings — the daily stop still applies.',
    autoRisk: true, compoundProfits: true, trailing: true, riskPct: 1.5, capPct: 1.5, dailyPct: 3,
    lockInProfit: true, lockAfterR: 0.6, trailAfterR: 1.6, trailByR: 0.5,
    maxTrades: 3, aggression: 7, strategy: 'auto'
  }
};
/* Exact proportional paper budgets, with no fixed-dollar floor that could
   turn a $2 account's daily stop into a double-digit percentage loss. */
function scaledLimits(preset, balance) {
  const bal = Number(balance);
  const valid = Number.isFinite(bal) && bal > 0;
  const scaled = pct => valid && Number.isFinite(pct) && pct > 0 ? bal * (pct / 100) : 0;
  return { riskPerTrade: preset.riskPct,
    maxLossPerTrade: scaled(preset.capPct), dailyLossLimit: scaled(preset.dailyPct) };
}
function publicRiskPresets() {
  return Object.fromEntries(Object.entries(PRESETS).map(([id, p]) => [id, {
    ...p, riskPerTrade: p.riskPct
  }]));
}
function applyPreset(bot, name, balance) {
  const key = PRESETS[name] ? name : 'safe';
  const p = PRESETS[key];
  if (balance != null) {
    /* The growth anchor is the balance these limits were sized on. Calls that
       pass an explicit balance are (re)sizing for it, so the anchor follows.
       Calls that pass none — a mid-run preset change — leave the anchor alone,
       so a compounding account is not reset to its first-day stake. */
    if (!RISK.seedFreshAccount(bot, balance)) throw new Error('paper-bankroll-already-initialised');
    bot.balance = balance;
    bot.startBalance = balance;
  } else if (!(Number(bot.startBalance) > 0)) {
    bot.startBalance = Number.isFinite(Number(bot.balance)) && Number(bot.balance) > 0 ? Number(bot.balance) : 0;
  }
  for (const f of ['autoRisk', 'compoundProfits', 'trailing', 'lockInProfit', 'lockAfterR', 'trailAfterR', 'trailByR', 'maxTrades', 'aggression', 'strategy']) {
    if (p[f] !== undefined) bot[f] = p[f];
  }
  Object.assign(bot, scaledLimits(p, balance != null ? balance : bot.startBalance));
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
/* Optional PAPER bankroll seed from the exact linked account, never another
   account of the same type. This is not an available-funds check for real orders. */
function detectLinkedBalance(user) {
  const d = user && user.deriv;
  if (!d || !d.loginid) return 0;
  const acct = (Array.isArray(d.accounts) ? d.accounts : []).find(a => a.loginid === d.loginid);
  const n = Number(acct && acct.balance != null ? acct.balance : d.balance);
  return Number.isFinite(n) && n > 0 ? n : 0;
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
  // DERIV_NATIVE_WS=1 is an explicit override: use the platform WebSocket
  // directly (this is also how tests inject a deterministic socket). It must
  // win over the proxy dispatcher, otherwise a proxy-enabled host silently
  // bypasses the overridden transport.
  if (process.env.DERIV_NATIVE_WS === '1') {
    if (typeof WebSocket !== 'function') throw new Error('websocket-unavailable-use-node-22');
    return new WebSocket(url);
  }
  const dispatcher = proxyDispatcher();
  if (dispatcher && undiciMod && undiciMod.WebSocket) {
    try { return new undiciMod.WebSocket(url, { dispatcher }); } catch (e) { /* fall through */ }
  }
  // Node's native Undici WebSocket can receive a non-101 response from Deriv's
  // edge. The `ws` transport provides a stable Node handshake and lets a
  // production deployment declare its real browser origin when required.
  if (wsMod) {
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
      ...(db.config.derivAppId ? { 'Deriv-App-ID': String(db.config.derivAppId) } : {}),
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
  if (preferredAccountId && !active.some(x => x.account_id === preferredAccountId)) throw new Error('deriv-requested-account-unavailable');
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
/* Verify every active account without placing a contract. A one-unit CALL
   proposal is quote-only: it checks account-scoped OTP access and trade
   permission, but never sends a buy request or risks funds. */
async function derivVerifyAccounts(token, symbol = 'VOL10') {
  const key = String(symbol || 'VOL10');
  const underlying = DERIV_SYMBOLS[key];
  if (!underlying) throw new Error('unsupported-verification-symbol');
  const first = await derivFetchAccount(token);
  const accounts = Array.isArray(first.accounts) ? first.accounts : [];
  if (!accounts.length) throw new Error('deriv-no-options-accounts');
  const checks = [];
  for (const listed of accounts) {
    try {
      const acct = await derivFetchAccount(token, listed.loginid);
      const quote = await derivAuthCall({ token: String(token).trim(), loginid: acct.loginid }, {
        proposal: 1, amount: 1, basis: 'stake', contract_type: 'CALL',
        currency: acct.currency || 'USD', duration: 5, duration_unit: 'm',
        underlying_symbol: underlying
      }, 12000);
      const proposal = quote && quote.proposal;
      if (!proposal || !proposal.id) throw new Error('deriv-proposal-not-confirmed');
      checks.push({ loginid: acct.loginid, type: acct.isVirtual ? 'demo' : 'real',
        verified: true, balance: acct.balance, currency: acct.currency || 'USD',
        proposalVerified: true });
    } catch (error) {
      checks.push({ loginid: listed.loginid, type: listed.isVirtual ? 'demo' : 'real',
        verified: false, proposalVerified: false, error: error.message });
    }
  }
  const verifiedTypes = new Set(checks.filter(x => x.verified).map(x => x.type));
  const missingTypes = ['demo', 'real'].filter(type => !verifiedTypes.has(type));
  return { symbol: key, allVerified: checks.length > 0 && checks.every(x => x.verified) && missingTypes.length === 0, missingTypes, accounts: checks };
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
  const appId = encodeURIComponent(db.config.derivAppId || '');
  const e = derivOAuthEndpoints();
  const redirect = encodeURIComponent(derivRedirectUri(req));
  return e.auth + '?response_type=code&client_id=' + appId + '&redirect_uri=' + redirect +
    '&scope=' + encodeURIComponent('trade') + '&state=' + state +
    '&code_challenge=' + encodeURIComponent(challenge) + '&code_challenge_method=S256';
}
async function derivOAuthExchange(code, req, verifier) {
  const e = derivOAuthEndpoints();
  const body = new URLSearchParams({
    grant_type: 'authorization_code', client_id: String(db.config.derivAppId || ''),
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
  // Defence in depth: even direct callers cannot buy real options in this build.
  if (!account || account.isVirtual !== true) throw new Error(LIVE_SAFETY.reason);
  const verified = await derivFetchAccount(account.token, account.loginid);
  if (!verified.isVirtual) throw new Error(LIVE_SAFETY.reason);
  account = { ...account, currency: verified.currency };
  if (!DERIV_SYMBOLS[o.symbol] || !['BUY', 'SELL'].includes(o.direction) || !Number.isFinite(Number(o.stake)) || Number(o.stake) <= 0) throw new Error('invalid-trade');
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
    const before = { running: b.running, day: b.lossDay, daily: b.dayLimitLatched, drawdown: b.risk?.drawdownLatched };
    rollDay(b);
    const riskStatus = enforceAccountRisk(b);
    if (dailyLimitHit(b) && (!riskStatus.blocked || riskStatus.reason === 'loss-streak-cooldown')) {
      b.running = false; b.pendingEntry = null; b.stoppedReason = 'daily-loss-limit';
    }
    if (before.running !== b.running || before.day !== b.lossDay || before.daily !== b.dayLimitLatched || before.drawdown !== b.risk?.drawdownLatched) {
      markDirty(); saveDb();
    }
    const cap = liveCap(b), daily = liveDailyLimit(b), reserved = openRiskCash(b);
    return Object.assign({}, b, {
      execution: 'paper', liveSafety: LIVE_SAFETY, reconciliationRequired: b.positions.some(isBrokerPosition),
      riskStatus, riskPolicy: RISK.POLICY, riskStorageHealthy: !storageError,
      openRiskCash: Number.isFinite(reserved) ? reserved : null,
      liveCap: Number.isFinite(cap) ? +cap.toFixed(8) : 0,
      liveDailyLimit: daily == null ? 0 : +daily.toFixed(8),
      plannedEntryRisk: Number(riskBudgetFor(b).toFixed(8))
    });
  } catch (e) { return { ...b, plannedEntryRisk: 0, riskPolicy: RISK.POLICY, riskStatus: { valid: false, blocked: true, reason: 'invalid-risk-ledger' } }; }
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
/* Market hours. Forex and metals pause for the weekend (Friday 21:00 →
   Sunday 21:00 UTC). Synthetic indices — Volatility and Boom/Crash — keep
   trading right through the weekend, so the desk always has an open market.
   The picker shows clients which markets are open right now. */
const SYMBOL_META = {
  XAUUSD: { label: 'Gold / USD', group: 'fx' }, XAGUSD: { label: 'Silver / USD', group: 'fx' },
  EURUSD: { label: 'Euro / USD', group: 'fx' }, GBPUSD: { label: 'GBP / USD', group: 'fx' },
  USDJPY: { label: 'USD / JPY', group: 'fx' }, USDCAD: { label: 'USD / CAD', group: 'fx' },
  AUDUSD: { label: 'AUD / USD', group: 'fx' }, NZDUSD: { label: 'NZD / USD', group: 'fx' },
  EURGBP: { label: 'Euro / GBP', group: 'fx' },
  VOL10: { label: 'Volatility 10', group: 'volatility' }, VOL25: { label: 'Volatility 25', group: 'volatility' },
  VOL50: { label: 'Volatility 50', group: 'volatility' }, VOL75: { label: 'Volatility 75', group: 'volatility' },
  VOL100: { label: 'Volatility 100', group: 'volatility' },
  CRASH500: { label: 'Crash 500', group: 'boom-crash' }, BOOM1000: { label: 'Boom 1000', group: 'boom-crash' }
};
const MARKET_GROUPS = {
  fx: { label: 'Forex & Metals', note: 'Closed weekends', weekend: false, order: 1 },
  volatility: { label: 'Volatility indices', note: 'Open 24/7', weekend: true, order: 2 },
  'boom-crash': { label: 'Boom & Crash', note: 'Open 24/7', weekend: true, order: 3 }
};
function forexWeekOpen(now) {
  const day = now.getUTCDay();                 // 0 Sun … 6 Sat
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (day === 6) return false;                 // Saturday — shut
  if (day === 5 && mins >= 21 * 60) return false; // Friday after 21:00
  if (day === 0 && mins < 21 * 60) return false;  // Sunday before 21:00
  return true;
}
function marketCatalogue(now = new Date()) {
  const fxOpen = forexWeekOpen(now);
  return Object.keys(DERIV_SYMBOLS).map(id => {
    const meta = SYMBOL_META[id] || { label: id, group: 'fx' };
    const g = MARKET_GROUPS[meta.group] || MARKET_GROUPS.fx;
    const open = g.weekend ? true : fxOpen;
    return { id, label: meta.label, group: meta.group, groupLabel: g.label, groupNote: g.note, weekend: g.weekend, open, status: open ? 'open' : 'closed' };
  });
}
function marketGroups() {
  return Object.keys(MARKET_GROUPS).sort((a, b) => MARKET_GROUPS[a].order - MARKET_GROUPS[b].order)
    .map(id => ({ id, label: MARKET_GROUPS[id].label, note: MARKET_GROUPS[id].note, weekend: MARKET_GROUPS[id].weekend }));
}
const SIM = {
  XAUUSD: { price: 2385.5 }, XAGUSD: { price: 28.44 }, EURUSD: { price: 1.0872 }, GBPUSD: { price: 1.2714 },
  USDJPY: { price: 151.32 }, USDCAD: { price: 1.3585 }, AUDUSD: { price: 0.6598 }, NZDUSD: { price: 0.6012 }, EURGBP: { price: 0.855 },
  VOL10: { price: 6450.12 }, VOL25: { price: 2680.45 }, VOL50: { price: 240.1 }, VOL75: { price: 105320 }, VOL100: { price: 1580.75 },
  CRASH500: { price: 8120.4 }, BOOM1000: { price: 9540.88 }
};
const SIM_TICK_PCT = 0.00025;
/* Springboks hot path: track the newest tick per symbol so the engine reacts on
   every fresh price instead of on a fixed 100 ms sweep. */
const tickSequence = Object.create(null), historySource = Object.create(null);
const contextCache = new Map();
Object.keys(SIM).forEach(k => { SIM[k].vol = SIM[k].price * SIM_TICK_PCT; });
const SYM_BY_DERIV = {};
Object.keys(DERIV_SYMBOLS).forEach(k => { SYM_BY_DERIV[DERIV_SYMBOLS[k]] = k; });
const market = {}, simPrice = {}, simDrift = {}, simState = {}, simTickCounts = {};
let derivWs = null, derivRetries = 0, derivLive = false;
let derivStatus = 'connecting', derivLastError = '', derivLastTickAt = null;
let derivReconnectTimer = null;
let shuttingDown = false;

/* Pre-warm the practice series so a beginner can trade on their very first
   simulation tick instead of waiting ~90 ticks for the indicators to fill.
   The seed is synthetic and used only by the simulator; the first live Deriv
   tick discards it because notePrice resets history when the source changes. */
function seedPracticeHistory(key) {
  const s = SIM[key], count = ENGINE.WARMUP + 10, series = [];
  let price = s.price;
  for (let i = 0; i < count; i++) {
    const noise = (Math.random() - 0.5) * s.vol * 1.1;
    const micro = (Math.random() - 0.5) * price * 0.000025;
    price = Math.max(0.0001, price + noise + micro + price * 0.00011);
    series.push(price);
  }
  hist[key] = series; historySource[key] = 'sim';
  simPrice[key] = price; tickSequence[key] = count; contextCache.delete(key);
  return price;
}
function initMarket() {
  const at = Date.now();
  Object.keys(SIM).forEach((k, i) => {
    simPrice[k] = SIM[k].price; simDrift[k] = 0; hist[k] = []; simTickCounts[k] = 0;
    tickSequence[k] = 0; historySource[k] = 'sim'; contextCache.delete(k);
    simState[k] = { direction: i % 2 === 0 ? 1 : -1, remaining: 120, anchor: SIM[k].price };
    market[k] = { price: SIM[k].price, epoch: Math.floor(at / 1000), at, source: 'sim' };
  });
  // Warm every practice series so the engine is ready the moment a user starts.
  Object.keys(SIM).forEach(k => { market[k].price = seedPracticeHistory(k); });
}
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
      const epoch = Number(msg.tick.epoch);
      if (!key || !Number.isFinite(q) || q <= 0 || !Number.isFinite(epoch) ||
          Date.now() - epoch * 1000 > 8000 || epoch * 1000 - Date.now() > 5000) return;
      const prior = market[key];
      if (prior && prior.source === 'live' && (epoch < prior.epoch || (epoch === prior.epoch && q === prior.price))) return;
      derivLive = true; derivLastTickAt = Date.now(); derivStatus = 'live';
      market[key] = { price: q, epoch: msg.tick.epoch || Math.floor(Date.now() / 1000), at: Date.now(), source: 'live' };
      notePrice(key, q, 'live');
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
  simPrice[key] = Number.isFinite(simPrice[key]) && simPrice[key] > 0 ? simPrice[key] : s.price;
  let state = simState[key];
  if (!state) state = simState[key] = { direction: 1, remaining: 120, anchor: simPrice[key] };
  if (state.remaining <= 0) {
    state.direction *= -1;
    state.remaining = 100 + Math.floor(Math.random() * 61);
    state.anchor = simPrice[key];
  }
  state.remaining--;
  simTickCounts[key] = (simTickCounts[key] || 0) + 1;
  // Practice feed deliberately alternates persistent directional runs. This
  // gives the same signal engine enough trend/range structure to exercise its
  // entry and exit paths instead of leaving users watching near-white-noise.
  const trend = state.direction * 0.00011;
  const noise = (Math.random() - 0.5) * s.vol * 1.1;
  const micro = (Math.random() - 0.5) * simPrice[key] * 0.000025;
  simPrice[key] += noise + micro + simPrice[key] * trend + (state.anchor - simPrice[key]) * 0.000015;
  if (!(simPrice[key] > 0) || !Number.isFinite(simPrice[key])) simPrice[key] = s.price;
  market[key] = { price: simPrice[key], epoch: Math.floor(Date.now() / 1000), at: Date.now(), source: 'sim' };
  notePrice(key, market[key].price, 'sim');
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
  hist[key] = []; simDrift[key] = 0; simTickCounts[key] = 0;
  const s = SIM[key] || { price: 1 };
  simPrice[key] = market[key] && market[key].price ? market[key].price : s.price;
  simState[key] = { direction: 1, remaining: 120, anchor: simPrice[key] };
}
function sourceOf(key) { const m = market[key]; return m && m.source === 'live' && Date.now() - m.at < 8000 ? 'live' : 'sim'; }
function simulationStatus(key, bot) {
  const ticks = (hist[key] || []).length, warmup = ENGINE.WARMUP + 1;
  const ctx = marketContext(key);
  const signal = ctx && bot ? chooseSignal(ctx, bot) : null;
  return { execution: 'simulation', liveSafety: LIVE_SAFETY, marketSource: sourceOf(key),
    price: peekPrice(key), ticks, warmup, warmedUp: ticks >= warmup,
    signalReady: !!signal, strategy: signal ? signal.strategy : null,
    waiting: (bot && bot.waitingReason) ? bot.waitingReason : ticks < warmup ? 'warming-up' : (signal ? 'ready' : 'waiting-for-setup') };
}
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
function contractSize(key, pos) { return Number.isFinite(pos.lots) && pos.lots > 0 ? pos.lots * pointValue(key) : 0; }
const HIST_MAX = 180;
const hist = {};
function notePrice(key, price, source) {
  if (!Number.isFinite(price) || price <= 0) return;
  const mode = source || (market[key] && market[key].source) || 'sim';
  if (historySource[key] && historySource[key] !== mode) hist[key] = [];
  historySource[key] = mode;
  const h = hist[key] || (hist[key] = []);
  // Equal prices on distinct ticks are real information, not duplicates.
  h.push(price); if (h.length > HIST_MAX) h.shift();
  tickSequence[key] = (tickSequence[key] || 0) + 1;
  if (market[key]) market[key].seq = tickSequence[key];
  contextCache.delete(key);
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
  const ctx = marketContext(key);
  if (!ctx) return { score: 0, entry: 0, votes: null };
  const votes = ctx.votes;
  return { score: votes.entry, entry: votes.trend + votes.momentum + votes.breakout, votes };
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
/* Real-money orders fail closed. Legacy broker exposure is kept for manual
   reconciliation, never paper-settled or treated as confirmed closed. */
function canTradeReal(user) {
  return false; // fail closed until broker-authoritative reconciliation exists
}
function placeLive(user, pos) {
  pos.liveSkipped = user.deriv && user.deriv.isVirtual ? 'demo-account' : LIVE_SAFETY.reason;
  if (user.bot.live) {
    user.bot.live = false; user.bot.running = false;
    user.bot.stoppedReason = LIVE_SAFETY.reason; user.bot.pendingEntry = null;
    markDirty();
  }
}
function closeLive(user, pos) {
  // Never turn a local TP/SL into a fictitious broker settlement. Preserve the
  // contract identifier for manual reconciliation in the Deriv statement.
  pos.reconciliationRequired = true;
  user.bot.running = false; user.bot.pendingEntry = null;
  user.bot.stoppedReason = LIVE_SAFETY.reason;
  markDirty();
}
function entryBlockReason(user) {
  if (user.active === false) return 'account-disabled';
  if (isMaintenanceBlocked(user)) return 'maintenance';
  if (user.role !== 'admin' && db.config.licenseRequired) {
    if (user.paid !== true) return 'payment-required';
    if (user.licenseExpiresAt && Date.now() > user.licenseExpiresAt) return 'license-expired';
    if (user.licenseKey) {
      const lic = findLicense(user.licenseKey);
      if (!lic || lic.boundUserId !== user.id || lic.status !== 'active') return 'license-revoked';
    }
  }
  return null;
}
function freshMarketQuote(q, at = Date.now()) {
  return !!q && Number.isFinite(q.price) && q.price > 0 && Number.isFinite(q.at) &&
    q.at <= at && at - q.at <= 8000 && ['sim', 'live'].includes(q.source);
}
function tickIdentity(key) {
  const m = market[key];
  return m ? [m.source, m.seq || 0, m.at, m.price].join(':') : null;
}

function evaluate(user) {
  const bot = user.bot;
  if (!bot || (!bot.running && !bot.positions.length)) return;
  if (bot.live || hasBrokerExposure(user)) {
    bot.live = false; bot.running = false; bot.pendingEntry = null;
    bot.stoppedReason = LIVE_SAFETY.reason;
    for (const p of bot.positions) if (isBrokerPosition(p)) p.reconciliationRequired = true;
    markDirty(); return;
  }
  const blocked = entryBlockReason(user);
  if (blocked) { flattenBot(user, blocked); bot.stoppedReason = blocked; return; }
  const key = bot.symbol, m = market[key], tick = tickIdentity(key);
  if (!m || !Number.isFinite(m.price) || m.price <= 0 || !tick || tick === bot.lastProcessedTick) return;
  // A timer is not a tick. Stale quotes never advance hold periods or entries.
  if (!freshMarketQuote(m)) { bot.waitingReason = 'stale-market'; return; }
  bot.lastProcessedTick = tick; bot.waitingReason = null;
  const price = m.price, age = Date.now();
  rollDay(bot);

  for (let i = bot.positions.length - 1; i >= 0; i--) {
    const pos = bot.positions[i];
    if (!pos) continue;
    if (pos.marketSource && pos.marketSource !== m.source) {
      // Do not invent a gain/loss by bridging a real quote and a practice price.
      closePos(user, i, pos.lastMid || pos.entry, 'market-source-changed');
      bot.pendingEntry = null;
      continue;
    }
    if (!pos.strategy) {
      const cash = (price - pos.entry) * (pos.dir === 'BUY' ? 1 : -1) * contractSize(key, pos);
      pos.peak = Math.max(pos.peak || 0, cash); pos.ticks = (pos.ticks || 0) + 1;
      if (cash >= Math.abs(bot.tp)) closePos(user, i, price, 'take-profit');
      else if (cash <= -Math.abs(bot.sl)) closePos(user, i, price, 'stop-loss');
      continue;
    }
    // Legacy PAPER positions retain their own strategy geometry, not whichever
    // strategy the client selects next. New positions snapshot all exit rules.
    if (!Number.isFinite(pos.tpPrice) || !Number.isFinite(pos.slPrice) || !(pos.slDist > 0) || !(pos.tpDist > 0)) {
      const params = ENGINE.paramsFor(pos.strategy);
      if (!params || !(pos.atr > 0)) continue;
      const dir = pos.dir === 'BUY' ? 1 : -1;
      const fallback = ENGINE.levelsFor(dir, pos.entry, pos.atr, { exit: params });
      // Missing distances must not overwrite an existing target or loosen a
      // break-even/trailing stop saved by an earlier release.
      if (!(pos.slDist > 0)) {
        const originalStop = (pos.entry - pos.slPrice) * dir;
        pos.slDist = Number.isFinite(originalStop) && originalStop > 0 ? originalStop : fallback.slDist;
      }
      if (!(pos.tpDist > 0)) {
        const originalTarget = (pos.tpPrice - pos.entry) * dir;
        pos.tpDist = Number.isFinite(originalTarget) && originalTarget > 0 ? originalTarget : fallback.tpDist;
      }
      if (!Number.isFinite(pos.tpPrice)) pos.tpPrice = fallback.tpPrice;
      if (!Number.isFinite(pos.slPrice)) pos.slPrice = fallback.slPrice;
      pos.holdTicks = pos.holdTicks || params.hold;
      if (!Number.isFinite(pos.beFraction)) pos.beFraction = params.be;
    }
    if (!pos.holdTicks) pos.holdTicks = (ENGINE.paramsFor(pos.strategy) || {}).hold || 420;
    const outcome = PAPER.advancePosition(pos, price);
    if (outcome) closePos(user, i, price, outcome.cause);
  }
  checkProfitGuard(user);
  const account = enforceAccountRisk(bot);
  if (account.blocked && account.reason !== 'loss-streak-cooldown') {
    if (account.reason === 'account-drawdown-limit') flattenBot(user, account.reason);
    bot.pendingEntry = null; markDirty(); saveDb(); return;
  }
  if (!bot.running || bot.targetHit) { bot.pendingEntry = null; markDirty(); return; }
  if (!(Number.isFinite(bot.balance) && bot.balance > 0)) {
    bot.running = false; bot.pendingEntry = null; bot.stoppedReason = 'insufficient-paper-equity'; markDirty(); return;
  }
  if (dailyLimitHit(bot)) {
    bot.running = false; bot.pendingEntry = null; bot.stoppedReason = 'daily-loss-limit'; markDirty(); saveDb(); return;
  }
  if (account.reason === 'loss-streak-cooldown') {
    bot.pendingEntry = null; bot.waitingReason = account.reason; markDirty(); return;
  }
  if (storageError) { bot.running = false; bot.pendingEntry = null; bot.stoppedReason = storageError; return; }
  db.config.engineStats.scored++;
  const minGap = Math.max(300, 1400 - bot.aggression * 120);
  if (age - (bot.lastEntryAt || 0) < minGap || bot.positions.length >= bot.maxTrades) {
    bot.pendingEntry = null; markDirty(); return;
  }

  // Execute a signal only on a SUBSEQUENT market tick. No same-quote hindsight
  // fills. A stale signal or source change is discarded rather than replayed.
  const pending = bot.pendingEntry;
  bot.pendingEntry = null;
  if (pending && pending.source === m.source && age - pending.at <= 8000) {
    const sig = pending.signal;
    if (!bot.positions.some(p => p.dir !== (sig.dir === 1 ? 'BUY' : 'SELL'))) {
      const paper = PAPER.paperPosition(sig, price, bot);
      const lots = sizeFor(user, bot, paper.entry, sig.atr, paper.slDist);
      if (lots > 0) {
        bot.positions.push({ ...paper, id: crypto.randomUUID(), lots, at: age,
          strategy: sig.strategy, confidence: sig.confidence, marketSource: m.source,
          score: pending.score, votes: pending.votes,
          plannedRiskCash: lots * pointValue(key) * paper.slDist });
        bot.lastEntryAt = age;
        // New paper exposure is not accepted unless its risk snapshot is durable.
        if (!saveDb()) bot.positions.pop();
      } else bot.waitingReason = 'risk-budget-below-minimum-paper-size';
    }
    markDirty(); return;
  }
  const ctx = marketContext(key), sig = chooseSignal(ctx, bot);
  if (sig && !bot.positions.some(p => p.dir !== (sig.dir === 1 ? 'BUY' : 'SELL'))) {
    bot.pendingEntry = { signal: sig, source: m.source, at: age,
      score: ctx.votes.entry, votes: ctx.votes };
  }
  markDirty();
}

function closePos(user, index, price, cause) {
  const bot = user.bot, pos = bot.positions[index];
  if (!pos) return null;
  if (isBrokerPosition(pos)) { closeLive(user, pos); return null; }
  if (!Number.isFinite(price) || price <= 0) return null;
  const quote = market[bot.symbol];
  const staleMark = !!(pos.marketSource && (!freshMarketQuote(quote) || pos.marketSource !== quote.source));
  if (staleMark) price = pos.lastMid || pos.entry;
  const fill = PAPER.exitPrice(pos, price);
  const pnl = (fill - pos.entry) * (pos.dir === 'BUY' ? 1 : -1) * contractSize(bot.symbol, pos);
  if (!Number.isFinite(pnl) || !Number.isFinite(pos.entry) || pos.entry <= 0 ||
      !(contractSize(bot.symbol, pos) > 0) || !['BUY', 'SELL'].includes(pos.dir)) {
    bot.running = false; bot.pendingEntry = null; bot.stoppedReason = 'invalid-paper-position'; markDirty(); saveDb(); return null;
  }
  accountRisk(bot); // establish the pre-loss cash watermark on legacy stores
  bot.positions.splice(index, 1);
  rollDay(bot);

  // Risk limits constrain size BEFORE entry; never rewrite a realised loss.
  bot.balance += pnl; bot.profit += pnl;
  bot.trades.unshift({ symbol: bot.symbol, dir: pos.dir, lots: pos.lots, entry: pos.entry, exit: fill, pnl, cause, execution: 'paper', modelVersion: pos.executionModel || 'legacy-paper', staleMark, riskOverrun: pos.plannedRiskCash != null && pnl < -pos.plannedRiskCash - 1e-9, at: Date.now(), score: pos.score, strategy: pos.strategy || null, confidence: pos.confidence || null });
  if (bot.trades.length > 200) bot.trades.pop();
  // Cumulative tallies outlive the 200-row display log, so the win rate in the
  // UI is the session's real win rate and not the last 200 trades.
  bot.closedTrades = (bot.closedTrades || 0) + 1;
  if (pnl > 1e-9) bot.closedWins = (bot.closedWins || 0) + 1;
  else if (pnl < -1e-9) bot.closedLosses = (bot.closedLosses || 0) + 1;
  else bot.closedScratches = (bot.closedScratches || 0) + 1;
  noteDayLoss(bot, pnl);
  RISK.recordOutcome(bot, pnl);
  const byStrat = (db.config.engineStats.byStrategy = db.config.engineStats.byStrategy || {});
  if (pos.strategy) {
    const rec = byStrat[pos.strategy] || (byStrat[pos.strategy] = { wins: 0, losses: 0, scratches: 0, pnl: 0 });
    if (pnl > 1e-9) rec.wins++; else if (pnl < -1e-9) rec.losses++; else rec.scratches = (rec.scratches || 0) + 1;
    rec.pnl += pnl;
  }
  if (Math.abs(pnl) > 1e-9) learnFrom(pos.votes, pnl > 0, pos.dir === 'BUY' ? 1 : -1);
  checkProfitGuard(user); enforceAccountRisk(bot); markDirty(); saveDb();
  return pnl;
}
function flattenBot(user, cause) {
  const b = user && user.bot;
  if (!b) return;
  b.running = false;
  b.pendingEntry = null;
  const price = peekPrice(b.symbol);
  for (let i = b.positions.length - 1; i >= 0; i--) closePos(user, i, price, cause || 'stopped');
  b.stoppedAt = Date.now();
  markDirty(); saveDb();
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

/** Resolve a paper strategy with frozen, version-matched research parameters. */
function strategyFor(bot) {
  const cfg = db.config.engine || {};
  const wanted = bot && bot.strategy && bot.strategy !== 'auto' ? bot.strategy : cfg.defaultStrategy;
  const id = ENGINE.STRATEGIES[wanted] ? wanted : ENGINE.STRATEGY_IDS[0];
  return { id, params: ENGINE.paramsFor(id, cfg.tuned && cfg.tuned[id]) };
}

/** Legacy score helper retained for diagnostics only. The public catalogue
 * labels ALL strategies research-only, never profitable/live-ready by grade. */
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
      regimes: def.regimes, exit: ENGINE.paramsFor(id, cfg.tuned[id]),
      evidence: 'synthetic-only', liveEligible: false,
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
      grade: 'experimental' // no synthetic grade implies real-money suitability
    };
  }).sort((a, b) => (b.winRate || 0) - (a.winRate || 0));
}

/** Only load evidence matching this code; the reference is training-selected. */
function loadStrategyReport(overrideFile) {
  const cfg = db.config.engine;
  // Never retain previously trusted numbers or tuning after a failed reload.
  cfg.report = null; cfg.tuned = {}; cfg.adaptiveEnabled = false;
  cfg.defaultStrategy = ENGINE.STRATEGY_IDS[0];
  const files = overrideFile ? [overrideFile] : [path.join(DATA_DIR, 'strategy-stats.json'), path.join(ROOT, 'engine', 'strategy-report.json')];
  for (const file of files) {
    try {
      if (!fs.existsSync(file)) continue;
      const report = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (report.schemaVersion !== 2 || report.syntheticOnly !== true || report.liveEligible !== false ||
          report.modelFingerprint !== ENGINE.modelFingerprint() || !Array.isArray(report.strategies)) continue;
      const seen = new Set();
      for (const row of report.strategies) {
        if (!ENGINE.STRATEGIES[row.strategy] || seen.has(row.strategy) ||
            JSON.stringify(row.params) !== JSON.stringify(ENGINE.paramsFor(row.strategy))) throw new Error('invalid-report-parameters');
        seen.add(row.strategy);
      }
      if (seen.size !== ENGINE.STRATEGY_IDS.length || !seen.has(report.trainingLeader)) continue;
      cfg.report = report;
      // The frozen training leader is used for PAPER auto mode. Test results
      // are diagnostics only: never use them to select parameters or a default.
      cfg.defaultStrategy = report.trainingLeader;
      for (const row of report.strategies) cfg.tuned[row.strategy] = row.params;
      console.log('[engine] synthetic paper report loaded; reference = ' + cfg.defaultStrategy + '; live orders disabled');
      return true;
    } catch (e) { console.error('[engine:report]', e.message); }
  }
  return false;
}

/** Shared market context for a symbol, or null while the feed warms up. */
function marketContext(key) {
  const series = hist[key];
  if (!Array.isArray(series) || series.length < ENGINE.WARMUP + 1) return null;
  const tick = tickIdentity(key), cached = contextCache.get(key);
  if (cached && cached.tick === tick && cached.series === series) return cached.ctx;
  // Global online learning from other users' practice results is NOT evidence
  // of an edge, and must not silently change the validated fixed-weight model.
  const ctx = ENGINE.buildContext(series, series.length - 1);
  contextCache.set(key, { tick, series, ctx });
  return ctx;
}

/* Conservative regime exclusions are identical for pinned/auto paper paths.
   Regime labels are heuristics, not proof that a synthetic family fits a market. */
function signalAllowed(regimeKey, strategyId, revertHostile) {
  if (regimeKey !== 'range' && regimeKey !== 'mixed') return true;
  return !(Array.isArray(revertHostile) && revertHostile.includes(strategyId));
}

function chooseSignal(ctx, bot) {
  if (!ctx) return null;
  const sel = strategyFor(bot);
  const hostile = db.config.engine.revertHostile;
  // Pinned and auto modes share the same regime restrictions. Auto follows
  // one frozen paper reference; incomparable confidence scores are not used
  // to invent an untested mixture of strategies.
  if (!signalAllowed(ctx.regime.key, sel.id, hostile)) return null;
  const sig = ENGINE.signalFor(ctx, sel.id, sel.params);
  const floor = db.config.engine.minConfidence;
  return sig && (floor == null || sig.confidence >= floor) ? sig : null;
}

/** Same-source adverse paper marks. Unrealised gains never fund new risk. */
function conservativeEquity(bot) {
  if (!Number.isFinite(bot.balance)) return NaN;
  let equity = bot.balance;
  for (const p of bot.positions || []) {
    if (isBrokerPosition(p)) return NaN;
    const q = market[bot.symbol];
    const mid = freshMarketQuote(q) &&
      (!p.marketSource || p.marketSource === q.source) ? q.price : p.lastMid;
    const units = contractSize(bot.symbol, p);
    if (!(Number.isFinite(mid) && mid > 0 && Number.isFinite(p.entry) && p.entry > 0 && units > 0) ||
        !['BUY', 'SELL'].includes(p.dir)) return NaN;
    const pnl = (PAPER.exitPrice(p, mid) - p.entry) * (p.dir === 'BUY' ? 1 : -1) * units;
    if (!Number.isFinite(pnl)) return NaN;
    equity += Math.min(0, pnl);
  }
  return equity;
}
function validDayKey(key) {
  if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  const date = new Date(key + 'T00:00:00.000Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === key;
}
function validDailyLedger(bot) {
  const day = DAILY_LOSS_KEY();
  return ((bot.lossDay === null || bot.lossDay === undefined) || (validDayKey(bot.lossDay) && bot.lossDay <= day)) &&
    Number.isFinite(bot.dayPnl) && Number.isFinite(bot.dayLoss) &&
    (bot.lossDay !== day || (Number.isFinite(bot.dayStartBalance) && bot.dayStartBalance > 0));
}
function accountRisk(bot) {
  const risk = RISK.inspect(bot, conservativeEquity(bot));
  return !risk.blocked && !validDailyLedger(bot)
    ? { ...risk, valid: false, blocked: true, reason: 'invalid-daily-ledger', headroom: 0 } : risk;
}
function enforceAccountRisk(bot) {
  const status = accountRisk(bot);
  if (status.blocked && status.reason !== 'loss-streak-cooldown') {
    bot.running = false; bot.pendingEntry = null;
    bot.stoppedReason = (bot.positions || []).some(isBrokerPosition) ? LIVE_SAFETY.reason : status.reason;
  }
  return status;
}
function riskStartError(res, bot) {
  if (storageError && !saveDb()) { riskStorageFailure(res); return true; }
  const risk = enforceAccountRisk(bot);
  if (risk.blocked) {
    sendJson(res, 409, { error: risk.reason, riskStatus: risk,
      message: risk.reason === 'loss-streak-cooldown' ? 'Loss-streak pause is still active; restarting does not clear it.' : 'Account risk guard is latched or the paper ledger needs review. Presets and resync cannot reset it.' });
    return true;
  }
  return false;
}
function riskStorageFailure(res) {
  return sendJson(res, 503, { error: 'risk-state-unavailable', message: 'Risk state could not be saved; entries are halted. Review storage and manually restart only after recovery.' });
}

/** Planned-risk sizing with per-trade, aggregate and daily reservations. */
function openRiskCash(bot) {
  let total = 0;
  for (const p of bot.positions || []) {
    if (isBrokerPosition(p) || !(contractSize(bot.symbol, p) > 0)) return Infinity;
    const distance = Number.isFinite(p.slDist) && p.slDist > 0 ? p.slDist
      : p.slPrice != null ? Math.abs(p.entry - p.slPrice) : Math.abs(Number(bot.sl)) / contractSize(bot.symbol, p);
    if (!(Number.isFinite(distance) && distance > 0)) return Infinity;
    total += distance * contractSize(bot.symbol, p);
  }
  return total;
}
function riskBudgetFor(bot) {
  const bal = Number(bot.balance), pct = Number(bot.riskPerTrade);
  if (!Number.isFinite(bal) || bal <= 0 || !Number.isFinite(pct) || pct <= 0) return 0;
  const risk = accountRisk(bot);
  if (storageError || risk.blocked) return 0;
  const start = Number(bot.startBalance);
  const base = bot.compoundProfits === false && Number.isFinite(start) && start > 0 ? Math.min(bal, start) : bal;
  let budget = Math.min(base * Math.min(pct, MAX_TRADE_RISK_PCT) / 100, liveCap(bot));
  const reserved = openRiskCash(bot);
  budget = Math.min(budget, Math.max(0, Math.min(bal * MAX_OPEN_RISK_PCT / 100, RISK.POLICY.maxOpenRiskUsd) - reserved),
    Math.max(0, risk.headroom - reserved));
  const daily = dailyLossBudget(bot);
  if (daily != null) budget = Math.min(budget, Math.max(0, daily - reserved));
  return Number.isFinite(budget) && budget > 0 ? budget : 0;
}
function sizeFor(user, bot, price, atr, slDist) {
  const bal = Number(bot.balance), distance = Number(slDist);
  if (!Number.isFinite(bal) || bal <= 0 || !Number.isFinite(price) || price <= 0 ||
      !Number.isFinite(distance) || distance <= 0) return 0;
  rollDay(bot);
  if (dailyLimitHit(bot)) return 0;
  const budget = riskBudgetFor(bot), units = pointValue(bot.symbol), lossPerLot = distance * units;
  if (!(budget > 0 && Number.isFinite(lossPerLot) && lossPerLot > 0)) return 0;
  const wanted = bot.autoRisk ? budget / lossPerLot : Number(bot.lots);
  if (!Number.isFinite(wanted) || wanted <= 0) return 0;
  const allowed = Math.min(wanted, budget / lossPerLot, 50);
  // PAPER precision only, not a broker's lot/stake rule. Fractional clips keep
  // a $2 budget proportional on high-price instruments, without rounding up.
  const standardStep = bal < 25 ? 0.00005 : bal < 500 ? 0.00025 : 0.001;
  const step = Math.max(1e-8, Math.min(standardStep, 10 ** Math.floor(Math.log10(allowed / 100))));
  // Binary floating point can leave `allowed / step` a hair below an integer
  // (0.005 / 0.00001 = 499.99999999999994), which would silently drop a whole
  // affordable step and hand the unspent residual to an extra micro-trade.
  // Nudge by a relative epsilon, then verify the exact guards below.
  const stepCount = Math.floor(allowed / step * (1 + 1e-12) + 1e-12);
  let lots = Number((stepCount * step).toFixed(8));
  // Multiplication order can differ by one floating-point ULP between the
  // reservation and P/L paths. Round down for the most conservative ordering.
  const cashRisk = n => Math.max(n * lossPerLot, n * distance * units, n * units * distance);
  if (cashRisk(lots) > budget || lots > allowed) lots = Number((lots - step).toFixed(8));
  return Number.isFinite(lots) && lots > 0 && lots <= allowed && cashRisk(lots) <= budget ? lots : 0;
}

/* UTC-day NET realised loss, anchored to day-start equity. Lifetime profit
 * never disables today's stop. Once breached it stays latched until a new UTC
 * day; restarting, changing presets and resyncing do not erase the risk ledger.
 * Pending/open positions reserve their original planned stop risk.
 * Gaps may exceed these planned budgets: stops cannot guarantee a fill.
 */
const DAILY_LOSS_KEY = at => new Date(at == null ? Date.now() : at).toISOString().slice(0, 10);
function rollDay(bot, at, openingBalance) {
  const day = DAILY_LOSS_KEY(at);
  if (bot.lossDay !== null && bot.lossDay !== undefined &&
      (!validDayKey(bot.lossDay) || bot.lossDay > day)) {
    bot.running = false; bot.pendingEntry = null; bot.stoppedReason = 'invalid-daily-ledger'; return false;
  }
  if (bot.lossDay !== day) {
    bot.lossDay = day; bot.dayLoss = 0; bot.dayPnl = 0;
    bot.dayStartBalance = Number.isFinite(openingBalance) ? openingBalance : Number(bot.balance);
    bot.dayLimitLatched = false; bot.limitHitNoted = false;
  }
}
function capCeiling(bot) {
  const bal = Number(bot.balance);
  return Number.isFinite(bal) && bal > 0 ? bal * 0.2 : 0;
}
function liveCap(bot) {
  const bal = Number(bot.balance), raw = Number(bot.maxLossPerTrade);
  if (!Number.isFinite(bal) || bal <= 0 || !Number.isFinite(raw) || raw < 0) return 0;
  const hard = Math.min(RISK.POLICY.maxTradeRiskUsd, bal * MAX_TRADE_RISK_PCT / 100);
  if (raw === 0) return hard;
  const start = Number(bot.startBalance);
  if (!Number.isFinite(start) || start <= 0) return 0;
  const scale = bot.compoundProfits === false ? Math.min(1, bal / start) : bal / start;
  return Math.min(raw * scale, hard);
}
function liveDailyLimit(bot) {
  const limit = Number(bot.dailyLossLimit), start = Number(bot.startBalance);
  if (!Number.isFinite(limit) || limit < 0 || !Number.isFinite(start) || start <= 0) return 0;
  const anchor = bot.lossDay === DAILY_LOSS_KEY() && Number.isFinite(bot.dayStartBalance) && bot.dayStartBalance > 0
    ? bot.dayStartBalance : Number(bot.balance);
  if (!(Number.isFinite(anchor) && anchor > 0)) return 0;
  const hard = anchor * RISK.POLICY.maxDailyLossPct / 100;
  return limit === 0 ? hard : Math.min(hard, limit * anchor / start);
}
function dailyLossBudget(bot) {
  if (!validDailyLedger(bot)) return 0;
  if (bot.lossDay === DAILY_LOSS_KEY() && bot.dayLimitLatched) return 0;
  const limit = liveDailyLimit(bot);
  if (limit == null) return null;
  if (bot.lossDay !== DAILY_LOSS_KEY()) return limit;
  // Old stores used only dayLoss; preserve its drawdown on migration.
  const net = Number(bot.dayPnl) || Number(bot.dayLoss) || 0;
  return Math.max(0, limit + net);
}
function noteDayLoss(bot, pnl, at) {
  rollDay(bot, at, bot.balance - pnl);
  const old = Number(bot.dayPnl) || Number(bot.dayLoss) || 0;
  bot.dayPnl = old + pnl;
  bot.dayLoss = Math.min(0, bot.dayPnl);
  if (pnl < 0) bot.lastLossAt = at || Date.now();
  const budget = dailyLossBudget(bot);
  if (budget != null && budget <= 1e-9) bot.dayLimitLatched = true;
}
function dailyLimitHit(bot) {
  const left = dailyLossBudget(bot);
  const hit = left != null && left <= 1e-9;
  if (hit && bot.lossDay === DAILY_LOSS_KEY()) bot.dayLimitLatched = true;
  return hit;
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
  if (hasBrokerExposure(user)) {
    bot.running = false; bot.pendingEntry = null; bot.stoppedReason = LIVE_SAFETY.reason;
    return { at: t0, closed: [], repaired: [], reconciliationRequired: true, advice: LIVE_SAFETY.message };
  }
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
    if (isBrokerPosition(pos)) { closeLive(user, pos); continue; }
    const pnl = closePos(user, i, price, 'resync');
    report.closed.push({ dir: pos.dir, ticks, ageMs, pnl });
  }

  // 2. drop stale / frozen ticks so ATR cannot stay skewed
  const series = Array.isArray(hist[key]) ? hist[key] : [];
  const fresh = [];
  let last = null, dropped = 0;
  for (const v of series) {
    if (!Number.isFinite(v) || v <= 0) { dropped++; continue; }
    fresh.push(v); last = v;
  }
  const keep = o.mode === 'hard' ? 140 : 400;
  if (fresh.length > keep) { dropped += fresh.length - keep; fresh.splice(0, fresh.length - keep); }
  hist[key] = fresh;
  report.ticksDropped = dropped;

  // 3. re-anchor the books
  const start = Number(bot.startBalance), profit = Number(bot.profit);
  if (!Number.isFinite(start) || start <= 0 || !Number.isFinite(profit)) {
    bot.running = false; bot.pendingEntry = null; bot.stoppedReason = 'invalid-paper-equity';
    report.advice = 'Invalid paper ledger: resync cannot invent a bankroll. Review the stored starting balance and profit.';
    return report;
  }
  const expected = start + profit;
  if (Math.abs((bot.balance || 0) - expected) > 0.005) {
    report.repaired.push({ field: 'balance', drift: Number(((bot.balance || 0) - expected).toFixed(4)) });
    bot.balance = expected;
  }


  // 4. discard queued entries; never clear cooldowns or account/day latches
  bot.pendingEntry = null; // never replay a pre-resync signal
  // Keep the entry cooldown and daily-stop latch intact.

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
  enforceAccountRisk(bot);
  markDirty(); saveDb();
  return report;
}

/* --------------------------------------------------------------- backups */
function snapshot() { return { app: 'R.H PILOT', taken: Date.now(), version: db.config.appVersion, data: db }; }
function hubMeta() { const h = db.config.hub; return { url: h.url, autoBackup: h.autoBackup, hasToken: !!h.token, lastBackupAt: h.lastBackupAt, lastPushAt: h.lastPushAt, lastPushError: h.lastPushError }; }
function writeBackup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
  const id = 'backup-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json', file = path.join(BACKUP_DIR, id);
  fs.writeFileSync(file, JSON.stringify(snapshot()), { mode: 0o600 });
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
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.woff': 'font/woff', '.woff2': 'font/woff2', '.map': 'application/json; charset=utf-8' };
function invalidBotInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body';
  const minima = { lots: 1e-8, riskPerTrade: 0.1, tp: 0.01, sl: 0.01 };
  const positive = new Set(['lots', 'riskPerTrade', 'lockAfterR', 'trailAfterR', 'trailByR', 'maxTrades', 'aggression', 'tp', 'sl', 'startBalance']);
  for (const key of [...positive, 'maxLossPerTrade', 'dailyLossLimit', 'profitTarget']) {
    if (body[key] === undefined) continue;
    const raw = body[key], value = Number(raw);
    if ((minima[key] !== undefined && value < minima[key]) || (['maxTrades', 'aggression'].includes(key) && !Number.isInteger(value))) return key;
    if (raw === null || (typeof raw === 'string' && raw.trim() === '') || !['number', 'string'].includes(typeof raw) || !Number.isFinite(value) || value < 0 || (positive.has(key) && value === 0)) return key;
  }
  for (const key of ['autoRisk', 'compoundProfits', 'lockInProfit', 'trailing']) {
    if (body[key] !== undefined && typeof body[key] !== 'boolean') return key;
  }
  return null;
}
// Validate the whole exit block before mutating state. These settings apply
// to NEW positions only; an existing position keeps its entry-time snapshot.
function protectionSettings(bot, body) {
  const base = PRESETS[body.preset] || bot;
  const limits = { lockAfterR: [0.1, 1], trailAfterR: [0.2, 3], trailByR: [0.1, 2] };
  const out = {};
  for (const [key, [min, max]] of Object.entries(limits)) {
    const v = Number(body[key] === undefined ? base[key] : body[key]);
    if (!Number.isFinite(v) || v < min || v > max) return null;
    out[key] = v;
  }
  return out.trailAfterR > out.lockAfterR ? out : null;
}
function brokerExposureError(res) {
  return sendJson(res, 409, { error: 'broker-reconciliation-required', message: 'Existing broker exposure is preserved, not settled by the paper engine. Check and reconcile these contracts in your Deriv statement before replacing accounts or paper state.' });
}
async function api(req, res, url, body) {
  const p = url.pathname, method = req.method;
  if (['POST', 'PUT', 'PATCH'].includes(method) && (!body || typeof body !== 'object' || Array.isArray(body))) return sendJson(res, 400, { error: 'invalid-json-body' });
  if (['/api/bot/start', '/api/bot/settings'].includes(p) && method === 'POST') {
    const invalid = invalidBotInput(body);
    if (invalid) return sendJson(res, 400, { error: 'invalid-risk-input', field: invalid });
  }
  if (p === '/api/health' && method === 'GET') {
    return sendJson(res, storageError ? 503 : 200, {
      ok: !storageError, riskStorageHealthy: !storageError, version: db.config.appVersion, uptime: Math.floor(process.uptime()),
      maintenance: !!db.config.maintenance.enabled, licenseRequired: !!db.config.licenseRequired,
      memory: memoryReport(),
      deriv: { status: derivStatus, live: derivLive, lastTickAt: derivLastTickAt, lastError: derivLastError },
      engine: { symbols: Object.keys(DERIV_SYMBOLS).length, runningBots: db.users.filter(u => u.bot.running).length, defaultStrategy: db.config.engine.defaultStrategy, executionModel: PAPER.MODEL_VERSION, liveSafety: LIVE_SAFETY, reportValid: !!db.config.engine.report }
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
      support: { phone: db.config.profile.supportPhone || '081 609 0300', email: db.config.profile.supportEmail || 'ricardohaindaka2006@gmail.com', assistantPhone: db.config.profile.assistantPhone || '', website: db.config.profile.website || 'https://rhpilot.com' },
      maintenance: visible, plans: db.config.plans, licenseRequired: !!db.config.licenseRequired,
      liveSafety: LIVE_SAFETY,
      engine: {
        evidence: 'synthetic-only', adaptiveEnabled: false,
        riskPolicy: RISK.POLICY, riskPresets: publicRiskPresets(), maxTradeRiskPct: MAX_TRADE_RISK_PCT, maxOpenRiskPct: MAX_OPEN_RISK_PCT,
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
        if (hasBrokerExposure(linkTarget)) return redirect(res, '/?deriv=reconciliation-required');
        linkTarget.bot.live = false;
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
      if (hasBrokerExposure(du)) return redirect(res, '/?deriv=reconciliation-required');
      du.bot.live = false;
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

  if (p === '/api/bot/state' && method === 'GET') return sendJson(res, 200, { bot: publicBot(user.bot), price: peekPrice(user.bot.symbol), source: sourceOf(user.bot.symbol), signal: signalScore(user.bot.symbol), simulation: simulationStatus(user.bot.symbol, user.bot) });
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
    if (hasBrokerExposure(user)) return brokerExposureError(res);
    const protection = protectionSettings(b, body);
    if (!protection) return sendJson(res, 400, { error: 'invalid-profit-protection', message: 'Trail start must be above break-even activation, and all R values must be in range.' });
    if (typeof body.strategy === 'string' && body.strategy !== 'auto' && !ENGINE.STRATEGIES[body.strategy.trim()]) return sendJson(res, 400, { error: 'unknown-strategy' });
    if (riskStartError(res, b)) return;
    rollDay(b);
    if (dailyLimitHit(b)) {
      b.running = false; b.pendingEntry = null; b.stoppedReason = 'daily-loss-limit'; markDirty();
      if (!saveDb()) return riskStorageFailure(res);
      return sendJson(res, 409, { error: 'daily-loss-limit', message: 'The daily stop remains latched until the next UTC day. Restarting does not reset it.' });
    }
    if (b.positions.length) flattenBot(user, 'restart');
    if (riskStartError(res, b)) return;
    // A restart can realise the last loss that exhausts the day's budget.
    if (dailyLimitHit(b)) return sendJson(res, 409, { error: 'daily-loss-limit' });
    b.live = false;
    b.symbol = DERIV_SYMBOLS[body.symbol] ? body.symbol : b.symbol;
    const fresh = !b.startedAt && !b.closedTrades && b.profit === 0;
    if (fresh) {
      const balance = Number(body.startBalance) || detectLinkedBalance(user) || b.balance;
      if (!(Number.isFinite(balance) && balance > 0)) return sendJson(res, 400, { error: 'invalid-paper-equity' });
      if (!RISK.seedFreshAccount(b, balance)) return sendJson(res, 409, { error: 'paper-bankroll-already-initialised' });
      b.balance = balance; b.startBalance = balance;
      // Initialise the day only once; never erase a pre-existing daily ledger.
      if (!b.dayPnl && !b.dayLoss && !b.dayLimitLatched) b.dayStartBalance = balance;
    }
    const preset = body.preset === 'custom' ? null : PRESETS[body.preset] ? body.preset : PRESETS[b.preset] ? b.preset : null;
    if (body.preset === 'custom') b.preset = 'custom';
    if (preset) applyPreset(b, preset);
    b.lots = Math.min(50, Math.max(1e-8, Number(body.lots) || b.lots || 0.01));
    b.tp = Math.min(1000000, Math.max(0.01, Math.abs(Number(body.tp) || 10)));
    b.sl = Math.min(1000000, Math.max(0.01, Math.abs(Number(body.sl) || 2.5)));
    b.maxTrades = Math.min(10, Math.max(1, parseInt(body.maxTrades, 10) || b.maxTrades || 1));
    b.aggression = Math.min(10, Math.max(1, parseInt(body.aggression, 10) || b.aggression || 4));
    if (!Number.isFinite(b.startBalance)) b.startBalance = Number(b.balance) || 100;
    // strategy + risk controls chosen by the client
    if (typeof body.strategy === 'string') {
      const wanted = body.strategy.trim();
      if (wanted === 'auto' || ENGINE.STRATEGIES[wanted]) b.strategy = wanted;
    }
    if (body.autoRisk !== undefined) b.autoRisk = !!body.autoRisk;
    if (body.compoundProfits !== undefined) b.compoundProfits = body.compoundProfits;
    Object.assign(b, protection);
    if (body.riskPerTrade !== undefined) b.riskPerTrade = Math.max(0.1, Math.min(MAX_TRADE_RISK_PCT, Number(body.riskPerTrade) || 0.5));
    if (body.maxLossPerTrade !== undefined) b.maxLossPerTrade = Math.max(0, Math.min(capCeiling(b), Number(body.maxLossPerTrade) || 0));
    if (body.dailyLossLimit !== undefined) b.dailyLossLimit = Math.max(0, Math.min(capCeiling(b) * 10, Number(body.dailyLossLimit) || 0));
    if (body.lockInProfit !== undefined) b.lockInProfit = !!body.lockInProfit;
    b.trailing = body.trailing === undefined ? b.trailing : !!body.trailing;
    b.profitTarget = Math.max(0, Number(body.profitTarget) || 0);
    if (dailyLimitHit(b)) {
      b.running = false; b.stoppedReason = 'daily-loss-limit'; markDirty();
      if (!saveDb()) return riskStorageFailure(res);
      return sendJson(res, 409, { error: 'daily-loss-limit' });
    }
    b.targetHit = null; b.pendingEntry = null; b.stoppedReason = null; b.waitingReason = null; b.running = true; b.startedAt = b.startedAt || Date.now(); markDirty();
    if (!saveDb()) return riskStorageFailure(res);
    return sendJson(res, 200, { bot: publicBot(b), signal: signalScore(b.symbol), simulation: simulationStatus(b.symbol, b) });
  }
  // Change strategy and/or risk settings without restarting the engine.
  if (p === '/api/bot/settings' && method === 'POST') {
    const b = user.bot;
    if (hasBrokerExposure(user)) return brokerExposureError(res);
    const protection = protectionSettings(b, body);
    if (!protection) return sendJson(res, 400, { error: 'invalid-profit-protection', message: 'Trail start must be above break-even activation, and all R values must be in range.' });
    const wanted = typeof body.strategy === 'string' ? body.strategy.trim() : null;
    if (wanted != null && wanted !== 'auto' && !ENGINE.STRATEGIES[wanted]) return sendJson(res, 400, { error: 'unknown-strategy', message: 'That strategy is not in the catalogue.' });
    // A preset sets the whole risk block; explicit valid fields override it.
    if (typeof body.preset === 'string' && PRESETS[body.preset]) applyPreset(b, body.preset);
    if (wanted != null) b.strategy = wanted;
    if (body.autoRisk !== undefined) b.autoRisk = !!body.autoRisk;
    if (body.compoundProfits !== undefined) b.compoundProfits = body.compoundProfits;
    Object.assign(b, protection);
    if (body.riskPerTrade !== undefined) b.riskPerTrade = Math.max(0.1, Math.min(MAX_TRADE_RISK_PCT, Number(body.riskPerTrade) || 0.5));
    // Optional cash limits can tighten, but never disable the mandatory rails.
    if (body.maxLossPerTrade !== undefined) b.maxLossPerTrade = Math.max(0, Math.min(capCeiling(b), Number(body.maxLossPerTrade) || 0));
    if (body.dailyLossLimit !== undefined) b.dailyLossLimit = Math.max(0, Math.min(capCeiling(b) * 10, Number(body.dailyLossLimit) || 0));
    if (body.lockInProfit !== undefined) b.lockInProfit = body.lockInProfit;
    if (body.trailing !== undefined) b.trailing = body.trailing;
    if (body.maxTrades !== undefined) b.maxTrades = Math.max(1, Math.min(10, parseInt(body.maxTrades, 10) || 1));
    if (body.aggression !== undefined) b.aggression = Math.max(1, Math.min(10, parseInt(body.aggression, 10) || 6));
    if (body.lots !== undefined) b.lots = Math.min(50, Math.max(1e-8, Number(body.lots) || 1e-8));
    b.pendingEntry = null; // do not fill a signal queued before the settings change
    // Any hand-tuned field means the client left the preset.
    if (body.preset === 'custom' || (!body.preset && b.preset)) b.preset = 'custom';
    const sel = strategyFor(b);
    enforceAccountRisk(b);
    if (dailyLimitHit(b)) { b.running = false; b.stoppedReason = 'daily-loss-limit'; }
    markDirty();
    if (!saveDb()) return riskStorageFailure(res);
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
    if (storageError) return riskStorageFailure(res);
    return sendJson(res, 200, { bot: publicBot(user.bot), report, refreshedAt: Date.now(), deriv: user.deriv ? derivAccountPublic(user) : null });
  }
  if (p === '/api/bot/target' && method === 'POST') {
    if (!Number.isFinite(Number(body.target)) || Number(body.target) < 0) return sendJson(res, 400, { error: 'invalid-profit-target' });
    const b = user.bot; b.profitTarget = Number(body.target);
    if (b.profitTarget === 0 || b.profit < b.profitTarget) b.targetHit = null;
    markDirty(); return sendJson(res, 200, { bot: publicBot(b) });
  }
  if (p === '/api/bot/stop' || p === '/api/bot/closeall') {
    if (method !== 'POST') return sendJson(res, 404, { error: 'not-found' });
    flattenBot(user, p.endsWith('closeall') ? 'emergency' : 'stopped');
    if (hasBrokerExposure(user)) return brokerExposureError(res);
    if (storageError) return riskStorageFailure(res);
    return sendJson(res, 200, { bot: publicBot(user.bot) });
  }
  if (p === '/api/deriv/link' && method === 'POST') {
    if (hasBrokerExposure(user)) return brokerExposureError(res);
    user.bot.live = false;
    if (!db.config.derivAppId) return sendJson(res, 503, { error: 'deriv-app-id-required', message: 'Register your R.H PILOT application at developers.deriv.com and set its App ID in Platform settings before linking a PAT or OAuth account.' });
    const token = String(body.token || '').trim(); if (!token) return sendJson(res, 400, { error: 'missing-token' });
    try {
      const acct = await derivFetchAccount(token);
      user.deriv = { loginid: acct.loginid, token, currency: acct.currency, balance: acct.balance, isVirtual: acct.isVirtual, connectedAt: Date.now(), via: 'token', accounts: acct.accounts || [] };
      saveDb(); return sendJson(res, 200, { deriv: derivAccountPublic(user), cashier: cashierUrls(acct.loginid) });
    } catch (e) { derivLastError = 'deriv-link: ' + e.message; return sendJson(res, 502, { error: 'deriv-link-failed', message: 'Could not verify that token with Deriv: ' + e.message }); }
  }
  if (p === '/api/deriv/unlink' && method === 'POST') {
    if (hasBrokerExposure(user)) return sendJson(res, 409, { error: 'live-positions-open', message: 'Stop the bot and close live positions before unlinking.' });
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
    const out = { ok: false, serverOk: false, accountOk: null, accountRequired: true, latency: 0, serverTime: null, appId: db.config.derivAppId };
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
    out.ok = out.serverOk && out.accountOk === true;
    return sendJson(res, 200, out);
  }
  /* Verify demo + real account permissions independently. This only requests
     quotes; it never buys a contract and never arms live execution. */
  if (p === '/api/deriv/verify-accounts' && method === 'POST') {
    if (!user.deriv || !user.deriv.token) return sendJson(res, 400, { ok: false, error: 'no-deriv-account', message: 'Link Deriv with a token that can access your trading accounts first.' });
    try {
      const report = await derivVerifyAccounts(user.deriv.token, body.symbol || 'VOL10');
      user.deriv.accounts = report.accounts.map(a => ({ loginid: a.loginid, isVirtual: a.type === 'demo', currency: a.currency || 'USD', balance: a.balance }));
      const current = report.accounts.find(a => a.loginid === user.deriv.loginid);
      if (current && current.verified) user.deriv.verifiedAt = Date.now();
      markDirty();
      return sendJson(res, report.allVerified ? 200 : 502, { ok: report.allVerified, ...report });
    } catch (error) {
      return sendJson(res, 502, { ok: false, error: 'deriv-account-verification-failed', message: error.message });
    }
  }
  /* Prove the real-money path end to end without placing an order: is the linked
     account authorised, is it real, and has the client armed execution? */
  if (p === '/api/deriv/ready' && method === 'GET') {
    return sendJson(res, 200, { ready: false, reason: LIVE_SAFETY.reason,
      message: LIVE_SAFETY.message, reconciliationRequired: hasBrokerExposure(user) });
  }
  /* Switch the active Deriv account between the client's demo and real accounts.
     Nothing here touches money: it only changes which account the bot is bound
     to. Real trading still requires the explicit arming above. */
  if (p === '/api/deriv/account' && method === 'POST') {
    if (!user.deriv) return sendJson(res, 400, { error: 'no-deriv-account', message: 'Link your Deriv account first.' });
    if (hasBrokerExposure(user)) {
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
    user.bot.live = false; // every account switch disarms, not just demo switches
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
    if (body.live !== false) return sendJson(res, 503, { error: LIVE_SAFETY.reason, message: LIVE_SAFETY.message, live: false });
    user.bot.live = false; user.bot.pendingEntry = null;
    if (hasBrokerExposure(user)) return brokerExposureError(res);
    markDirty(); return sendJson(res, 200, { live: false, liveSafety: LIVE_SAFETY, deriv: derivAccountPublic(user) });
  }
  if (p === '/api/market/symbols' && method === 'GET') return sendJson(res, 200, { symbols: Object.keys(DERIV_SYMBOLS), live: derivLive, forexOpen: forexWeekOpen(new Date()), markets: marketCatalogue(), groups: marketGroups() });
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
      if (hasBrokerExposure(removed)) return brokerExposureError(res);
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
      if (db.users.some(hasBrokerExposure)) return brokerExposureError(res);
      if (db.users.some(u => u.bot && (u.bot.running || u.bot.positions.length))) return sendJson(res, 409, { error: 'stop-bots-before-restore' });
      const data = body.snapshot && body.snapshot.data ? body.snapshot.data : body.snapshot;
      if (!data || !Array.isArray(data.users) || !data.users.length) return sendJson(res, 400, { error: 'bad-backup' });
      if (!data.users.some(u => u && u.role === 'admin')) return sendJson(res, 400, { error: 'no-admin-in-backup' });
      let restored;
      try { restored = normaliseDb(data); }
      catch (e) { return sendJson(res, 400, { error: 'bad-backup', message: 'Backup schema/risk ledger cannot be validated; nothing was replaced.' }); }
      if (restored.users.some(u => u.bot.positions.length || u.bot.running)) return sendJson(res, 409, { error: 'backup-has-open-exposure' });
      const ledgerFields = ['accountingVersion', 'balance', 'startBalance', 'profit', 'peakProfit',
        'closedTrades', 'closedWins', 'closedLosses', 'closedScratches', 'dayLoss', 'dayPnl',
        'dayStartBalance', 'lossDay', 'dayLimitLatched', 'risk', 'startedAt', 'lastEntryAt'];
      const ledger = b => Object.fromEntries(ledgerFields.map(k => [k, b[k]]));
      const ids = new Set(restored.users.map(u => u.id));
      if (ids.size !== restored.users.length || db.users.some(u => {
        accountRisk(u.bot); // initialise an untouched watermark before comparing
        const old = restored.users.find(v => v.id === u.id);
        return !old || !isDeepStrictEqual(ledger(u.bot), ledger(old.bot));
      })) return sendJson(res, 409, { error: 'risk-state-rollback', message: 'Restore cannot remove accounts or replace their newer paper balance, risk history, cooldown or loss latches. Review the backup offline.' });
      const previous = db;
      db = restored;
      if (!saveDb()) { db = previous; return riskStorageFailure(res); }
      return sendJson(res, 200, { ok: true, users: db.users.length });
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
      if (u.bot && (u.bot.running || u.bot.positions.length)) evaluate(u);
    } catch (e) { console.error('[engine]', e.message); }
  }
}
function evaluateSymbol(key, price) {
  for (const u of db.users) {
    try { if (u.bot && (u.bot.running || u.bot.positions.length) && u.bot.symbol === key) evaluate(u); }
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
  timers.push(setInterval(engineLoop, options.engineInterval || 80));
  timers.push(setInterval(pricePump, options.priceInterval || 250));
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
  derivRequest, derivFetchAccount, derivVerifyAccounts, derivPlaceTrade, derivSellContract,
  placeLive, closeLive, canTradeReal,
  setLicenseMode, lockdownLicenses, setMaintenance, freezeClients, isMaintenanceBlocked,
  repairEmail, resolveLoginEmail, syncAdminCredentials, gradeStrategy, GRADES,
  sizeFor, riskBudgetFor, openRiskCash, accountRisk, conservativeEquity, RISK, LIVE_SAFETY, isBrokerPosition, hasBrokerExposure, dailyLossBudget, dailyLimitHit, noteDayLoss, rollDay, MAX_TRADE_RISK_PCT, PRESETS, applyPreset, recoverViaGoogle, resetAdminPassword, publicUser, setGoogleVerifier,
  slimDb, memoryReport, memoryGuard,
  _internals: {
    get db() { return db; }, set db(v) { db = v; },
    get storageError() { return storageError; },
    hist, market, simPrice, simDrift, SIM, DERIV_SYMBOLS, DEFAULT_CONFIG, ENGINE, pointValue, contractSize,
    strategyFor, strategyCatalogue, loadStrategyReport, marketContext, chooseSignal, signalAllowed, sizeFor, resyncBot, publicUser, liveCap, liveDailyLimit, riskBudgetFor, bestPair, publicBot, canTradeReal, scaledLimits, simState, simTickCounts, detectLinkedBalance
  }
};
