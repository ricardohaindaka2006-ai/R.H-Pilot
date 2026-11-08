'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhp-mt5-api-'));
process.env.DATA_DIR = dir; process.env.NODE_ENV = 'test'; process.env.DERIV_WS_URL = 'ws://127.0.0.1:1';
const app = require('../server.js'), I = app._internals, M = I.MT5, bridge = I.mt5Bridge;
const SIGNAL = { dir: 1, slDist: 0.2, tpDist: 0.5, hold: 30, strategy: 'breakout-momentum' };
const ACCOUNT = { login: '1234567', server: 'Deriv-Demo', company: 'Deriv fixture',
  currency: 'USD', balance: 100, equity: 100, freeMargin: 100, tradeMode: 0, marginMode: 2, tradeAllowed: true, expertAllowed: true };
const QUOTE = { symbol: 'XAUUSD', bid: 100, ask: 100.02, timeMsc: Date.now(), point: 0.01, digits: 2,
  tickSize: 0.01, tickValueLoss: 1, volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01, stopsLevel: 0, freezeLevel: 0, tradeMode: 4 };
const HASH = app.hashPassword('Owner-fixture-password-only');
let server, base, u, cookie, token, sequence, instanceId, sessionId, originalChoose;
const request = async (route, body, options = {}) => {
  const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(options.headers || {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(8000) });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, data: text ? JSON.parse(text) : null };
};
async function pair() {
  const result = await request('/api/mt5/pair', { login: ACCOUNT.login, server: ACCOUNT.server, symbol: 'XAUUSD' });
  assert.equal(result.status, 200); token = result.data.token; return result;
}
function report(changes = {}) {
  return { protocol: 1, instanceId, sessionId, sequence: ++sequence, account: structuredClone(ACCOUNT),
    quote: { ...QUOTE, timeMsc: Date.now() }, positions: [], pendingOrders: 0, results: [], ...changes };
}
const poll = body => request('/api/mt5/agent/poll', body, { headers: { Authorization: 'Bearer ' + token, Cookie: '' } });
function warm() {
  const rt = bridge.runtime.get(u.id);
  rt.history = Array.from({ length: 120 }, (_, i) => 99 + i * 0.01);
  rt.timeMsc = Date.now() - 100; u.mt5.lastEntryAt = 0;
}
async function arm() {
  await pair(); const first = await poll(report()); assert.equal(first.status, 200); warm();
  const result = await request('/api/mt5/start', { confirmation: 'MT5_DEMO_ONLY' }); assert.equal(result.status, 200); return result;
}
function closed(id, pnl = 0.4, positionId = '7001') {
  return { id, status: 'closed', positionId, pnl, grossProfit: pnl + 0.05, commission: -0.02, swap: -0.01, fee: -0.02,
    entryVolume: 0.01, exitVolume: 0.01, dealCount: 2, closedAt: Date.now() };
}

test.before(async () => {
  server = app.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port; originalChoose = bridge.chooseSignal;
});
test.beforeEach(() => {
  process.env.NODE_ENV = 'test'; process.env.RENDER = 'false'; delete process.env.ADMIN_EMAIL; delete process.env.ADMIN_PASSWORD;
  I.stateStore = null; bridge.runtime.clear(); bridge.busy.clear(); bridge.chooseSignal = () => ({ ...SIGNAL });
  instanceId = crypto.randomUUID(); sessionId = crypto.randomUUID(); sequence = 0; token = null;
  u = { id: 'mt5-workspace', email: 'owner@fixture.test', role: 'admin', active: true, paid: true, pass: HASH,
    deriv: null, mt5: null, mt5Archive: [], bot: app.defaultBot() };
  I.db = { users: [u], sessions: {}, config: I.DEFAULT_CONFIG(), createdAt: Date.now() }; I.db.config.licenseRequired = false;
  cookie = 'sid=' + I.createSession(u.id); fs.rmSync(path.join(dir, 'db.json.tmp'), { force: true }); assert.equal(app.saveDb(), true);
});
test.after(async () => {
  I.stateStore = null; bridge.chooseSignal = originalChoose;
  await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true });
});

