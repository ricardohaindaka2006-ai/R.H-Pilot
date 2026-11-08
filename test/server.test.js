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
  // The engine needs its warm-up window (~72 ticks) before it will fire.
  I.hist[key] = Array.from({ length: 120 }, (_, i) => base + i * base * 0.00015);
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
  user.bot.autoRisk = false;            // fixed-lot mode for this assertion
  user.bot.strategy = 'breakout-momentum';
  app.evaluateSymbol('XAUUSD');
  assert.equal(user.bot.positions.length, 1);
  assert.equal(user.bot.positions[0].dir, 'BUY');
  assert.equal(user.bot.positions[0].lots, 0.01);
  assert.ok(user.bot.lastEntryAt > 0);
  assert.equal(user.bot.positions[0].strategy, 'breakout-momentum', 'entries are tagged with their strategy');
  assert.ok(user.bot.positions[0].tpPrice > user.bot.positions[0].entry, 'take-profit is set from the strategy geometry');
  assert.ok(user.bot.positions[0].slPrice < user.bot.positions[0].entry, 'stop is set from the strategy geometry');
  app.evaluateSymbol('XAUUSD');
  assert.equal(user.bot.positions.length, 1, 'cooldown prevents duplicate immediate entries');
});

test('simulated market feed warms the engine and opens a practice position', () => {
  const user = freshUser();
  const base = I.SIM.XAUUSD.price;
  const originalRandom = Math.random;
  user.bot.running = true;
  user.bot.strategy = 'breakout-momentum';
  user.bot.autoRisk = false;
  user.bot.lots = 0.01;
  user.bot.maxTrades = 1;
  I.hist.XAUUSD = [];
  I.market.XAUUSD = { price: base, at: 0, epoch: Math.floor(Date.now() / 1000), source: 'sim' };
  I.simPrice.XAUUSD = base;
  I.simDrift.XAUUSD = 0;
  I.simState.XAUUSD = { direction: 1, remaining: 120, anchor: base };
  I.simTickCounts.XAUUSD = 0;
  // A fixed random draw makes this test deterministic while exercising the
  // same currentPrice -> history -> strategy -> position path as live simulation.
  Math.random = () => 0.75;
  try {
    for (let i = 0; i < 120; i++) app.currentPrice('XAUUSD');
    assert.equal(I.market.XAUUSD.source, 'sim');
    assert.ok(I.hist.XAUUSD.length >= 100, 'simulator must populate enough market history');
    assert.ok(I.simTickCounts.XAUUSD >= 120, 'simulator tick counter must advance');
    app.evaluate(user);
    assert.equal(user.bot.positions.length, 1, 'a clean synthetic trend must open a practice position');
    assert.equal(user.bot.positions[0].strategy, 'breakout-momentum');
    assert.equal(user.bot.live, false, 'simulation must never arm Deriv real execution');
  } finally {
    Math.random = originalRandom;
  }
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

test('Deriv current API mock validates REST accounts, OTP proposal and buy', async () => {
  const RealWebSocket = global.WebSocket;
  const realFetch = global.fetch;
  const sockets = [], restCalls = [];
  class MockWebSocket {
    constructor(url) { this.url = url; this.frames = []; sockets.push(this); setImmediate(() => this.onopen && this.onopen()); }
    send(raw) {
      const msg = JSON.parse(raw); this.frames.push(msg);
      setImmediate(() => {
        let out;
        if (msg.proposal) out = { req_id: msg.req_id, msg_type: 'proposal', proposal: { id: 'proposal-1' } };
        else if (msg.buy) out = { req_id: msg.req_id, msg_type: 'buy', buy: { contract_id: 998877 } };
        else out = { req_id: msg.req_id, msg_type: 'ping', ping: 'pong' };
        this.onmessage && this.onmessage({ data: JSON.stringify(out) });
      });
    }
    close() {}
  }
  global.WebSocket = MockWebSocket;
  global.fetch = async (url, options = {}) => {
    restCalls.push({ url: String(url), options });
    const data = String(url).endsWith('/otp')
      ? { data: { url: 'wss://api.derivws.com/trading/v1/options/ws/demo?otp=one-time' } }
      : { data: [{ account_id: 'DOT90004580', balance: 123.45, currency: 'USD', status: 'active', account_type: 'demo' }] };
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  process.env.DERIV_NATIVE_WS = '1';
  try {
    I.db = { users: [], sessions: {}, config: I.DEFAULT_CONFIG(), createdAt: Date.now() };
    const account = await app.derivFetchAccount('demo-token');
    assert.equal(account.loginid, 'DOT90004580');
    assert.equal(account.balance, 123.45);
    assert.equal(account.isVirtual, true);
    const buy = await app.derivPlaceTrade({ token: 'demo-token', loginid: account.loginid, currency: 'USD' }, { symbol: 'VOL10', direction: 'BUY', stake: 1 });
    assert.equal(buy.contract_id, 998877);
    const proposalSocket = sockets.find(s => s.frames.some(f => f.proposal));
    assert.equal(proposalSocket.frames[0].underlying_symbol, 'R_10');
    assert.equal(proposalSocket.frames[0].authorize, undefined, 'retired authorize field must not be sent');
    assert.match(proposalSocket.url, /otp=one-time/);
    const buySocket = sockets.find(s => s.frames.some(f => f.buy));
    assert.match(buySocket.url, /otp=one-time/);
    assert.equal(restCalls.filter(c => c.options.method === 'POST').length, 2, 'each OTP socket is single-use');
    assert.equal(restCalls[0].options.headers.Authorization, 'Bearer demo-token');
  } finally {
    global.WebSocket = RealWebSocket;
    global.fetch = realFetch;
    delete process.env.DERIV_NATIVE_WS;
  }
});


test('Deriv verification checks demo and real accounts with quote-only proposals', async () => {
  const RealWebSocket = global.WebSocket;
  const realFetch = global.fetch;
  const sockets = [], restCalls = [];
  class MockWebSocket {
    constructor(url) { this.url = url; this.frames = []; sockets.push(this); setImmediate(() => this.onopen && this.onopen()); }
    send(raw) {
      const msg = JSON.parse(raw); this.frames.push(msg);
      setImmediate(() => this.onmessage && this.onmessage({ data: JSON.stringify({
        req_id: msg.req_id, msg_type: 'proposal', proposal: { id: 'quote-' + this.frames.length, ask_price: 1 }
      }) }));
    }
    close() {}
  }
  global.WebSocket = MockWebSocket;
  global.fetch = async (url, options = {}) => {
    restCalls.push({ url: String(url), options });
    const data = String(url).endsWith('/otp')
      ? { data: { url: 'wss://api.derivws.com/trading/v1/options/ws/one-time?otp=one-time' } }
      : { data: [
          { account_id: 'VRTC90004580', balance: 10000, currency: 'USD', status: 'active', account_type: 'demo' },
          { account_id: 'CR90004581', balance: 250, currency: 'USD', status: 'active', account_type: 'real' }
        ] };
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  process.env.DERIV_NATIVE_WS = '1';
  try {
    I.db = { users: [], sessions: {}, config: I.DEFAULT_CONFIG(), createdAt: Date.now() };
    const report = await app.derivVerifyAccounts('two-account-token', 'VOL10');
    assert.equal(report.allVerified, true);
    assert.deepEqual(report.accounts.map(a => a.type).sort(), ['demo', 'real']);
    assert.ok(report.accounts.every(a => a.verified && a.proposalVerified));
    assert.equal(sockets.length, 2, 'each account must receive its own one-time OTP socket');
    assert.ok(sockets.every(s => s.frames.length === 1 && s.frames[0].proposal === 1));
    assert.ok(sockets.every(s => !s.frames.some(f => f.buy)), 'verification must never buy a contract');
    assert.equal(restCalls.filter(c => c.options.method === 'POST').length, 2);
  } finally {
    global.WebSocket = RealWebSocket;
    global.fetch = realFetch;
    delete process.env.DERIV_NATIVE_WS;
  }
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
  assert.match(html, new RegExp(`<link rel="canonical" href="${base}/">`));
  assert.doesNotMatch(html, /__PUBLIC_URL__/);
  const structured = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(structured);
  const product = JSON.parse(structured[1]);
  assert.equal(product.name, 'R.H Pilot');
  assert.equal(product.applicationCategory, 'FinanceApplication');
  const robots = await fetch(base + '/robots.txt').then(r => r.text());
  assert.match(robots, /Disallow: \/api\//);
  assert.match(robots, new RegExp(`Sitemap: ${base}/sitemap.xml`));
  const sitemap = await fetch(base + '/sitemap.xml').then(r => r.text());
  assert.match(sitemap, new RegExp(`<loc>${base}/</loc>`));
  const social = await fetch(base + '/og-image.png', { method: 'HEAD' });
  assert.equal(social.status, 200);
  assert.equal(social.headers.get('content-type'), 'image/png');
  assert.ok(Number(social.headers.get('content-length')) > 100000);
  const manifest = await fetch(base + '/site.webmanifest').then(r => r.json());
  assert.equal(manifest.short_name, 'R.H Pilot');
  assert.equal(health && (await fetch(base + '/api/health')).headers.get('x-robots-tag'), 'noindex, nofollow');

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
  assert.equal(started.bot.live, false, 'a bot without a linked Deriv account must run in simulation only');
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
  assert.equal(diagnostic.accountOk, null);
  assert.equal(diagnostic.accountRequired, true);
  assert.ok(diagnostic.latency >= 0);
  const bothAccounts = await fetch(base + '/api/deriv/verify-accounts', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ symbol: 'VOL10' }) });
  assert.equal(bothAccounts.status, 400, 'account verification must refuse to claim success without a linked account');
  assert.equal((await bothAccounts.json()).error, 'no-deriv-account');
});

test('free-for-everyone mode lets a keyless client in, and turning keys back on logs them out', () => {
  const user = freshUser();
  const client = { id: 'u2', email: 'free@test.local', role: 'user', active: true, paid: false, deriv: null, bot: app.defaultBot() };
  I.db.users.push(client);
  I.db.sessions = { adminToken: { userId: user.id, exp: Date.now() + 60000 }, clientToken: { userId: client.id, exp: Date.now() + 60000 } };
  client.bot.running = true;

  // Free mode: a client with no key is allowed in.
  I.db.config.licenseRequired = false;
  assert.equal(app.publicUser(client).paid, true);

  // Keys required again: the client is dropped, their bot is stopped, the admin stays.
  const out = app.setLicenseMode(true);
  assert.equal(out.required, true);
  assert.equal(out.loggedOut, 1);
  assert.equal(out.botsStopped, 1);
  assert.equal(client.bot.running, false);
  assert.equal(client.paid, false);
  assert.equal(I.db.sessions.adminToken.userId, user.id);
  assert.equal(I.db.sessions.clientToken, undefined);
});

test('lockdown revokes every unused key and keeps the admin signed in', () => {
  const user = freshUser();
  I.db.config.licenseRequired = false;
  I.db.config.licenses = [
    { id: 'l1', key: 'RHP-AAAA-AAAA-AAAA', plan: 'days30', status: 'unused' },
    { id: 'l2', key: 'RHP-BBBB-BBBB-BBBB', plan: 'days30', status: 'active', boundUserId: 'u9' },
  ];
  I.db.sessions = { adminToken: { userId: user.id, exp: Date.now() + 60000 } };
  const out = app.lockdownLicenses();
  assert.equal(out.revoked, 1);                       // only the unused one flips
  assert.equal(I.db.config.licenseRequired, true);
  assert.equal(I.db.config.licenses[1].status, 'active');
  assert.ok(I.db.sessions.adminToken);
});

test('admin password recovery via Google only accepts the authorised address', async () => {
  const user = freshUser();
  user.pass = app.hashPassword('OldPassword2026!');
  I.db.config.googleClientId = 'test-client.apps.googleusercontent.com';
  I.db.config.recovery = { googleEmail: 'owner@gmail.com', phone: '081 609 0300', whatsappWebhook: '', pending: null };
  // Swap the network verifier for a stub: the allow-list logic is what matters here.
  app.setGoogleVerifier(async (body) => {
    if (body.email) return { email: body.email, aud: 'test-client.apps.googleusercontent.com' };
    throw Object.assign(new Error('google-token-invalid'), { httpStatus: 401, code: 'google-token-invalid' });
  });

  // A stranger's Google identity must be refused.
  await assert.rejects(
    app.recoverViaGoogle({ email: 'stranger@gmail.com' }),
    (e) => e.httpStatus === 403
  );

  // The owner's identity issues a one-time ticket, and the ticket sets the new password.
  const ticket = await app.recoverViaGoogle({ email: 'owner@gmail.com' });
  assert.equal(ticket.ok, true);
  await assert.rejects(app.resetAdminPassword(ticket.ticket, 'short'), (e) => e.code === 'password-too-short');
  const done = await app.resetAdminPassword(ticket.ticket, 'BrandNewPass2026!');
  assert.equal(done.ok, true);
  assert.equal(app.verifyPassword('BrandNewPass2026!', user.pass), true);
  assert.equal(app.verifyPassword('OldPassword2026!', user.pass), false);
  // A used ticket cannot be replayed.
  await assert.rejects(app.resetAdminPassword(ticket.ticket, 'AnotherPass2026!'));
});

test('maintenance freezes clients but leaves the admin able to trade', () => {
  const admin = freshUser();
  const client = { id: 'u3', email: 'live@test.local', role: 'user', active: true, paid: true, deriv: null, bot: app.defaultBot() };
  I.db.users.push(client);
  risingMarket();
  client.bot.running = true; client.bot.symbol = 'XAUUSD';
  admin.bot.running = true;

  const on = app.setMaintenance({ enabled: true, message: 'Engine upgrade', version: '1.0.1' }, admin.email);
  assert.equal(on.maintenance.enabled, true);
  assert.equal(on.maintenance.version, '1.0.1');
  assert.equal(I.db.config.appVersion, '1.0.1');
  assert.equal(on.stopped, 1, 'the client bot is stopped');
  assert.equal(admin.bot.running, true, 'the admin keeps trading');
  assert.ok(on.maintenance.startedAt, 'the window is timestamped');

  const off = app.setMaintenance({ enabled: false }, admin.email);
  assert.equal(off.maintenance.enabled, false);
  assert.equal(off.maintenance.startedAt, null);
});

test('a frozen client can never keep trading, even from a stale screen', () => {
  const admin = freshUser();
  const client = { id: 'u4', email: 'late@test.local', role: 'user', active: true, paid: true, deriv: null, bot: app.defaultBot() };
  I.db.users.push(client);
  client.bot.running = true;
  I.db.config.maintenance.enabled = true;
  // Every non-admin bot route asks this first.
  assert.equal(app.isMaintenanceBlocked(client), true);
  assert.equal(app.isMaintenanceBlocked(admin), false);
});

test('the persisted store is capped so the free instance never fills its disk', () => {
  const user = freshUser();
  user.bot.trades = Array.from({ length: 900 }, (_, i) => ({ at: i, pnl: 1 }));
  user.events = Array.from({ length: 400 }, (_, i) => ({ at: i }));
  I.db.config.logins = Array.from({ length: 5000 }, (_, i) => ({ at: i }));
  I.db.config.mailOutbox = Array.from({ length: 900 }, (_, i) => ({ id: String(i) }));
  I.db.config.news = Array.from({ length: 400 }, (_, i) => ({ id: i }));
  I.db.config.ratings = Array.from({ length: 900 }, (_, i) => ({ id: i }));
  Object.assign(I.db.sessions, {
    live: { userId: user.id, exp: Date.now() + 60000 },
    dead: { userId: user.id, exp: Date.now() - 1000 }
  });

  app.slimDb();

  assert.ok(user.bot.trades.length <= 200, 'trades capped');
  assert.ok(user.events.length <= 80, 'events capped');
  assert.ok(I.db.config.logins.length <= 300, 'logins capped');
  assert.ok(I.db.config.mailOutbox.length <= 120, 'outbox capped');
  assert.ok(I.db.config.news.length <= 100, 'news capped');
  assert.ok(I.db.config.ratings.length <= 300, 'ratings capped');
  assert.equal(I.db.sessions.dead, undefined, 'expired sessions never persisted');
  assert.ok(I.db.sessions.live, 'live sessions survive');
});

test('memory reporting gives the admin real headroom numbers', () => {
  const r = app.memoryReport();
  assert.ok(r.usedMb > 0);
  assert.ok(r.limitMb >= 128);
  assert.ok(r.pct >= 0 && r.pct <= 100);
  assert.doesNotThrow(() => app.memoryGuard());   // safe to call under normal load
});

test('the owner email survives common typos at login', () => {
  // Every variant a person actually types on a phone should resolve.
  assert.equal(app.repairEmail('@ricardohaindaka2006gmail.com'), 'ricardohaindaka2006@gmail.com');
  assert.equal(app.repairEmail('ricardohaindaka2006gmail.com'), 'ricardohaindaka2006@gmail.com');
  assert.equal(app.repairEmail('  ricardohaindaka2006@gmail.com  '), 'ricardohaindaka2006@gmail.com');
  assert.equal(app.repairEmail('RICARDOHAINDAKA2006@GMAIL.COM'), 'ricardohaindaka2006@gmail.com');
  assert.equal(app.repairEmail('ricardo at gmail.com'), 'ricardo@gmail.com');
  assert.equal(app.repairEmail(''), '');
});

test('a typo in the admin address still reaches the admin account', () => {
  const admin = freshUser();
  admin.email = 'ricardohaindaka2006@gmail.com';
  I.db.config.recovery = { googleEmail: 'ricardohaindaka2006@gmail.com', phone: '081 609 0300', whatsappWebhook: '', pending: null };
  assert.equal(app.resolveLoginEmail('@ricardohaindaka2006gmail.com'), 'ricardohaindaka2006@gmail.com');
  assert.equal(app.resolveLoginEmail('ricardohaindaka2006gmail.com'), 'ricardohaindaka2006@gmail.com');
  // A genuinely different address is left alone, never hijacked to the admin.
  assert.equal(app.resolveLoginEmail('someone.else@gmail.com'), 'someone.else@gmail.com');
});

test('the admin password is synced from env on every boot', () => {
  const admin = freshUser();
  admin.role = 'admin';
  admin.email = 'old@address.local';
  admin.pass = app.hashPassword('stale-password');
  admin.active = false;
  const before = process.env.ADMIN_PASSWORD, beforeEmail = process.env.ADMIN_EMAIL;
  process.env.ADMIN_PASSWORD = 'Deriv@2026';
  process.env.ADMIN_EMAIL = 'ricardohaindaka2006@gmail.com';
  try {
    const synced = app.syncAdminCredentials();
    assert.equal(synced.email, 'ricardohaindaka2006@gmail.com');
    assert.equal(synced.active, true, 'a disabled admin is re-enabled');
    assert.equal(app.verifyPassword('Deriv@2026', synced.pass), true, 'env password wins');
    assert.equal(app.verifyPassword('stale-password', synced.pass), false);
  } finally {
    if (before === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = before;
    if (beforeEmail === undefined) delete process.env.ADMIN_EMAIL; else process.env.ADMIN_EMAIL = beforeEmail;
  }
});

test('strategy grades rank the money-makers and never crown a loser', () => {
  const winner = app.gradeStrategy({ winRate: 0.985, trades: 1600, expectancyR: 0.196, profitFactor: 13.6 });
  assert.equal(winner, 'best');
  const solid = app.gradeStrategy({ winRate: 0.93, trades: 2500, expectancyR: 0.13, profitFactor: 2.9 });
  assert.equal(solid, 'excellent');
  // A high hit rate that still loses money must never be graded BEST.
  const trap = app.gradeStrategy({ winRate: 0.98, trades: 900, expectancyR: -0.05, profitFactor: 0.4 });
  assert.notEqual(trap, 'best');
  assert.notEqual(trap, 'excellent');
  const dead = app.gradeStrategy({ winRate: 0.23, trades: 21, expectancyR: -0.6, profitFactor: 0 });
  assert.equal(dead, 'weak');
  assert.equal(app.gradeStrategy(null), 'weak');
});

test('only the surviving strategies are shipped to clients', () => {
  const ids = app._internals.ENGINE.STRATEGY_IDS;
  assert.equal(ids.length, 4, 'four money-making strategies only');
  assert.deepEqual(ids.slice().sort(), ['breakout-momentum', 'macd-momentum', 'scalper-pro', 'springbok-fusion']);
  // Nothing that lost money in validation may remain selectable.
  for (const gone of ['squeeze-release', 'liquidity-sweep', 'rsi-reversion', 'ema-ribbon', 'bollinger-fade']) {
    assert.equal(ids.includes(gone), false, gone + ' must not ship');
  }
});

test('the balance is read from the linked Deriv account, matching the mode in use', () => {
  const accounts = [
    { loginid: 'CR1', isVirtual: false, balance: 2 },
    { loginid: 'VR1', isVirtual: true, balance: 10000 }
  ];
  const onReal = { deriv: { loginid: 'CR1', isVirtual: false, balance: 2, accounts } };
  assert.equal(app._internals.detectLinkedBalance(onReal), 2, 'real mode reads the real balance');

  const onDemo = { deriv: { loginid: 'VR1', isVirtual: true, balance: 10000, accounts } };
  assert.equal(app._internals.detectLinkedBalance(onDemo), 10000, 'demo mode reads the practice balance');

  const single = { deriv: { loginid: 'CR2', isVirtual: false, balance: 50, accounts: [] } };
  assert.equal(app._internals.detectLinkedBalance(single), 50, 'falls back to the single known balance');

  assert.equal(app._internals.detectLinkedBalance({ deriv: null }), 0, 'nothing linked -> 0');
  assert.equal(app._internals.detectLinkedBalance({ deriv: { isVirtual: false, balance: 0, accounts: [] } }), 0, 'a zero balance is never used');
});

test('money limits scale to the detected balance — $2 and $100 are both protected in proportion', () => {
  const safe = { capPct: 1, dailyPct: 8, riskPct: 1 };
  const tiny = app._internals.scaledLimits(safe, 2);
  assert.equal(tiny.maxLossPerTrade, 0.05, 'a $2 account risks a few cents, not dollars');
  assert.equal(tiny.dailyLossLimit, 0.25);
  const hundred = app._internals.scaledLimits(safe, 100);
  assert.equal(hundred.maxLossPerTrade, 1);
  assert.equal(hundred.dailyLossLimit, 8);
  const large = app._internals.scaledLimits(safe, 100000);
  assert.equal(large.maxLossPerTrade, 1000, 'a large account is not silently throttled');
});
