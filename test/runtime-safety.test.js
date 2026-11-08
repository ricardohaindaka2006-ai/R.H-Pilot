'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhpilot-safety-'));
process.env.DATA_DIR = dir;
process.env.DERIV_WS_URL = 'ws://127.0.0.1:1';
const app = require('../server.js'), I = app._internals, E = I.ENGINE, P = E.EXECUTION;
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const sig = { strategy: 'breakout-momentum', dir: 1, confidence: 0.9, atr: 1,
  tp: 6, sl: 2, tpDist: 6, slDist: 2, be: 0.99, hold: 20 };

function fresh() {
  const user = { id: 's1', email: 'safety@test.local', role: 'admin', active: true, paid: true,
    deriv: null, bot: app.defaultBot() };
  I.db = { users: [user], sessions: {}, config: I.DEFAULT_CONFIG() };
  I.hist.XAUUSD = [];
  tick(100);
  return user;
}
function tick(price, source = 'sim') {
  I.market.XAUUSD = { price, source, at: Date.now(), epoch: Math.floor(Date.now() / 1000) };
  app.notePrice('XAUUSD', price, source);
}
function position(overrides = {}) {
  return { ...P.paperPosition(sig, 100, { spreadAtr: 0, slippageAtr: 0 }),
    id: 'p', strategy: sig.strategy, marketSource: 'sim', lots: 0.005, at: Date.now(), ...overrides };
}

test('timer re-evaluations do not age a position; an unchanged quote on a new tick does', () => {
  const user = fresh(), p = position();
  user.bot.positions = [p]; user.bot.running = false;
  app.evaluate(user);
  assert.equal(p.ticks, 1);
  for (let i = 0; i < 10; i++) { app.evaluate(user); app.evaluateSymbol('XAUUSD'); }
  assert.equal(p.ticks, 1);
  const length = I.hist.XAUUSD.length;
  tick(100);
  app.evaluate(user);
  assert.equal(p.ticks, 2);
  assert.equal(I.hist.XAUUSD.length, length + 1, 'equal-price ticks are retained');
});

test('a stopped bot still manages remaining paper exposure', () => {
  const user = fresh();
  user.bot.running = false;
  user.bot.positions = [position({ tpPrice: 101 })];
  tick(102); app.evaluateSymbol('XAUUSD');
  assert.equal(user.bot.positions.length, 0);
  assert.equal(user.bot.trades[0].cause, 'take-profit');
  assert.equal(user.bot.profit, 1);
});

test('a profit target stops entries without abandoning a second open position', () => {
  const user = fresh();
  user.bot.running = true; user.bot.profitTarget = 0.5;
  const remaining = position({ id: 'remaining', tpPrice: 120, slPrice: 90 });
  user.bot.positions = [remaining, position({ id: 'winner', tpPrice: 101 })];
  tick(102); app.evaluate(user);
  assert.equal(user.bot.running, false);
  assert.equal(user.bot.positions.length, 1);
  tick(89); app.evaluateSymbol('XAUUSD');
  assert.equal(user.bot.positions.length, 0, 'the stopped bot keeps enforcing exits');
  assert.equal(user.bot.closedTrades, 2);
  assert.equal(user.bot.pendingEntry, null);
});

test('open positions reserve portfolio risk and the remaining daily budget', () => {
  const user = fresh(), b = user.bot;
  b.riskPerTrade = 1.5; b.maxLossPerTrade = 0; b.dailyLossLimit = 0;
  for (let i = 0; i < 2; i++) {
    const lots = app.sizeFor(user, b, 100, 1, 2);
    assert.ok(lots > 0);
    b.positions.push(position({ id: String(i), lots }));
  }
  assert.ok(app.openRiskCash(b) <= 3 + 1e-9);
  assert.equal(app.sizeFor(user, b, 100, 1, 2), 0, 'the third trade cannot overbook the 3% portfolio budget');
  b.positions = [position({ lots: 0.00375 })]; // $0.75 reserved
  b.dailyLossLimit = 1;
  const lots = app.sizeFor(user, b, 100, 1, 2);
  assert.ok(lots * 200 <= 0.25 + 1e-9, 'daily budget is shared, not allocated afresh to every position');
});