test('pairing is authenticated, exact-account and returns only a one-time hashed bridge secret', async () => {
  const result = await pair(); assert.match(token, /^rhp5_[A-Za-z0-9_-]{43}$/);
  assert.equal(u.mt5.tokenHash, M.hash(token)); assert.equal(result.text.includes(u.mt5.tokenHash), false);
  const state = await request('/api/mt5/status'); assert.equal(state.text.includes(token), false); assert.equal(state.text.includes(u.mt5.tokenHash), false);
  const onDisk = fs.readFileSync(path.join(dir, 'db.json'), 'utf8'); assert.equal(onDisk.includes(token), false);
  assert.equal((await request('/api/mt5/pair', { login: '0', server: '', symbol: 'XAUUSD' })).status, 400);
  assert.equal((await request('/api/mt5/pair', { login: 1234567, server: 'Deriv-Demo', symbol: 'XAUUSD' })).status, 400);
  assert.equal((await request('/api/mt5/pair', { ...ACCOUNT, symbol: 'XAUUSD' }, { headers: { Cookie: '' } })).status, 401);
});

test('another workspace cannot claim an account, including after unlinking and archiving it', async () => {
  await pair(); await poll(report()); await request('/api/mt5/unlink', {});
  assert.equal(u.mt5, null); assert.equal(u.mt5Archive.length, 1);
  const stranger = { ...u, id: 'different-workspace', email: 'other@fixture.test', mt5Archive: [], mt5: null, bot: app.defaultBot() };
  I.db.users.push(stranger); cookie = 'sid=' + I.createSession(stranger.id);
  const result = await request('/api/mt5/pair', { login: ACCOUNT.login, server: ACCOUNT.server, symbol: 'XAUUSD' });
  assert.equal(result.status, 409); assert.equal(result.data.error, 'mt5-account-already-linked');
});

test('real and zero-balance accounts can be monitored, but real orders cannot be armed', async () => {
  await pair(); const first = await poll(report({ account: { ...ACCOUNT, tradeMode: 2 } })); assert.equal(first.status, 200);
  assert.equal(first.data.command, null); assert.equal((await request('/api/mt5/start', { confirmation: 'MT5_DEMO_ONLY' })).data.error, 'mt5-real-orders-disabled');
  assert.equal(app.canTradeReal(u), false);
  await request('/api/mt5/unlink', {}); await pair();
  const zero = await poll(report({ account: { ...ACCOUNT, balance: 0, equity: 0, freeMargin: 0 } }));
  assert.equal(zero.status, 200); assert.equal(u.mt5.ledger.balance, 0); assert.equal(u.mt5.ledger.risk.drawdownLatched, true); assert.equal(zero.data.command, null);
});

