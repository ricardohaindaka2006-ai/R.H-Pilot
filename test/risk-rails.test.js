'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhpilot-risk-rails-'));
process.env.DATA_DIR = dir;
process.env.DERIV_WS_URL = 'ws://127.0.0.1:1';
const app = require('../server.js'), I = app._internals, R = app.RISK, P = I.ENGINE.EXECUTION;
const dbPath = path.join(dir, 'db.json');
const sig = { strategy: 'breakout-momentum', dir: 1, confidence: 0.9, atr: 1,
  tpDist: 6, slDist: 2, hold: 20, be: 0.99 };
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
function tick(price, source = 'sim') {
  I.market.XAUUSD = { price, source, at: Date.now() };
  app.notePrice('XAUUSD', price, source);
}
function fresh(balance = 100) {
  const user = { id: 'rails', email: 'rails@test.local', role: 'admin', active: true,
    paid: true, deriv: null, bot: app.applyPreset(app.defaultBot(), 'safe', balance) };
  I.db = { users: [user], sessions: {}, config: I.DEFAULT_CONFIG(), createdAt: Date.now() };
  I.hist.XAUUSD = []; tick(100);
  assert.equal(app.saveDb(), true);
  return user;
}
function position(overrides = {}, mid = 100) {
  return { ...P.paperPosition(sig, mid, { spreadAtr: 0, slippageAtr: 0 }),
    id: 'paper', at: Date.now(), strategy: sig.strategy, marketSource: 'sim',
    lots: 0.00005, ...overrides };
}
function lose(user) {
  const b = user.bot;
  tick(100); b.positions = [position()]; tick(98);
  assert.ok(Math.abs(app.closePos(user, 0, 98, 'stop-loss') + 0.01) < 1e-12);
}
async function http(t, user) {
  I.db.sessions.rails = { userId: user.id, exp: Date.now() + 86400000 };
  const server = app.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (route, body) => {
    const res = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: 'sid=rails' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, data: await res.json() };
  };
}

test('$1 planned trade cap cannot be disabled by presets, oversized custom caps or fixed lots ($0.01–$100k)', () => {
  let checks = 0;
  for (const balance of [0.01, 2, 5, 25, 66.67, 100, 200, 1000, 100000]) {
    const user = fresh(balance), b = user.bot;
    for (const preset of Object.keys(app.PRESETS)) {
      app.applyPreset(b, preset);
      for (const autoRisk of [true, false]) for (const cap of [0, 0.001, 1e6]) {
        Object.assign(b, { autoRisk, lots: 50, maxLossPerTrade: cap, dailyLossLimit: 0 });
        const budget = app.riskBudgetFor(b), lots = app.sizeFor(user, b, 100, 1, 2);
        const risk = lots * app.pointValue(b.symbol) * 2;
        assert.ok(budget > 0 && budget <= 1 && budget <= balance * 0.015 + 1e-12);
        assert.ok(risk <= budget && lots >= 0 && lots <= 50);
        checks++;
      }
    }
  }
  assert.equal(checks, 162);
});

test('aggregate planned open risk is limited to $2 / 3%, and break-even does not free the original reservation', () => {
  const u = fresh(1000), b = u.bot;
  Object.assign(b, { riskPerTrade: 1.5, maxLossPerTrade: 0, dailyLossLimit: 0, maxTrades: 10 });
  const p = position({ lots: 0.005, plannedRiskCash: 1, slPrice: 100, beTriggered: true });
  b.positions = [p];
  assert.equal(app.openRiskCash(b), 1);
  assert.equal(app.riskBudgetFor(b), 1);
  b.positions.push({ ...p, id: 'second' });
  assert.equal(app.openRiskCash(b), 2);
  assert.equal(app.riskBudgetFor(b), 0);
  assert.equal(app.sizeFor(u, b, 100, 1, 2), 0, 'ten open slots are not permission to add exposure');
});