test('equity growth is not multiplied into the chosen risk percentage twice', () => {
  const user = fresh(), b = user.bot;
  b.balance = 200; b.startBalance = 100; b.riskPerTrade = 0.5; b.maxLossPerTrade = 0; b.dailyLossLimit = 0;
  const lots = app.sizeFor(user, b, 100, 1, 2);
  assert.ok(lots * 200 <= 1 + 1e-9, '0.5% of $200 is $1, not $2');
  assert.ok(lots > 0);
});

test('micro lots use exactly their sized notional, not an inflated minimum contract', () => {
  const user = fresh();
  assert.equal(app.contractSize('XAUUSD', { lots: 0.00005 }), 0.005);
  user.bot.positions = [position({ lots: 0.00005 })];
  const pnl = app.closePos(user, 0, 90, 'stop-loss');
  assert.ok(Math.abs(pnl + 0.05) < 1e-12);
});

test('empty or non-finite equity cannot invent a fallback bankroll', () => {
  for (const balance of [0, -1, NaN, Infinity, 'invalid']) {
    const user = fresh();
    user.bot.balance = balance; user.bot.running = true;
    assert.equal(app.sizeFor(user, user.bot, 100, 1, 2), 0);
    app.evaluate(user);
    assert.equal(user.bot.positions.length, 0);
    assert.equal(user.bot.running, false);
  }
});

test('source transitions reset history and never book a simulator/live price jump as profit', () => {
  const user = fresh();
  tick(100, 'live'); tick(101, 'live');
  user.bot.positions = [position({ marketSource: 'live', lastMid: 101 })];
  user.bot.running = true;
  tick(500, 'sim');
  assert.deepEqual(I.hist.XAUUSD, [500]);
  app.evaluate(user);
  assert.equal(user.bot.positions.length, 0);
  assert.equal(user.bot.trades[0].cause, 'market-source-changed');
  assert.equal(user.bot.profit, 0.5, 'only the last same-source mark is used for the paper close');
  assert.equal(user.bot.pendingEntry, null);
});

test('stale quotes do not advance exits, time limits or signals', () => {
  const user = fresh(), p = position({ holdTicks: 1 });
  user.bot.positions = [p]; user.bot.running = true;
  I.market.XAUUSD.at = Date.now() - 9000;
  app.evaluate(user);
  assert.equal(p.ticks, 0);
  assert.equal(user.bot.trades.length, 0);
  assert.equal(user.bot.waitingReason, 'stale-market');
  tick(100); app.evaluate(user);
  assert.equal(user.bot.trades[0].cause, 'time-stop');
});

test('tick-triggered evaluation enforces license expiry even with a stale browser session', () => {
  const user = fresh();
  user.role = 'user'; user.licenseExpiresAt = Date.now() - 1;
  user.bot.running = true; user.bot.positions = [position()];
  app.evaluateSymbol('XAUUSD');
  assert.equal(user.bot.running, false);
  assert.equal(user.bot.stoppedReason, 'license-expired');
  assert.equal(user.bot.positions.length, 0);
});

test('practice outcomes cannot silently change another account’s fixed-weight decisions', () => {
  fresh();
  I.hist.XAUUSD = E.makeSeries(12, 140);
  tick(I.hist.XAUUSD.at(-1));
  const before = I.marketContext('XAUUSD');
  for (let i = 0; i < 100; i++) app.learnFrom({ trend: 1, momentum: 1, breakout: 1, reversal: -1 }, true, 1);
  const after = I.marketContext('XAUUSD');
  assert.deepEqual(after, before);
  assert.equal(I.db.config.engine.adaptiveEnabled, false);
});