test('demo activation needs explicit consent, a fresh quote and durable production storage', async () => {
  await pair(); await poll(report());
  assert.equal((await request('/api/mt5/start', {})).status, 400);
  bridge.runtime.get(u.id).quote.timeMsc = Date.now() - 9000;
  assert.equal((await request('/api/mt5/start', { confirmation: 'MT5_DEMO_ONLY' })).data.error, 'mt5-stale-quote');
  bridge.runtime.get(u.id).quote.timeMsc = Date.now(); process.env.NODE_ENV = 'production';
  const denied = await request('/api/mt5/start', { confirmation: 'MT5_DEMO_ONLY' }, { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.equal(denied.status, 503); assert.equal(denied.data.error, 'durable-storage-required');
});

test('polling binds account, journal instance and a fenced agent process; malformed reports have no side effects', async () => {
  await pair(); const accepted = report(); assert.equal((await poll(accepted)).status, 200);
  const before = structuredClone(u.mt5);
  for (const invalid of [report({ account: { ...ACCOUNT, login: '9876543' } }), report({ instanceId: crypto.randomUUID() }),
    report({ sessionId: crypto.randomUUID() }), report({ quote: { ...QUOTE, timeMsc: Date.now(), volumeStep: 0 } }),
    report({ results: [{ id: 'bad', status: 'closed' }] })]) assert.ok((await poll(invalid)).status >= 400);
  assert.deepEqual(u.mt5, before);
});

test('a reserved intent is persisted before delivery and a replay returns the same intent without another reservation', async () => {
  await arm(); const body = report(), result = await poll(body);
  assert.equal(result.status, 200); const c = result.data.command; assert.ok(c);
  assert.equal(c.demoOnly, true); assert.equal(c.sessionId, sessionId); assert.ok(c.maxRisk <= 0.5);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')).users[0].mt5.orders[0].id, c.id);
  assert.equal(u.mt5.orders.length, 1); assert.equal(u.mt5.orders[0].status, 'delivered');
  assert.equal((await poll(body)).data.command.id, c.id); assert.equal(u.mt5.orders.length, 1);
  const conflicting = structuredClone(body); conflicting.pendingOrders = 1;
  assert.equal((await poll(conflicting)).data.error, 'mt5-report-replayed');
});

test('timer/duplicate quote polling does not manufacture a fresh MT5 tick or rewrite every heartbeat to disk', async () => {
  await pair(); let writes = 0; const persist = bridge.persist; bridge.persist = async () => { writes++; await persist(); };
  try {
    const q = { ...QUOTE, timeMsc: Date.now() }; await poll(report({ quote: q })); const initial = writes;
    for (let i = 0; i < 20; i++) await poll(report({ quote: q }));
    assert.equal(writes, initial, 'quiet snapshots stay bounded in memory, not 1 Hz whole-DB writes');
    assert.equal(bridge.runtime.get(u.id).history.length, 1);
  } finally { bridge.persist = persist; }
});

test('unresolved or foreign broker exposure blocks duplicate entries, switching, unpairing and paper starts', async () => {
  await arm(); const c = (await poll(report())).data.command;
  const next = await poll(report()); assert.equal(next.data.command, null);
  assert.equal(u.mt5.orders[0].id, c.id);
  assert.equal((await request('/api/mt5/unlink', {})).status, 409);
  assert.equal((await request('/api/mt5/pair', { login: '9876543', server: ACCOUNT.server, symbol: 'XAUUSD' })).status, 409);
  assert.equal((await request('/api/bot/start', { startBalance: 100 })).status, 409);
  assert.equal(u.bot.profit, 0); assert.equal(u.bot.positions.length, 0);
});

test('pending foreign MT5 orders cannot be forgotten by unpairing', async () => {
  await pair(); await poll(report({ pendingOrders: 1 }));
  assert.equal((await request('/api/mt5/unlink', {})).status, 409);
  assert.equal(app.hasBrokerExposure(u), true);
});

test('broker settlement, all costs and exact receipts update only the MT5 ledger exactly once', async () => {
  await arm(); const c = (await poll(report())).data.command;
  const receipt = closed(c.id), body = report({ account: { ...ACCOUNT, balance: 100.4, equity: 100.4 }, results: [receipt] });
  const settled = await poll(body); assert.equal(settled.status, 200); assert.ok(settled.data.ack.includes(c.id));
  assert.equal(u.mt5.ledger.profit, 0.4); assert.equal(u.mt5.ledger.closedTrades, 1); assert.equal(u.mt5.orders[0].status, 'settled');
  assert.deepEqual(u.mt5.orders[0].costs, { grossProfit: 0.45, commission: -0.02, swap: -0.01, fee: -0.02, dealCount: 2 });
  assert.equal(u.bot.profit, 0); assert.equal(u.bot.closedTrades, 0);
  await poll({ ...body, sequence: ++sequence }); assert.equal(u.mt5.ledger.closedTrades, 1);
  const bad = { ...receipt, pnl: 0.5, grossProfit: 0.55 };
  assert.equal((await poll(report({ results: [bad] }))).data.error, 'mt5-receipt-conflict');
});

test('unknown, inconsistent-cost or incomplete-volume settlements never clear reservations', async () => {
  await arm(); const c = (await poll(report())).data.command;
  for (const receipt of [closed('a'.repeat(24)), { ...closed(c.id), pnl: 999 }, { ...closed(c.id), exitVolume: 0.005 }]) {
    assert.ok((await poll(report({ results: [receipt] }))).status >= 400);
    assert.equal(u.mt5.orders[0].status, 'delivered'); assert.equal(u.mt5.ledger.closedTrades, 0);
  }
});

test('a late acknowledgement cannot turn a filled order into a rejection', async () => {
  await arm(); const c = (await poll(report())).data.command;
  await poll(report({ results: [{ id: c.id, status: 'filled', positionId: '7001', volume: 0.01, entry: 100.02, sl: 99.8, tp: 100.52 }] }));
  assert.equal(u.mt5.orders[0].status, 'filled');
  assert.equal((await poll(report({ results: [{ id: c.id, status: 'rejected' }] }))).data.error, 'mt5-receipt-conflict');
  assert.equal(u.mt5.orders[0].status, 'filled');
});

test('three losses trigger a persisted pause and pairing/unpairing cannot reset account risk', async () => {
  await pair(); await poll(report());
  for (let n = 0; n < 3; n++) {
    const id = crypto.randomBytes(12).toString('hex'); u.mt5.orders.unshift({ id, status: 'delivered', risk: 0.5 });
    await poll(report({ account: { ...ACCOUNT, balance: 100 - (n + 1) * 0.2, equity: 100 - (n + 1) * 0.2 }, results: [closed(id, -0.2, String(7001 + n))] }));
  }
  assert.equal(u.mt5.ledger.risk.consecutiveLosses, 3); assert.ok(u.mt5.ledger.risk.pauseUntil > Date.now());
  const risk = structuredClone(u.mt5.ledger.risk);
  await request('/api/mt5/unlink', {}); await pair(); assert.deepEqual(u.mt5.ledger.risk, risk);
  app.loadDb(); const loaded = I.db.users[0].mt5; assert.deepEqual(loaded.ledger.risk, risk); assert.equal(loaded.mode, 'monitor');
});

test('restart disarms MT5 and preserves uncertain intents and account risk history', async () => {
  await arm(); const c = (await poll(report())).data.command;
  app.loadDb(); const restored = I.db.users[0]; assert.equal(restored.mt5.mode, 'monitor');
  assert.equal(restored.mt5.orders[0].id, c.id); assert.equal(restored.mt5.orders[0].status, 'delivered');
  assert.equal(app.hasBrokerExposure(restored), true); assert.equal(restored.bot.live, false);
});

test('credential rotation pauses entries without dropping unresolved orders or accepting the old secret', async () => {
  await arm(); const c = (await poll(report())).data.command, old = token;
  const rotated = await request('/api/mt5/rotate-token', {}); assert.equal(rotated.status, 200);
  token = rotated.data.token; assert.equal(u.mt5.mode, 'monitor'); assert.equal(u.mt5.orders[0].id, c.id);
  assert.throws(() => bridge.authenticate(old), { code: 'mt5-agent-unauthorized' });
  assert.equal(bridge.authenticate(token).id, u.id);
});

test('agent polling and pairing enforce JSON, HTTPS in production and same-origin controls', async () => {
  await pair(); assert.equal((await request('/api/mt5/pair', { login: ACCOUNT.login, server: ACCOUNT.server, symbol: 'XAUUSD' }, { headers: { Origin: 'https://attacker.example' } })).status, 403);
  process.env.NODE_ENV = 'production';
  assert.equal((await poll(report())).data.error, 'mt5-secure-transport-required');
  assert.equal((await request('/api/mt5/pause', {})).data.error, 'mt5-secure-transport-required');
});

test('native symbol minima, costs and tick values enforce the $1 ceiling without rounding lots up', () => {
  const q = { ...QUOTE, timeMsc: Date.now() };
  for (const budget of [0.001, 0.01, 0.1]) assert.equal(M.planOrder(SIGNAL, q, ACCOUNT, budget), null);
  for (const budget of [0.5, 1]) {
    const result = M.planOrder(SIGNAL, q, ACCOUNT, budget); assert.ok(result);
    const risk = Math.abs(result.worstEntry - result.sl) / q.tickSize * q.tickValueLoss * result.volume + result.costBuffer;
    assert.ok(risk <= budget + 1e-9); assert.ok(result.volume >= q.volumeMin);
  }
  assert.equal(M.planOrder(SIGNAL, { ...q, volumeMin: 1 }, ACCOUNT, 1), null);
  assert.equal(M.planOrder(SIGNAL, q, ACCOUNT, 1.01), null);
});

test('no daily trade-count/profit ceiling is introduced by retained MT5 receipts', async () => {
  await arm(); u.mt5.ledger.closedTrades = 100000; u.mt5.ledger.profit = 100; u.mt5.ledger.peakProfit = 100;
  u.mt5.ledger.balance = 200; u.mt5.ledger.profit = 100; u.mt5.ledger.risk.peakBalance = 200;
  const result = await poll(report({ account: { ...ACCOUNT, balance: 200, equity: 200 } }));
  assert.ok(result.data.command); assert.equal(result.data.command.maxRisk, 1); assert.equal(u.mt5.mode, 'demo');
});

test('owner email is retained, env password changes revoke old sessions, and no password is written to files', () => {
  process.env.ADMIN_EMAIL = 'ricardohaindaka2006@gmail.com'; process.env.ADMIN_PASSWORD = 'Rotated-owner-fixture-only';
  app.syncAdminCredentials(); assert.equal(u.email, process.env.ADMIN_EMAIL);
  assert.equal(app.verifyPassword('Rotated-owner-fixture-only', u.pass), true);
  assert.equal(app.verifyPassword('Owner-fixture-password-only', u.pass), false);
  assert.equal(Object.keys(I.db.sessions).length, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'db.json'), 'utf8').includes('Rotated-owner-fixture-only'), false);
});

