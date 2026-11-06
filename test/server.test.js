'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhpilot-test-'));
process.env.DATA_DIR = tempDir;
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'TestPassword2026!';
process.env.DERIV_WS_URL = 'ws://127.0.0.1:1/websockets/v3';

const app = require('../server.js');
const I = app._internals;

function freshUser() {
  const user = { id: 'u1', email: 'trader@test.local', role: 'admin', active: true, paid: true, deriv: null, bot: app.defaultBot() };
  I.db = { users: [user], sessions: {}, config: I.DEFAULT_CONFIG(), createdAt: Date.now() };
  return user;
}
function risingMarket(key = 'XAUUSD') {
  const base = I.SIM[key].price;
  I.hist[key] = Array.from({ length: 45 }, (_, i) => base + i * base * 0.00015);
  I.market[key] = { price: I.hist[key].at(-1), at: Date.now(), epoch: Math.floor(Date.now() / 1000), source: 'sim' };
}

test('password hashes are salted and verified safely', () => {
  const one = app.hashPassword('correct-horse-2026');
  const two = app.hashPassword('correct-horse-2026');
  assert.notEqual(one, two);
  assert.equal(app.verifyPassword('correct-horse-2026', one), true);
  assert.equal(app.verifyPassword('wrong-password', one), false);
  assert.equal(app.verifyPassword('anything', 'broken'), false);
});

test('license keys normalise and plan clocks start at redemption', () => {
  assert.equal(app.normalizeLicenseKey('rhp-abcd-efgh-jklm'), 'RHP-ABCD-EFGH-JKLM');
  assert.equal(app.normalizeLicenseKey('RHPABCDEFGHJKLM'), 'RHP-ABCD-EFGH-JKLM');
  const from = Date.now();
  assert.equal(app.planExpiry('lifetime', from), null);
  assert.equal(app.planExpiry('days30', from), from + 30 * 86400000);
});

test('EMA and RSI cover neutral, rising and falling series', () => {
  assert.equal(app.ema([1, 2, 3], 3), 2);
  assert.equal(app.ema([1, 2], 3), null);
  assert.equal(app.rsi(Array.from({ length: 20 }, (_, i) => i + 1), 14), 100);
  assert.equal(app.rsi(Array.from({ length: 20 }, (_, i) => 20 - i), 14), 0);
  assert.equal(app.rsi(Array(20).fill(5), 14), 50);
});

test('Springboks signal fusion identifies a clean bullish setup', () => {
  freshUser(); risingMarket();
  const signal = app.signalScore('XAUUSD');
  assert.equal(signal.votes.trend, 1);
  assert.equal(signal.votes.momentum, 1);
  assert.equal(signal.votes.breakout, 1);
  assert.ok(signal.entry >= 2);
});

test('event evaluation opens a risk-bounded position only on a clean setup', () => {
  const user = freshUser(); risingMarket();
  user.bot.running = true; user.bot.aggression = 6; user.bot.maxTrades = 2;
  app.evaluateSymbol('XAUUSD');
  assert.equal(user.bot.positions.length, 1);
  assert.equal(user.bot.positions[0].dir, 'BUY');
  assert.equal(user.bot.positions[0].lots, 0.01);
  assert.ok(user.bot.lastEntryAt > 0);
  app.evaluateSymbol('XAUUSD');
  assert.equal(user.bot.positions.length, 1, 'cooldown prevents duplicate immediate entries');
});

test('take-profit closes the position and books exactly calculated P/L', () => {
  const user = freshUser();
  user.bot.running = true; user.bot.tp = 1; user.bot.sl = 5; user.bot.lastEntryAt = Date.now();
  I.hist.XAUUSD = [];
  const exit = I.SIM.XAUUSD.price + 2;
  I.market.XAUUSD = { price: exit, at: Date.now(), source: 'sim' };
  user.bot.positions.push({ id: 'p1', dir: 'BUY', lots: 0.01, entry: I.SIM.XAUUSD.price, peak: 0, at: Date.now(), votes: null, score: 0 });
  app.evaluate(user);
  assert.equal(user.bot.trades.length, 1);
  assert.equal(user.bot.trades[0].cause, 'take-profit');
  assert.ok(user.bot.trades[0].pnl >= 1);
  assert.equal(user.bot.positions.length, 0);
});