test('legacy broker exposure is preserved by stop, resync and log trimming without synthetic settlement', () => {
  const user = fresh();
  user.deriv = { loginid: 'CR1', token: 'fake', isVirtual: false };
  user.bot.running = true;
  user.bot.positions = Array.from({ length: 25 }, (_, i) => position({ id: String(i), contractId: i + 1 }));
  app.flattenBot(user, 'stopped');
  assert.equal(user.bot.running, false);
  assert.equal(user.bot.positions.length, 25, 'no contract identifier is forgotten');
  assert.equal(user.bot.profit, 0);
  assert.equal(user.bot.trades.length, 0);
  assert.equal(I.resyncBot(user).reconciliationRequired, true);
  app.slimDb();
  assert.equal(user.bot.positions.length, 25);
  assert.ok(user.bot.positions.every(p => p.reconciliationRequired));
});

test('restart loading disarms persisted live flags and preserves uncertain contracts', () => {
  const user = fresh();
  user.bot.live = true; user.bot.running = true;
  user.bot.positions = [position({ execution: undefined, livePending: true })];
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(I.db));
  app.loadDb();
  const restored = I.db.users[0].bot;
  assert.equal(restored.live, false);
  assert.equal(restored.running, false);
  assert.equal(restored.positions.length, 1);
  assert.equal(restored.positions[0].reconciliationRequired, true);
  assert.equal(restored.pendingEntry, null);
});

test('balance selection uses the exact account ID, not the first account of the same type', () => {
  const user = fresh();
  user.deriv = { loginid: 'CR-small', isVirtual: false, balance: 2, accounts: [
    { loginid: 'CR-large', isVirtual: false, balance: 10000 },
    { loginid: 'CR-small', isVirtual: false, balance: 2 }
  ] };
  assert.equal(I.detectLinkedBalance(user), 2);
});

test('a missing requested broker account never falls back silently to another account', async () => {
  fresh();
  const original = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ data: [
    { account_id: 'OTHER', account_type: 'demo', status: 'active', balance: 10000 }
  ] }), { status: 200 });
  try { await assert.rejects(app.derivFetchAccount('fake-token', 'CR-missing'), /deriv-requested-account-unavailable/); }
  finally { global.fetch = original; }
});

test('resync cannot re-arm a stopped target or clear a daily loss latch', () => {
  const user = fresh(), b = user.bot;
  b.running = false; b.targetHit = { at: Date.now(), target: 50 }; b.profitTarget = 50;
  b.dayLimitLatched = true; b.lossDay = new Date().toISOString().slice(0, 10);
  b.lastEntryAt = Date.now(); const cooldown = b.lastEntryAt;
  I.resyncBot(user, { mode: 'hard' });
  assert.equal(b.running, false);
  assert.ok(b.targetHit);
  assert.equal(b.dayLimitLatched, true);
  assert.equal(b.lastEntryAt, cooldown);
});

test('a latched daily stop cannot be bypassed by disabling the numeric daily limit', () => {
  const user = fresh(), b = user.bot;
  app.rollDay(b); b.dayLimitLatched = true; b.dailyLossLimit = 0;
  assert.equal(app.dailyLimitHit(b), true);
  assert.equal(app.dailyLossBudget(b), 0);
  assert.equal(app.sizeFor(user, b, 100, 1, 2), 0);
});

test('manual paper stops also refuse to bridge a live/sim source jump', () => {
  const user = fresh();
  user.bot.positions = [position({ marketSource: 'live', lastMid: 101 })];
  tick(500, 'sim');
  app.flattenBot(user, 'stopped');
  assert.equal(user.bot.profit, 0.5);
  assert.equal(user.bot.trades[0].staleMark, true);
  assert.equal(user.bot.trades[0].exit, 101);
});