test('a failed persistence barrier cannot issue a workspace session or a demo intent', async () => {
  I.stateStore = { failed: false, enqueue() { throw new Error('private-database-password-not-for-clients'); }, status() { return { durable: true }; } };
  const result = await request('/api/auth/login', { email: u.email, password: 'Owner-fixture-password-only' });
  assert.equal(result.status, 503); assert.equal(result.data.error, 'risk-state-unavailable');
  assert.ok(result.headers.getSetCookie().every(s => !/^sid=[a-f0-9]{64}/.test(s)));
  assert.equal(result.text.includes('private-database-password'), false);
  assert.equal((await request('/api/health')).status, 503);
});

test('actual Node/Python HTTP protocol completes a fake-terminal lifecycle with one buy, real cost accounting and no real broker', async () => {
  await pair();
  bridge.runtime.set(u.id, { history: Array.from({ length: 120 }, (_, n) => 99 + n * 0.01), timeMsc: Date.now() - 10, at: Date.now(), quote: { ...QUOTE, timeMsc: Date.now() } });
  const { stdout } = await promisify(execFile)('python3', [path.join(__dirname, 'fixtures', 'mt5-roundtrip.py')], {
    env: { ...process.env, RHP_FIXTURE_URL: base, RHP_FIXTURE_TOKEN: token, RHP_FIXTURE_COOKIE: cookie }, timeout: 15000
  });
  const result = JSON.parse(stdout); assert.equal(result.fakeBroker, true); assert.equal(result.openSubmissions, 1);
  assert.equal(result.closedTrades, 1); assert.equal(result.unresolved, 0); assert.equal(result.realOrders, 0);
  assert.ok(Math.abs(u.mt5.ledger.profit - result.pnl) < 1e-8); assert.equal(u.bot.profit, 0);
});