test('daily zero/large inputs use the mandatory 3% ceiling, and a smaller cash limit still tightens it', () => {
  const u = fresh(), b = u.bot;
  app.rollDay(b);
  for (const raw of [0, 3, 1000000]) { b.dailyLossLimit = raw; assert.equal(I.liveDailyLimit(b), 3); }
  b.dailyLossLimit = 1; assert.equal(I.liveDailyLimit(b), 1);
  b.dailyLossLimit = 0; b.dayPnl = -2.5; b.dayLoss = -2.5;
  assert.equal(app.dailyLossBudget(b), 0.5);
  b.positions = [position({ lots: 0.00125, plannedRiskCash: 0.25 })];
  assert.equal(app.riskBudgetFor(b), 0.25);
  app.noteDayLoss(b, -0.5);
  assert.equal(b.dayLimitLatched, true);
  b.dailyLossLimit = 1000000;
  assert.equal(app.riskBudgetFor(b), 0);
  assert.equal(app.dailyLossBudget(b), 0);
});

test('cash high-water mark is reconstructed on migration and its drawdown latch never resets automatically', () => {
  const u = fresh(), b = u.bot;
  delete b.risk;
  Object.assign(b, { balance: 115, profit: 15, peakProfit: 25, startedAt: Date.now() });
  let risk = app.accountRisk(b);
  assert.equal(risk.peakBalance, 125);
  assert.equal(risk.floorEquity, 112.5);
  b.balance = 112.5;
  assert.equal(app.accountRisk(b).reason, 'account-drawdown-limit');
  const haltedAt = b.risk.haltedAt;
  b.balance = 200; b.profit = 100;
  for (const preset of Object.keys(app.PRESETS)) {
    app.applyPreset(b, preset);
    assert.equal(app.riskBudgetFor(b), 0);
  }
  app.rollDay(b, Date.now() + 86400000);
  assert.equal(R.inspect(b, b.balance, Date.now() + 86400000).reason, 'account-drawdown-limit');
  assert.equal(b.risk.haltedAt, haltedAt);
  assert.equal(R.seedFreshAccount(b, 100000), false);
  assert.throws(() => app.applyPreset(b, 'safe', 100000), /already-initialised/);
});

test('realised winners raise the cash watermark; unrealised winners do not fund new entries', () => {
  const u = fresh(), b = u.bot;
  b.positions = [position({ lots: 0.01 })]; tick(120);
  assert.equal(app.conservativeEquity(b), 100, 'paper gains are not banked yet');
  assert.equal(app.accountRisk(b).peakBalance, 100);
  assert.equal(app.closePos(u, 0, 120, 'take-profit'), 20);
  assert.equal(app.accountRisk(b).peakBalance, 120);
  b.balance = 108;
  assert.equal(app.accountRisk(b).reason, 'account-drawdown-limit');
});

test('remaining drawdown headroom and adverse open marks constrain the next reservation', () => {
  const u = fresh(), b = u.bot;
  Object.assign(b, { balance: 90.5, riskPerTrade: 1.5, maxLossPerTrade: 0, dailyLossLimit: 0 });
  assert.equal(app.riskBudgetFor(b), 0.5);
  b.positions = [position({ lots: 0.00125, plannedRiskCash: 0.25 })];
  tick(99);
  assert.equal(app.conservativeEquity(b), 90.375);
  assert.equal(app.riskBudgetFor(b), 0.125);
  tick(200, 'deriv');
  assert.equal(app.conservativeEquity(b), 90.5, 'never bridge a simulator position to a real quote');
});