test('the runtime paper fill and exit match the backtest on the same first trade', () => {
  const user = fresh(), b = user.bot;
  const def = E.STRATEGIES['breakout-momentum'], fn = def.fn, regimes = def.regimes;
  const series = Array.from({ length: 94 }, (_, i) => 100 + (i % 2) * 0.2);
  series[90] = 100; series[91] = 105;
  def.fn = () => ({ dir: 1, confidence: 1 });
  def.regimes = ['trend', 'range', 'mixed', 'volatile'];
  I.db.config.engine.revertHostile = [];
  b.running = true; b.strategy = 'breakout-momentum';
  try {
    const [expected] = E.backtest(series, 'breakout-momentum');
    I.hist.XAUUSD = series.slice(0, E.WARMUP);
    tick(series[E.WARMUP]); app.evaluate(user);
    assert.ok(b.pendingEntry);
    tick(series[90]); app.evaluate(user);
    assert.equal(b.positions.length, 1);
    const risk = b.positions[0].slDist * app.contractSize('XAUUSD', b.positions[0]);
    assert.equal(b.positions[0].entry, expected.entry);
    tick(series[91]); app.evaluate(user);
    assert.equal(b.trades[0].cause, expected.reason);
    assert.equal(b.trades[0].exit, expected.exit);
    assert.ok(Math.abs(b.trades[0].pnl / risk - expected.r) < 1e-9);
  } finally { def.fn = fn; def.regimes = regimes; }
});

test('resync refuses to create money when the starting ledger is corrupt', () => {
  const user = fresh();
  user.bot.startBalance = NaN; user.bot.balance = 0; user.bot.running = true;
  const result = I.resyncBot(user, { mode: 'hard' });
  assert.equal(user.bot.balance, 0);
  assert.equal(user.bot.running, false);
  assert.match(result.advice, /cannot invent a bankroll/);
});

test('a forged demo flag cannot route a real account through the demo transport helper', async () => {
  fresh();
  const original = global.fetch;
  let otp = 0;
  global.fetch = async url => {
    if (String(url).endsWith('/otp')) { otp++; throw new Error('must-not-request-otp'); }
    return new Response(JSON.stringify({ data: [{ account_id: 'CR-real', account_type: 'real', status: 'active', currency: 'USD', balance: 100 }] }), { status: 200 });
  };
  try {
    await assert.rejects(app.derivPlaceTrade({ token: 'fake', loginid: 'CR-real', isVirtual: true },
      { symbol: 'VOL10', direction: 'BUY', stake: 1 }), /broker-reconciliation-required/);
    assert.equal(otp, 0);
  } finally { global.fetch = original; }
});

test('filling missing legacy geometry never loosens an existing stop or replaces an existing target', () => {
  for (const dir of [1, -1]) {
    const user = fresh(), b = user.bot;
    const p = { ...P.paperPosition({ ...sig, dir }, 100, { spreadAtr: 0, slippageAtr: 0 }),
      id: 'legacy', strategy: sig.strategy, marketSource: 'sim', lots: 0.00005,
      slDist: undefined, tpDist: undefined, beTriggered: true,
      slPrice: 100 + dir, tpPrice: 100 + dir * 20 };
    b.positions = [p];
    tick(100 + dir * 0.5); app.evaluate(user);
    assert.equal(b.positions.length, 0, 'the saved profit stop still triggers on this quote');
    assert.equal(b.trades[0].cause, 'profit-locked');
    assert.ok(b.trades[0].pnl > 0);

    const q = { ...P.paperPosition({ ...sig, dir }, 100, { spreadAtr: 0, slippageAtr: 0 }),
      id: 'legacy-target', strategy: sig.strategy, marketSource: 'sim', lots: 0.00005,
      slDist: undefined, tpDist: undefined, slPrice: 100 - dir * 10, tpPrice: 100 + dir * 3 };
    b.positions = [q];
    tick(100 + dir * 3.5); app.evaluate(user);
    assert.equal(b.positions.length, 0);
    assert.equal(b.trades[0].cause, 'take-profit');
    assert.equal(q.slDist, 10);
    assert.equal(q.tpDist, 3);
  }
});