test('a first empty account never invents a bankroll or risk ledger', async () => {
  await pair();
  assert.equal((await poll(report({ account: { ...ACCOUNT, balance: 0, equity: 0, freeMargin: 0 } }))).status, 200);
  assert.equal(u.mt5.ledger, undefined);
  assert.equal((await request('/api/mt5/start', { confirmation: 'MT5_DEMO_ONLY' })).data.error, 'mt5-account-not-funded');
});

test('independent MT5 settings are editable within hard rails and never mutate the paper budget', async () => {
  await pair(); const paper = structuredClone(u.bot);
  const update = await request('/api/mt5/settings', { riskPerTrade: 0.7, maxLossPerTrade: 0.3, dailyLossLimit: 1, strategy: 'breakout-momentum' });
  assert.equal(update.status, 200); assert.equal(update.data.mt5.settings.riskPerTrade, 0.7); assert.deepEqual(u.bot, paper);
  const before = structuredClone(u.mt5.settings);
  for (const body of [{ riskPerTrade: 95 }, { maxLossPerTrade: 2 }, { compoundProfits: 'true' }, { strategy: {} }, { strategy: 'constructor' }, { trailByR: 1e300 }, { live: true }]) {
    assert.equal((await request('/api/mt5/settings', body)).status, 400); assert.deepEqual(u.mt5.settings, before);
  }
});

