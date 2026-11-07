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
  googleClientId: '',
  mt5BridgeUrl: '',
  appVersion: '1.0.0',
  maintenance: { enabled: false, message: '', version: '1.0.0', notes: '', startedAt: null, by: null },
  engineWeights: { trend: 1, momentum: 1, breakout: 1, reversal: 1 },
  engineStats: { scored: 0, wins: 0, losses: 0, lastUpdate: null },
  hub: { url: '', token: '', autoBackup: true, lastBackupAt: null, lastPushAt: null, lastPushError: '' },
  profile: {
    legalName: '', registrationNo: '', country: '',
    supportEmail: 'ricardohaindaka2006@gmail.com', supportPhone: '081 609 300',
    companyEmail: '', assistantPhone: '', website: 'https://rhpilot.com', termsUrl: '',
    privacyUrl: '', riskUrl: '', about: ''
  },
  recovery: { googleEmail: 'ricardohaindaka2006@gmail.com', phone: '081 609 300', whatsappWebhook: '', pending: null },
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
    if (!db.config.profile.supportPhone) db.config.profile.supportPhone = '081 609 300';
    if (!db.config.recovery.phone) db.config.recovery.phone = '081 609 300';
    if (!db.config.recovery.googleEmail) db.config.recovery.googleEmail = 'ricardohaindaka2006@gmail.com';
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
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_PATH);
    dbDirty = false;
  } catch (e) { console.error('[db] save failed:', e.message); }
}
function markDirty() { dbDirty = true; }

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