test('drawdown rail closes valid paper exposure at the observed quote even if its old stop is wider', () => {
  const u = fresh(), b = u.bot;
  Object.assign(b, { running: true, startedAt: Date.now(), pendingEntry: { source: 'sim', at: Date.now(), signal: sig } });
  b.positions = [position({ lots: 0.01, slPrice: 50, slDist: 50, holdTicks: 100 })];
  tick(89); app.evaluate(u);
  assert.equal(b.positions.length, 0);
  assert.equal(b.balance, 89);
  assert.equal(b.profit, -11);
  assert.equal(b.trades[0].cause, 'account-drawdown-limit');
  assert.equal(b.running, false);
  assert.equal(b.pendingEntry, null);
  assert.equal(b.risk.drawdownLatched, true);
  const saved = JSON.parse(fs.readFileSync(dbPath));
  assert.equal(saved.users[0].bot.risk.drawdownLatched, true);
});

test('planned cash rails never clip a real paper gap loss, including negative equity', () => {
  const u = fresh(2), b = u.bot;
  assert.equal(app.riskBudgetFor(b), 0.01);
  b.positions = [position({ plannedRiskCash: 0.01 }, 100000)];
  tick(1);
  const pnl = app.closePos(u, 0, 1, 'stop-loss');
  assert.ok(Math.abs(pnl + 499.995) < 1e-10);
  assert.ok(Math.abs(b.balance + 497.995) < 1e-10);
  assert.equal(b.trades[0].pnl, pnl);
  assert.equal(b.risk.drawdownLatched, true);
  assert.equal(app.riskBudgetFor(b), 0);
});

test('three losses pause entries; a scratch/winner cannot cancel an already active pause', () => {
  const u = fresh(), b = u.bot;
  b.startedAt = Date.now();
  lose(u); lose(u);
  assert.equal(app.accountRisk(b).blocked, false);
  const before = Date.now(); lose(u);
  const until = b.risk.pauseUntil;
  assert.ok(until >= before + R.POLICY.lossPauseMs);
  assert.equal(b.risk.consecutiveLosses, 3);
  assert.equal(app.riskBudgetFor(b), 0);
  R.recordOutcome(b, 0);
  assert.equal(b.risk.consecutiveLosses, 3);
  R.recordOutcome(b, 0.01);
  assert.equal(b.risk.consecutiveLosses, 0);
  assert.equal(b.risk.pauseUntil, until);
  assert.equal(R.inspect(b, b.balance, until - 1).reason, 'loss-streak-cooldown');
  assert.equal(R.inspect(b, b.balance, until).blocked, false);
});

test('loss pause clears queued entries but keeps existing exits managed', () => {
  const u = fresh(), b = u.bot;
  b.running = true; b.startedAt = Date.now();
  lose(u); lose(u); lose(u);
  const until = b.risk.pauseUntil;
  b.positions = [position({ tpPrice: 101 })];
  b.pendingEntry = { source: 'sim', at: Date.now(), signal: sig };
  tick(102); app.evaluate(u);
  assert.equal(b.positions.length, 0, 'take-profit remains active during a pause');
  assert.equal(b.closedWins, 1);
  assert.equal(b.running, true);
  assert.equal(b.pendingEntry, null);
  assert.equal(b.waitingReason, 'loss-streak-cooldown');
  assert.equal(b.risk.pauseUntil, until, 'the winner does not bypass the timer');
});

test('UTC rollover resets only the daily latch, not an overlapping loss pause or a lifetime drawdown latch', () => {
  const originalNow = Date.now;
  let clock = Date.UTC(2026, 10, 8, 23, 59); Date.now = () => clock;
  try {
    const u = fresh(), b = u.bot; b.startedAt = clock;
    lose(u); lose(u); lose(u);
    app.noteDayLoss(b, -3);
    assert.equal(b.dayLimitLatched, true);
    const until = b.risk.pauseUntil;
    clock += 60000; app.rollDay(b);
    assert.equal(b.dayLimitLatched, false);
    assert.equal(b.risk.pauseUntil, until);
    assert.equal(app.accountRisk(b).reason, 'loss-streak-cooldown');
    b.risk.drawdownLatched = true; b.risk.haltedAt = clock;
    clock += 86400000; app.rollDay(b);
    assert.equal(app.accountRisk(b).reason, 'account-drawdown-limit');
  } finally { Date.now = originalNow; }
});