test('compound balance growth never exceeds $1; disabling compound uses the original MT5 bankroll', async () => {
  await arm(); await request('/api/mt5/settings', { compoundProfits: false });
  u.mt5.ledger.balance = 200; u.mt5.ledger.profit = 100; u.mt5.ledger.risk.peakBalance = 200;
  const result = await poll(report({ account: { ...ACCOUNT, balance: 200, equity: 200 } }));
  assert.equal(result.data.command.maxRisk, 0.5);
});

test('tighter daily/profit stops block rearming and preserve the uncapped defaults', async () => {
  await pair(); await poll(report());
  assert.equal(u.mt5.settings.profitTarget, 0); assert.equal(u.mt5.settings.dailyLossLimit, 0);
  await request('/api/mt5/settings', { dailyLossLimit: 0.5 }); u.mt5.ledger.dayPnl = -0.5;
  assert.equal((await request('/api/mt5/start', { confirmation: 'MT5_DEMO_ONLY' })).data.error, 'daily-loss-limit');
  u.mt5.ledger.dayPnl = 0; u.mt5.ledger.profit = 1;
  await request('/api/mt5/settings', { profitTarget: 1 });
  assert.equal((await request('/api/mt5/start', { confirmation: 'MT5_DEMO_ONLY' })).data.error, 'mt5-profit-target-reached');
});

test('a lost or paused command is recovered as evidence, not blindly sent again', async () => {
  await arm(); const body = report(); const c = (await poll(body)).data.command;
  await request('/api/mt5/pause', {});
  const replay = await poll(body); assert.equal(replay.data.command, null); assert.equal(replay.data.reconcile[0].id, c.id);
  const next = await poll(report()); assert.equal(next.data.command, null); assert.deepEqual(next.data.reconcile, [c]);
  const proof = await poll(report({ results: [{ id: c.id, status: 'rejected' }] }));
  assert.equal(proof.status, 200); assert.equal(u.mt5.orders[0].status, 'rejected'); assert.equal(proof.data.reconcile.length, 0);
});

test('journal process takeover requires the lease and cannot replay an older process sequence', async () => {
  await pair(); await poll(report()); const replacement = crypto.randomUUID();
  assert.equal((await poll(report({ sessionId: replacement }))).data.error, 'mt5-agent-session-conflict');
  u.mt5.agentLeaseUntil = Date.now() - 1;
  assert.equal((await poll(report({ sessionId: replacement }))).status, 200);
  assert.equal((await poll(report())).data.error, 'mt5-agent-session-conflict');
});

test('failure to persist a reservation returns no command, no secret error and halts new entries', async () => {
  await arm(); const original = bridge.persist;
  bridge.persist = async () => { throw new Error('fixture-private-pg-password'); };
  try {
    const result = await poll(report()); assert.equal(result.status, 503); assert.equal(result.data.error, 'risk-state-unavailable');
    assert.equal(result.text.includes('fixture-private'), false); assert.equal(result.data.command, undefined);
    assert.equal(u.mt5.mode, 'monitor'); assert.equal(u.mt5.ledger.profit, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')).users[0].mt5.orders.length, 0);
  } finally { bridge.persist = original; }
});