test('stop-loss protects the downside and updates simulated balance', () => {
  const user = freshUser();
  user.bot.running = true; user.bot.tp = 10; user.bot.sl = 1; user.bot.lastEntryAt = Date.now();
  I.hist.XAUUSD = [];
  const entry = I.SIM.XAUUSD.price;
  I.market.XAUUSD = { price: entry - 2, at: Date.now(), source: 'sim' };
  user.bot.positions.push({ id: 'p2', dir: 'BUY', lots: 0.01, entry, peak: 0, at: Date.now(), votes: null, score: 0 });
  app.evaluate(user);
  assert.equal(user.bot.trades[0].cause, 'stop-loss');
  assert.ok(user.bot.profit <= -1);
  assert.ok(user.bot.balance < 100);
});

test('profit target atomically stops new entries and records the result', () => {
  const user = freshUser();
  user.bot.running = true; user.bot.profitTarget = 1; user.bot.tp = 2; user.bot.sl = 5;
  I.hist.XAUUSD = [];
  const entry = I.SIM.XAUUSD.price;
  I.market.XAUUSD = { price: entry + 2, at: Date.now(), source: 'sim' };
  user.bot.positions.push({ id: 'p3', dir: 'BUY', lots: 0.01, entry, peak: 0, at: Date.now(), votes: null, score: 0 });
  app.evaluate(user);
  assert.equal(user.bot.running, false);
  assert.ok(user.bot.targetHit.profit >= 1);
  assert.equal(user.bot.positions.length, 0);
});

test('administrative flatten closes exposure instead of leaving it unmanaged', () => {
  const user = freshUser();
  user.bot.running = true;
  const entry = I.SIM.XAUUSD.price;
  I.market.XAUUSD = { price: entry + 0.2, at: Date.now(), source: 'sim' };
  user.bot.positions.push({ id: 'flat-1', dir: 'BUY', lots: 0.01, entry, peak: 0, at: Date.now(), votes: null, score: 0 });
  app.flattenBot(user, 'access-restricted');
  assert.equal(user.bot.running, false);
  assert.equal(user.bot.positions.length, 0);
  assert.equal(user.bot.trades[0].cause, 'access-restricted');
});

test('online learning stays bounded and normalised', () => {
  freshUser();
  for (let i = 0; i < 200; i++) app.learnFrom({ trend: 1, momentum: 1, breakout: -1, reversal: 0 }, i % 2 === 0, 1);
  const w = I.db.config.engineWeights;
  Object.values(w).forEach(v => assert.ok(v >= 0.25 && v <= 2.5));
  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  assert.ok(sum > 3.8 && sum < 4.2);
});

test('Deriv protocol mock validates authorize, balance, proposal and buy sequence', async () => {
  const RealWebSocket = global.WebSocket;
  const sockets = [];
  class MockWebSocket {
    constructor(url) { this.url = url; this.frames = []; sockets.push(this); setImmediate(() => this.onopen && this.onopen()); }
    send(raw) {
      const msg = JSON.parse(raw); this.frames.push(msg);
      setImmediate(() => {
        let out;
        if (msg.authorize) out = { req_id: msg.req_id, msg_type: 'authorize', authorize: { loginid: 'VRTC123', currency: 'USD', balance: 100, is_virtual: 1, email: 'demo@test.local', account_list: [{ loginid: 'VRTC123', currency: 'USD', is_virtual: 1 }] } };
        else if (msg.balance) out = { req_id: msg.req_id, msg_type: 'balance', balance: { balance: 123.45, currency: 'USD' } };
        else if (msg.proposal) out = { req_id: msg.req_id, msg_type: 'proposal', proposal: { id: 'proposal-1' } };
        else if (msg.buy) out = { req_id: msg.req_id, msg_type: 'buy', buy: { contract_id: 998877 } };
        else out = { req_id: msg.req_id, msg_type: 'ping', ping: 'pong' };
        this.onmessage && this.onmessage({ data: JSON.stringify(out) });
      });
    }
    close() {}
  }
  global.WebSocket = MockWebSocket;
  try {
    I.db = { users: [], sessions: {}, config: I.DEFAULT_CONFIG(), createdAt: Date.now() };
    const account = await app.derivFetchAccount('demo-token');
    assert.equal(account.loginid, 'VRTC123');
    assert.equal(account.balance, 123.45);
    assert.equal(account.isVirtual, true);
    const buy = await app.derivPlaceTrade({ token: 'demo-token', currency: 'USD' }, { symbol: 'VOL10', direction: 'BUY', stake: 1 });
    assert.equal(buy.contract_id, 998877);
    const proposalSocket = sockets.find(s => s.frames.some(f => f.proposal));
    assert.equal(proposalSocket.frames[0].authorize, 'demo-token', 'proposal must follow authorization on the same socket');
    const buySocket = sockets.find(s => s.frames.some(f => f.buy));
    assert.equal(buySocket.frames[0].authorize, 'demo-token', 'buy must follow authorization on the same socket');
  } finally { global.WebSocket = RealWebSocket; }
});