test('persisted daily/account latches and pause survive load and both resync modes', () => {
  const u = fresh(), b = u.bot;
  b.startedAt = Date.now(); b.running = true;
  lose(u); lose(u); lose(u);
  app.noteDayLoss(b, -3);
  b.risk.drawdownLatched = true; b.risk.haltedAt = Date.now();
  const state = structuredClone(b.risk);
  assert.equal(app.saveDb(), true);
  app.loadDb();
  const loaded = I.db.users[0];
  assert.equal(loaded.bot.running, false);
  assert.equal(loaded.bot.dayLimitLatched, true);
  assert.deepEqual(loaded.bot.risk, state);
  for (const mode of ['soft', 'hard']) {
    I.resyncBot(loaded, { mode });
    assert.equal(loaded.bot.running, false);
    assert.equal(loaded.bot.dayLimitLatched, true);
    assert.deepEqual(loaded.bot.risk, state);
  }
});

test('HTTP restart cannot bypass a third loss realised while flattening or accept a new bankroll', async t => {
  const u = fresh(), b = u.bot, request = await http(t, u);
  b.startedAt = Date.now(); lose(u); lose(u);
  b.positions = [position()]; tick(98);
  const result = await request('/api/bot/start', { startBalance: 100000, preset: 'aggressive', dailyLossLimit: 0, risk: R.newState() });
  assert.equal(result.status, 409);
  assert.equal(result.data.error, 'loss-streak-cooldown');
  assert.equal(b.running, false);
  assert.equal(b.positions.length, 0);
  assert.equal(b.startBalance, 100);
  assert.equal(b.risk.consecutiveLosses, 3);
  assert.ok(b.balance < 100);
  assert.equal(app.riskBudgetFor(b), 0);
});

test('HTTP edits/resync/start cannot reset a drawdown latch or turn off the daily ceiling', async t => {
  const u = fresh(), b = u.bot, request = await http(t, u);
  const started = await request('/api/bot/start', { preset: 'aggressive', dailyLossLimit: 0, maxLossPerTrade: 1e6 });
  assert.equal(started.status, 200);
  assert.equal(started.data.bot.liveDailyLimit, 3);
  assert.ok(started.data.bot.plannedEntryRisk <= 1);
  b.balance = 90; b.profit = -10;
  assert.equal(app.accountRisk(b).drawdownLatched, true);
  const state = structuredClone(b.risk);
  const edited = await request('/api/bot/settings', { preset: 'aggressive', dailyLossLimit: 0,
    risk: R.newState(), balance: 100000, dayLimitLatched: false });
  assert.equal(edited.status, 200);
  assert.equal(b.balance, 90);
  assert.deepEqual(b.risk, state);
  assert.equal(edited.data.bot.running, false);
  assert.equal(edited.data.bot.plannedEntryRisk, 0);
  const refresh = await request('/api/bot/refresh', { mode: 'hard' });
  assert.equal(refresh.status, 200);
  assert.deepEqual(b.risk, state);
  const restart = await request('/api/bot/start', { startBalance: 100000, preset: 'safe' });
  assert.equal(restart.status, 409);
  assert.equal(restart.data.error, 'account-drawdown-limit');
  assert.deepEqual(b.risk, state);
  const cfg = await request('/api/config/public');
  assert.equal(cfg.data.engine.riskPolicy.dailyTradeCountLimit, null);
  assert.equal(cfg.data.engine.riskPolicy.maxTradeRiskUsd, 1);
});