function defaultBot() {
  return {
    running: false, symbol: 'XAUUSD', lots: 0.01, tp: 10, sl: 2.5,
    maxTrades: 3, aggression: 6, trailing: true, live: false, liveStake: 1,
    balance: 100, profit: 0, profitTarget: 0, targetHit: null, peakProfit: 0,
    milestones: [], positions: [], trades: [], startedAt: null, lastEntryAt: 0
  };
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

function seedAdmin() {
  if (db.users.some(u => u.role === 'admin')) return;
  const email = process.env.ADMIN_EMAIL || 'admin@rhpilot.com';
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString('hex');
  db.users.push(makeUser(email, password, 'admin'));
  saveDb();
  const text = 'R.H PILOT — admin credentials (first run)\nEmail: ' + email + '\nPassword: ' + password + '\nChange this password after your first login.\n';
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(CRED_PATH, text, { mode: 0o600 }); } catch (e) {}
  console.log('[boot] admin created: ' + email + ' (credentials: ' + CRED_PATH + ')');
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
    google: u.google ? { email: u.google.email, linkedAt: u.google.linkedAt } : null, hasPassword: !!u.pass
  };
}
function publicBot(b) { return b; }
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
    try { ws.send(JSON.stringify({ active_symbols: 'brief', product_type: 'basic', req_id: 1 })); } catch (e) {}
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
function pointValue(key) { const ref = SIM[key] || { price: 1 }; return 600000 / (ref.price || 1); }
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
function placeLive(user, pos) {
  const acc = user.deriv;
  if (!user.bot.live || !acc || !acc.token) return;
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
  if (!user.bot.live || !acc || !acc.token) return;
  if (!pos.contractId) { pos.closeRequested = true; return; }
  derivSellContract(acc, pos.contractId).catch(e => { derivLastError = 'deriv-sell: ' + e.message; console.error('[deriv] sell failed:', e.message); });
}
function evaluate(user) {
  const bot = user.bot;
  if (!bot.running) return;
  const key = bot.symbol, price = peekPrice(key), tp = Math.abs(bot.tp), sl = Math.abs(bot.sl), s = signalScore(key), age = Date.now();
  for (let i = bot.positions.length - 1; i >= 0; i--) {
    const pos = bot.positions[i];
    const pnl = (price - pos.entry) * (pos.dir === 'BUY' ? 1 : -1) * contractSize(key, pos);
    if (pnl > pos.peak) pos.peak = pnl;
    if (pnl >= tp) { closePos(user, i, price, 'take-profit'); continue; }
    if (pnl <= -sl) { closePos(user, i, price, 'stop-loss'); continue; }
    if (pos.peak >= tp * 0.75 && pnl <= 0.15 * tp) { closePos(user, i, price, 'breakeven-lock'); continue; }
    if (bot.trailing && pos.peak >= tp * 0.6 && pnl <= pos.peak - sl * 0.6) { closePos(user, i, price, 'trailing'); continue; }
    const against = (pos.dir === 'BUY' && s.score <= -3.4) || (pos.dir === 'SELL' && s.score >= 3.4);
    if (s.votes && against && pnl <= -sl * 0.6 && age - pos.at > 4000) { closePos(user, i, price, 'signal-flip'); continue; }
  }
  checkProfitGuard(user);
  if (!bot.running || bot.targetHit) { markDirty(); return; }
  db.config.engineStats.scored++;
  const cooldown = Math.max(1000, 3200 - bot.aggression * 250);
  const threshold = Math.max(1.6, 2.6 - bot.aggression * 0.1);
  if (s.votes && Math.abs(s.entry) >= threshold && bot.positions.length < bot.maxTrades && age - (bot.lastEntryAt || 0) > cooldown) {
    const dir = s.entry > 0 ? 'BUY' : 'SELL', sign = dir === 'BUY' ? 1 : -1;
    const clean = s.votes.trend === sign && s.votes.momentum === sign;
    if (clean && !bot.positions.some(p => p.dir !== dir)) {
      bot.positions.push({ id: crypto.randomUUID(), dir, lots: bot.lots, entry: price, peak: 0, at: age, votes: s.votes, score: s.score });
      bot.lastEntryAt = age;
      if (bot.live) placeLive(user, bot.positions[bot.positions.length - 1]);
    }
  }
  markDirty();
}
function closePos(user, index, price, cause) {
  const bot = user.bot, pos = bot.positions[index];
  if (!pos) return null;
  bot.positions.splice(index, 1);
  const pnl = (price - pos.entry) * (pos.dir === 'BUY' ? 1 : -1) * contractSize(bot.symbol, pos);
  bot.balance += pnl; bot.profit += pnl;
  bot.trades.unshift({ symbol: bot.symbol, dir: pos.dir, lots: pos.lots, entry: pos.entry, exit: price, pnl, cause, at: Date.now(), score: pos.score });
  if (bot.trades.length > 200) bot.trades.pop();
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
  noteMilestones(b, b.profit);
  if (b.profitTarget > 0 && b.profit >= b.profitTarget && !b.targetHit) {
    b.targetHit = { at: Date.now(), target: b.profitTarget, profit: b.profit };
    b.running = false; b.stoppedAt = Date.now();
    console.log('[target] reached for ' + user.email + ': $' + b.profit.toFixed(2));
  }
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
    return sendJson(res, 200, { ok: true, version: db.config.appVersion, uptime: Math.floor(process.uptime()), deriv: { status: derivStatus, live: derivLive, lastTickAt: derivLastTickAt, lastError: derivLastError }, engine: { symbols: Object.keys(DERIV_SYMBOLS).length, runningBots: db.users.filter(u => u.bot.running).length } });
  }
  if (p === '/api/auth/me' && method === 'GET') {
    const u = getSessionUser(req); if (!u) return sendJson(res, 401, { error: 'not-authenticated' });
    return sendJson(res, 200, { user: publicUser(u), bot: publicBot(u.bot) });
  }
  if (p === '/api/auth/login' && method === 'POST') {
    const ip = req.socket.remoteAddress || 'x';
    if (tooManyAttempts(ip)) return sendJson(res, 429, { error: 'too-many-attempts' });
    const email = String(body.email || '').toLowerCase().trim(), user = db.users.find(u => u.email === email);
    if (!user || !user.active || !verifyPassword(body.password, user.pass)) { noteAttempt(ip); return sendJson(res, 401, { error: 'invalid-credentials' }); }
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
      support: { phone: db.config.profile.supportPhone || '081 609 300', email: db.config.profile.supportEmail || 'ricardohaindaka2006@gmail.com', website: db.config.profile.website || 'https://rhpilot.com' },
      maintenance: visible, plans: db.config.plans, licenseRequired: !!db.config.licenseRequired,
      engine: { weights: db.config.engineWeights, stats: db.config.engineStats }
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
    const vendor = db.config.profile.supportPhone || rc.phone || '081 609 300';
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
    const rc = db.config.recovery, admin = db.users.find(u => u.role === 'admin' && u.active);
    if (!admin) return sendJson(res, 404, { error: 'no-admin' });
    let info;
    try { info = await verifyGoogleIdentity(body); } catch (e) { return sendJson(res, e.httpStatus || 401, { error: e.code || 'google-token-invalid' }); }
    const email = String(info.email).toLowerCase(), allowed = [rc.googleEmail, admin.google && admin.google.email].filter(Boolean).map(x => String(x).toLowerCase());
    if (!allowed.length) return sendJson(res, 400, { error: 'recovery-google-unset' });
    if (!allowed.includes(email)) return sendJson(res, 403, { error: 'google-not-authorized' });
    return sendJson(res, 200, { ok: true, ticket: issueResetTicket('google') });
  }
  if (p === '/api/auth/recover/reset' && method === 'POST') {
    const t = resetTickets.get(String(body.ticket || ''));
    if (!t || Date.now() > t.expiresAt) return sendJson(res, 400, { error: 'ticket-invalid' });
    const pw = String(body.password || ''); if (pw.length < 8) return sendJson(res, 400, { error: 'password-too-short' });
    const admin = db.users.find(u => u.id === t.userId && u.role === 'admin' && u.active);
    if (!admin) return sendJson(res, 404, { error: 'no-admin' });
    admin.pass = hashPassword(pw);
    Object.keys(db.sessions).forEach(k => { if (db.sessions[k].userId === admin.id) delete db.sessions[k]; });
    resetTickets.delete(String(body.ticket)); db.config.recovery.pending = null; markDirty();
    return sendJson(res, 200, { ok: true, email: admin.email });
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
  if (db.config.maintenance.enabled && user.role !== 'admin') return sendJson(res, 503, { error: 'maintenance', maintenance: db.config.maintenance });

  if (p === '/api/bot/state' && method === 'GET') return sendJson(res, 200, { bot: publicBot(user.bot), price: peekPrice(user.bot.symbol), source: sourceOf(user.bot.symbol), signal: signalScore(user.bot.symbol) });
  if (p === '/api/bot/start' && method === 'POST') {
    if (db.config.licenseRequired && user.role !== 'admin' && user.paid !== true) return sendJson(res, 402, { error: 'payment-required', message: 'Complete your payment — the admin will restore access once confirmed.' });
    const b = user.bot;
    if (b.positions.length) {
      const oldPrice = peekPrice(b.symbol); let guard = 0;
      while (b.positions.length && guard++ < 500) closePos(user, b.positions.length - 1, oldPrice, 'restart');
    }
    b.symbol = DERIV_SYMBOLS[body.symbol] ? body.symbol : b.symbol;
    b.lots = Math.min(100, Math.max(0.01, Number(body.lots) || 0.01));
    b.tp = Math.min(1000000, Math.max(0.01, Math.abs(Number(body.tp) || 10)));
    b.sl = Math.min(1000000, Math.max(0.01, Math.abs(Number(body.sl) || 2.5)));
    b.maxTrades = Math.min(20, Math.max(1, parseInt(body.maxTrades, 10) || 3));
    b.aggression = Math.min(10, Math.max(1, parseInt(body.aggression, 10) || 6));
    b.trailing = !!body.trailing; b.profitTarget = Math.max(0, Number(body.profitTarget) || 0);
    b.targetHit = null; b.positions = []; b.running = true; b.startedAt = Date.now(); b.lastEntryAt = 0; markDirty();
    return sendJson(res, 200, { bot: publicBot(b), signal: signalScore(b.symbol) });
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
  if (p === '/api/deriv/test' && method === 'POST') {
    const t0 = Date.now();
    try {
      const msg = await derivCall({ time: 1 }, 8000), st = msg && msg.time;
      return sendJson(res, 200, { ok: true, latency: Date.now() - t0, serverTime: st ? new Date(st * 1000).toISOString() : null, appId: db.config.derivAppId });
    } catch (e) { return sendJson(res, 200, { ok: false, latency: Date.now() - t0, error: e.message, appId: db.config.derivAppId }); }
  }
  if (p === '/api/bot/live' && method === 'POST') {
    if (db.config.licenseRequired && body.live && user.role !== 'admin' && user.paid !== true) return sendJson(res, 402, { error: 'payment-required' });
    const want = !!body.live;
    if (want) {
      if (!user.deriv) return sendJson(res, 400, { error: 'no-deriv-account', message: 'Link your Deriv account first.' });
      if (!user.deriv.token) return sendJson(res, 400, { error: 'no-token' });
      if (body.confirm !== true) return sendJson(res, 400, { error: 'confirm-required', message: 'Real-money trading must be confirmed.' });
      if (Number(body.stake) > 0) user.bot.liveStake = Math.min(1000, Math.max(0.35, Number(body.stake)));
    }
    if (!want && user.bot.positions.some(p => p.contractId || p.livePending)) {
      return sendJson(res, 409, { error: 'live-positions-open', message: 'Stop the bot and close open live contracts before switching to simulation.' });
    }
    user.bot.live = want;
    markDirty(); return sendJson(res, 200, { live: user.bot.live, liveStake: user.bot.liveStake, deriv: derivAccountPublic(user) });
  }
  if (p === '/api/market/symbols' && method === 'GET') return sendJson(res, 200, { symbols: Object.keys(DERIV_SYMBOLS), live: derivLive });
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
    if (p === '/api/admin/license-required' && method === 'PUT') { db.config.licenseRequired = !!body.required; saveDb(); return sendJson(res, 200, { required: db.config.licenseRequired }); }
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
      const m = db.config.maintenance, wasEnabled = m.enabled;
      if (typeof body.enabled === 'boolean') m.enabled = body.enabled;
      if (typeof body.message === 'string') m.message = body.message.slice(0, 600);
      if (typeof body.notes === 'string') m.notes = body.notes.slice(0, 2000);
      if (typeof body.version === 'string' && body.version.trim()) { m.version = body.version.trim(); db.config.appVersion = m.version; }
      if (m.enabled && !wasEnabled) { m.startedAt = Date.now(); m.by = user.email; }
      if (!m.enabled) m.startedAt = null;
      let mailed = 0;
      if (body.notify) mailed = broadcastMail('R.H PILOT update — v' + (m.version || db.config.appVersion), (m.message || 'We are updating R.H PILOT.') + (m.notes ? '\n\nWhat\'s new:\n' + m.notes : ''), 'clients');
      saveDb(); return sendJson(res, 200, { maintenance: m, version: db.config.appVersion, mailed });
    }
    if (p === '/api/admin/engine' && method === 'GET') return sendJson(res, 200, { weights: db.config.engineWeights, stats: db.config.engineStats });
    if (p === '/api/admin/engine' && method === 'PUT') {
      if (body.reset) db.config.engineWeights = { trend: 1, momentum: 1, breakout: 1, reversal: 1 };
      else if (body.weights && typeof body.weights === 'object') ['trend', 'momentum', 'breakout', 'reversal'].forEach(k => { const v = Number(body.weights[k]); if (Number.isFinite(v)) db.config.engineWeights[k] = Math.min(3, Math.max(0.2, v)); });
      markDirty(); return sendJson(res, 200, { weights: db.config.engineWeights });
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
  loadDb(); seedAdmin(); initMarket(); connectDeriv();
  timers.push(setInterval(() => { if (dbDirty) saveDb(); }, 4000));
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
  _internals: { get db() { return db; }, set db(v) { db = v; }, hist, market, simPrice, SIM, DERIV_SYMBOLS, DEFAULT_CONFIG }
};