test('full HTTP product: static UI, auth, license binding, bot and diagnostics', async (t) => {
  const server = await app.start({ port: 0, host: '127.0.0.1', priceInterval: 1000, engineInterval: 100 });
  t.after(async () => {
    const closed = new Promise(resolve => server.once('close', resolve));
    app.stop(); await closed;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await fetch(base + '/api/health').then(r => r.json());
  assert.equal(health.ok, true);
  assert.equal(health.engine.symbols, 16);
  const html = await fetch(base + '/').then(r => r.text());
  assert.match(html, /R\.H Pilot/);
  assert.match(html, /price-chart/);

  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@test.local', password: 'TestPassword2026!' }) });
  assert.equal(login.status, 200);
  const adminCookie = login.headers.get('set-cookie').split(';')[0];
  const adminHeaders = { 'Content-Type': 'application/json', Cookie: adminCookie };

  const made = await fetch(base + '/api/admin/licenses', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ plan: 'days30', count: 1, label: 'Test client' }) }).then(r => r.json());
  const key = made.created[0].key;
  const registered = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'client@test.local', password: 'ClientPassword!', license: key }) });
  // Registration reads the HttpOnly license cookie set by /api/license/check.
  assert.equal(registered.status, 403, 'key must be checked and set as a cookie first');
  const checked = await fetch(base + '/api/license/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
  const licCookie = checked.headers.get('set-cookie').split(';')[0];
  const registered2 = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: licCookie }, body: JSON.stringify({ email: 'client@test.local', password: 'ClientPassword!' }) });
  assert.equal(registered2.status, 201);
  const clientCookie = registered2.headers.get('set-cookie').split(';')[0];

  const second = await fetch(base + '/api/license/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
  const secondLic = second.headers.get('set-cookie').split(';')[0];
  const duplicate = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: secondLic }, body: JSON.stringify({ email: 'other@test.local', password: 'OtherPassword!' }) });
  assert.equal(duplicate.status, 409, 'one key cannot unlock multiple accounts');

  const startedResponse = await fetch(base + '/api/bot/start', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: clientCookie }, body: JSON.stringify({ symbol: 'VOL10', lots: 0.01, tp: 10, sl: 2.5, maxTrades: 3, aggression: 6, trailing: true, profitTarget: 100 }) });
  assert.equal(startedResponse.status, 200);
  const started = await startedResponse.json();
  assert.equal(started.bot.running, true);
  assert.equal(started.bot.symbol, 'VOL10');
  const botState = await fetch(base + '/api/bot/state', { headers: { Cookie: clientCookie } }).then(r => r.json());
  assert.ok(Object.hasOwn(botState, 'signal'));
  const stopped = await fetch(base + '/api/bot/stop', { method: 'POST', headers: { Cookie: clientCookie } }).then(r => r.json());
  assert.equal(stopped.bot.running, false);

  // A different valid cookie key must never hide the account's expired key.
  const otherKeyResponse = await fetch(base + '/api/admin/licenses', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ plan: 'days30', count: 1 }) }).then(r => r.json());
  const otherKey = otherKeyResponse.created[0].key;
  const clientRecord = I.db.users.find(u => u.email === 'client@test.local');
  clientRecord.licenseExpiresAt = Date.now() - 1000;
  const expired = await fetch(base + '/api/bot/state', { headers: { Cookie: `${clientCookie}; lic=${encodeURIComponent(otherKey)}` } });
  assert.equal(expired.status, 401);
  assert.equal((await expired.json()).error, 'license-expired');

  const diagnostic = await fetch(base + '/api/deriv/test', { method: 'POST', headers: adminHeaders }).then(r => r.json());
  assert.equal(diagnostic.ok, false, 'isolated test endpoint must fail honestly');
  assert.ok(diagnostic.latency >= 0);
});