test('no daily trade-count or default profit cap: an engine fill is still eligible after 260 closed winners', () => {
  const u = fresh(), b = u.bot;
  b.running = true; b.startedAt = Date.now();
  for (let i = 0; i < 260; i++) {
    b.positions = [position({ id: 'winner-' + i })]; tick(101);
    assert.ok(app.closePos(u, 0, 101, 'take-profit') > 0);
  }
  assert.equal(b.closedTrades, 260);
  assert.equal(b.trades.length, 200, 'display log retention is not a trading cap');
  assert.equal(b.profitTarget, 0);
  assert.equal(b.running, true);
  assert.equal(b.targetHit, null);
  assert.ok(app.riskBudgetFor(b) > 0);
  b.pendingEntry = { source: 'sim', at: Date.now(), signal: sig };
  tick(100); app.evaluate(u);
  assert.equal(b.positions.length, 1, 'normal next-tick entry remains available');
  assert.ok(b.positions[0].plannedRiskCash <= 1);
});

test('non-scalar, fractional count, whitespace and non-finite HTTP risk inputs are rejected atomically', async t => {
  const u = fresh(), b = u.bot, request = await http(t, u);
  const before = JSON.stringify(b);
  for (const body of [[], null, false, { dailyLossLimit: [] }, { riskPerTrade: [1] }, { maxTrades: 1.5 },
    { aggression: 2.5 }, { lots: '   ' }, { riskPerTrade: 'Infinity' }, { startBalance: {} },
    { riskPerTrade: 0.01 }, { lots: 1e-10 }, { sl: 0.001 }, { tp: 0.001 }]) {
    const response = await request('/api/bot/settings', body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(JSON.stringify(b), before, 'invalid requests must not partially rewrite state');
  }
});

test('invalid or unpriceable paper records block risk instead of being dropped or booked as scratches', () => {
  for (const overrides of [{ lots: NaN }, { lots: 0 }, { dir: 'invalid' }, { entry: NaN }, { costPerSide: Infinity }]) {
    const u = fresh(), b = u.bot, p = position(overrides);
    b.positions = [p]; b.running = true;
    assert.equal(app.riskBudgetFor(b), 0);
    assert.equal(app.closePos(u, 0, 100, 'stopped'), null);
    assert.equal(b.positions.length, 1);
    assert.equal(b.closedTrades, 0);
    assert.equal(b.balance, 100);
    assert.equal(b.running, false);
  }
  for (const field of ['dayPnl', 'dayLoss']) {
    const u = fresh(), b = u.bot; app.rollDay(b); b[field] = NaN;
    assert.equal(app.riskBudgetFor(b), 0, field);
  }
  for (const day of ['2099-01-01', '2020-99-99', false, 0]) {
    const b = fresh().bot; b.lossDay = day;
    app.rollDay(b);
    assert.equal(b.lossDay, day, 'a future/invalid ledger date is not silently rolled into a clean day');
    assert.equal(app.riskBudgetFor(b), 0);
  }
});

test('risk-state writes fsync before/after rename and restrict database file access', () => {
  fresh();
  const original = fs.fsyncSync, calls = [];
  fs.fsyncSync = fd => { calls.push(fd); return original(fd); };
  try { assert.equal(app.saveDb(), true); } finally { fs.fsyncSync = original; }
  assert.equal(calls.length, process.platform === 'win32' ? 1 : 2);
  assert.equal(fs.existsSync(dbPath + '.tmp'), false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(dbPath).mode & 0o777, 0o600);
});

test('a critical fsync failure halts every account and rejects the staged paper entry without inventing P/L', () => {
  const u = fresh(), b = u.bot;
  b.running = true; b.startedAt = Date.now();
  const second = { ...u, id: 'other', bot: app.defaultBot() };
  second.bot.running = true; I.db.users.push(second);
  assert.equal(app.saveDb(), true);
  const before = fs.readFileSync(dbPath, 'utf8'), original = fs.fsyncSync;
  b.pendingEntry = { source: 'sim', at: Date.now(), signal: sig };
  fs.fsyncSync = () => { throw new Error('injected disk sync failure'); };
  try { tick(100); app.evaluate(u); } finally { fs.fsyncSync = original; }
  assert.equal(fs.readFileSync(dbPath, 'utf8'), before);
  assert.equal(I.storageError, 'risk-state-unavailable');
  assert.equal(b.positions.length, 0);
  assert.equal(b.profit, 0);
  assert.equal(b.balance, 100);
  for (const account of I.db.users) {
    assert.equal(account.bot.running, false);
    assert.equal(account.bot.pendingEntry, null);
  }
  assert.equal(app.sizeFor(u, b, 100, 1, 2), 0);
  assert.equal(app.saveDb(), true);
  assert.equal(I.storageError, null);
  assert.equal(b.running, false, 'storage recovery is not an automatic restart');
});

test('HTTP start/settings cannot claim success when risk persistence fails; health reports degradation', async t => {
  const u = fresh(), b = u.bot, request = await http(t, u);
  const obstacle = dbPath + '.tmp'; fs.mkdirSync(obstacle);
  try {
    let response = await request('/api/bot/start', {});
    assert.equal(response.status, 503);
    assert.equal(response.data.error, 'risk-state-unavailable');
    assert.equal(b.running, false);
    response = await request('/api/bot/settings', { preset: 'aggressive' });
    assert.equal(response.status, 503);
    const health = await request('/api/health');
    assert.equal(health.status, 503);
    assert.equal(health.data.ok, false);
    assert.equal(health.data.riskStorageHealthy, false);
  } finally { fs.rmSync(obstacle, { recursive: true, force: true }); }
  assert.equal(app.saveDb(), true);
  const response = await request('/api/bot/start', {});
  assert.equal(response.status, 200);
  assert.equal(b.running, true);
});

test('corrupt databases/risk ledgers are never replaced by fresh balances, users or credentials', () => {
  fresh();
  const good = fs.readFileSync(dbPath, 'utf8'), snapshot = JSON.parse(good);
  for (const raw of ['{broken json', '{}', JSON.stringify({ users: {} }),
    JSON.stringify({ ...snapshot, users: [{ ...snapshot.users[0], bot: null }] }),
    JSON.stringify({ ...snapshot, users: [{ ...snapshot.users[0], bot: { ...snapshot.users[0].bot, positions: {} } }] }),
    ...[null, { version: 999 }, { ...R.newState(), pauseUntil: null }, { ...R.newState(), consecutiveLosses: '0' }]
      .map(risk => JSON.stringify({ ...snapshot, users: [{ ...snapshot.users[0], bot: { ...snapshot.users[0].bot, risk } }] }))]) {
    fs.writeFileSync(dbPath, raw);
    assert.throws(() => app.loadDb(), /Refusing to reset/);
    assert.equal(fs.readFileSync(dbPath, 'utf8'), raw);
    assert.equal(I.db, null);
    assert.equal(fs.existsSync(path.join(dir, 'admin-credentials.txt')), false);
  }
  fs.writeFileSync(dbPath, good); app.loadDb();
  assert.equal(I.db.users.length, 1);
  assert.equal(I.storageError, null);
});

test('an abandoned atomic write fails startup closed even when the main database is missing', () => {
  fresh();
  const good = fs.readFileSync(dbPath, 'utf8'), tmp = dbPath + '.tmp';
  fs.writeFileSync(tmp, '{uncertain write');
  assert.throws(() => app.loadDb(), /Unfinished state write/);
  assert.equal(fs.readFileSync(dbPath, 'utf8'), good);
  fs.unlinkSync(dbPath);
  assert.throws(() => app.loadDb(), /Unfinished state write/);
  assert.equal(fs.existsSync(dbPath), false);
  assert.equal(fs.readFileSync(tmp, 'utf8'), '{uncertain write');
  fs.unlinkSync(tmp); fs.writeFileSync(dbPath, good); app.loadDb();
});

test('client estimates and confirmation obey hard cash/day caps and render a useful risk-hold status', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const between = (a, z) => source.slice(source.indexOf(a), source.indexOf(z, source.indexOf(a) + a.length));
  let html = '', status = '';
  const cancel = { dataset: { tc: 'cancel' } };
  const u = fresh(100000);
  const state = { bot: I.publicBot(u.bot), config: { engine: { riskPolicy: R.POLICY } } };
  const sandbox = { state, Date, document: { querySelector: () => null, querySelectorAll: () => [cancel] },
    money: n => '$' + Number(n).toFixed(2),
    modal: content => { html = content; }, modalDismiss: null, closeModal() {},
    $: id => id === '#risk-guard-status' ? { get textContent() { return status; }, set textContent(v) { status = v; } } : {} };
  vm.createContext(sandbox);
  vm.runInContext(between('function estimatePaperRisk(', 'function selectPreset(') +
    between('function renderRiskGuardStatus(', 'function updateBot(') +
    between('function confirmTrade(', 'async function startEngine(') +
    '\nglobalThis.ui = { estimatePaperRisk, renderRiskGuardStatus, confirmTrade };', sandbox);
  const values = { startBalance: 100000, riskPerTrade: 1.5, maxLossPerTrade: 1e6, dailyLossLimit: 0, compoundProfits: true };
  const estimate = sandbox.ui.estimatePaperRisk(values);
  assert.equal(estimate.perTrade, 1);
  assert.equal(estimate.daily, 3000);
  const confirmation = sandbox.ui.confirmTrade(values);
  cancel.onclick();
  assert.equal(await confirmation, false);
  assert.match(html, /\$1\.00/);
  assert.match(html, /\$3000\.00 UTC-day/);
  assert.doesNotMatch(html, /no daily loss limit/);
  sandbox.ui.renderRiskGuardStatus(state.bot);
  assert.match(status, /No daily trade-count/);
  state.bot.riskStatus.drawdownLatched = true;
  sandbox.ui.renderRiskGuardStatus(state.bot);
  assert.match(status, /No automatic reset/);
  assert.equal(sandbox.ui.estimatePaperRisk(values).perTrade, 0);
  const other = fresh(1000), b = other.bot; b.startedAt = Date.now();
  b.positions = [position({ lots: 0.005, plannedRiskCash: 1 }), position({ lots: 0.005, plannedRiskCash: 1 })];
  state.bot = I.publicBot(b);
  assert.equal(state.bot.openRiskCash, 2);
  assert.equal(sandbox.ui.estimatePaperRisk(values).perTrade, 0, 'client shares actual open-risk reservations');
});

test('legacy stores reconstruct a known recent losing streak instead of starting with a clean pause history', () => {
  const u = fresh(), b = u.bot, now = Date.now();
  Object.assign(b, { balance: 100.4, profit: 0.4, peakProfit: 1, startedAt: now - 60000,
    lossDay: new Date().toISOString().slice(0, 10), dayStartBalance: 100, dayPnl: 0.4, dayLoss: 0,
    trades: [{ pnl: -0.2, at: now }, { pnl: -0.2, at: now - 1000 },
      { pnl: -0.2, at: now - 2000 }, { pnl: 1, at: now - 5000 }] });
  delete b.risk;
  assert.equal(app.saveDb(), true);
  app.loadDb();
  const restored = I.db.users[0].bot;
  assert.equal(restored.risk.peakBalance, 101);
  assert.equal(restored.risk.consecutiveLosses, 3);
  assert.equal(restored.risk.pauseUntil, now + R.POLICY.lossPauseMs);
  assert.equal(app.riskBudgetFor(restored), 0);
});

test('invalid/missing/future quote timestamps and unknown sources never execute a queued entry', () => {
  for (const timestamp of [undefined, NaN, Date.now() + 60000, Date.now() - 9000]) {
    const u = fresh(), b = u.bot;
    b.running = true; b.pendingEntry = { source: 'sim', at: Date.now(), signal: sig };
    I.market.XAUUSD.at = timestamp;
    app.evaluate(u);
    assert.equal(b.positions.length, 0);
    assert.equal(b.closedTrades, 0);
    assert.equal(b.lastProcessedTick, null);
    assert.equal(b.waitingReason, 'stale-market');
  }
  const u = fresh(), b = u.bot;
  b.running = true; b.pendingEntry = { source: 'unknown', at: Date.now(), signal: sig };
  tick(100, 'unknown'); app.evaluate(u);
  assert.equal(b.positions.length, 0);
  b.positions = [position({ lastMid: 101 })];
  I.market.XAUUSD = { price: 100000, source: 'sim', at: NaN };
  const pnl = app.closePos(u, 0, 100000, 'stopped');
  assert.equal(pnl, 0.005, 'only the last known same-source paper mark is usable');
  assert.equal(b.trades[0].staleMark, true);
});

test('backup restores reject risk/balance rollbacks and malformed data without replacing the current database', async t => {
  const u = fresh(), b = u.bot, request = await http(t, u);
  b.startedAt = Date.now();
  const old = structuredClone(I.db);
  lose(u); lose(u); lose(u);
  const risk = structuredClone(b.risk), current = structuredClone(I.db);
  const before = fs.readFileSync(dbPath, 'utf8');
  for (const snapshot of [old, { ...current, users: [{ ...current.users[0], bot: {
    ...current.users[0].bot, risk: { ...R.newState(), peakBalance: 100 } } }] }]) {
    const response = await request('/api/admin/backup/restore', { snapshot });
    assert.equal(response.status, 409);
    assert.equal(response.data.error, 'risk-state-rollback');
    assert.equal(fs.readFileSync(dbPath, 'utf8'), before);
    assert.deepEqual(b.risk, risk);
  }
  const bad = await request('/api/admin/backup/restore', { snapshot: {
    ...current, users: [{ ...current.users[0], bot: { ...current.users[0].bot, positions: {} } }] } });
  assert.equal(bad.status, 400);
  assert.equal(fs.readFileSync(dbPath, 'utf8'), before);
  assert.equal(I.db.users[0], u);
  current.config.profile.about = 'Restored config, current financial ledger retained.';
  const valid = await request('/api/admin/backup/restore', { snapshot: current });
  assert.equal(valid.status, 200);
  assert.deepEqual(I.db.users[0].bot.risk, risk);
  assert.equal(I.db.users[0].bot.balance, b.balance);
  assert.equal(I.db.users[0].bot.running, false);
  assert.match(I.db.config.profile.about, /current financial ledger retained/);
});

test('state reads immediately stop and durably latch newly detected daily or account breaches', async t => {
  const u = fresh(), b = u.bot, request = await http(t, u);
  app.rollDay(b);
  Object.assign(b, { balance: 97, profit: -3, dayPnl: -3, dayLoss: -3,
    dayLimitLatched: false, running: true, startedAt: Date.now() });
  let result = await request('/api/bot/state');
  assert.equal(result.status, 200);
  assert.equal(result.data.bot.running, false);
  assert.equal(result.data.bot.dayLimitLatched, true);
  assert.equal(JSON.parse(fs.readFileSync(dbPath)).users[0].bot.dayLimitLatched, true);
  b.balance = 90; b.profit = -10; b.running = true;
  result = await request('/api/bot/state');
  assert.equal(result.data.bot.running, false);
  assert.equal(result.data.bot.riskStatus.drawdownLatched, true);
  assert.equal(JSON.parse(fs.readFileSync(dbPath)).users[0].bot.risk.drawdownLatched, true);
  app.loadDb();
  assert.equal(I.db.users[0].bot.running, false);
  assert.equal(I.db.users[0].bot.risk.drawdownLatched, true);
  assert.equal(I.db.users[0].bot.dayLimitLatched, true);
});
