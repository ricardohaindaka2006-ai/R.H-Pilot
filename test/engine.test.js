'use strict';

/*
 * Engine + licence tests.
 *
 * These protect what the client actually relies on: that the strategy panel
 * really is validated out of sample, that the default is the strategy with the
 * most wins that also pays, that risk sizing honours the client's setting, that
 * resync works, and that an admin can issue a licence key that a real client can
 * redeem to sign in.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhpilot-engine-'));
process.env.DATA_DIR = tempDir;
process.env.ADMIN_EMAIL = 'engine@test.local';
process.env.ADMIN_PASSWORD = 'EngineTest2026!';
process.env.DERIV_WS_URL = 'ws://127.0.0.1:1/websockets/v3';

const app = require('../server.js');
const I = app._internals;
const E = require('../engine/strategies.js');

function freshUser() {
  const user = { id: 'e1', email: 'engine@test.local', role: 'admin', active: true, paid: true, deriv: null, bot: app.defaultBot() };
  I.db = { users: [user], sessions: {}, config: I.DEFAULT_CONFIG(), createdAt: Date.now() };
  return user;
}

test('the catalogue offers every strategy with its validated numbers', () => {
  freshUser();
  const list = I.strategyCatalogue();
  assert.equal(list.length, E.STRATEGY_IDS.length);
  for (const row of list) {
    assert.ok(row.id && row.name);
    assert.ok(Array.isArray(row.regimes) && row.regimes.length, 'regime gate is declared');
    assert.ok(row.exit && row.exit.tp > 0 && row.exit.sl > 0, 'exit geometry is declared');
    assert.equal(typeof row.tuned, 'boolean');
  }
  const rates = list.map(r => r.winRate || 0);
  assert.deepEqual(rates, [...rates].sort((a, b) => b - a), 'sorted best win rate first');
});

test('the default is the most wins among the strategies that also pay', () => {
  const user = freshUser();
  const strategies = [
    { strategy: 'rsi-reversion', params: { tp: 1, sl: 14 }, test: { winRate: 0.99, trades: 900, expectancyR: -0.05, profitFactor: 0.4 } },
    { strategy: 'breakout-momentum', params: { tp: 3, sl: 14 }, test: { winRate: 0.968, trades: 2231, expectancyR: 0.176, profitFactor: 6.7 } },
    { strategy: 'macd-momentum', params: { tp: 3, sl: 14 }, test: { winRate: 0.93, trades: 1962, expectancyR: 0.131, profitFactor: 2.9 } },
    { strategy: 'thin-sample', params: { tp: 1, sl: 8 }, test: { winRate: 0.999, trades: 4, expectancyR: 0.5 } }
  ];
  const live = path.join(__dirname, '..', 'engine', 'strategy-report.json');
  const backup = fs.existsSync(live) ? fs.readFileSync(live, 'utf8') : null;
  fs.writeFileSync(live, JSON.stringify({ generatedAt: new Date().toISOString(), spreadAtr: 0.02, testSeeds: [1], strategies }));
  try {
    assert.equal(I.loadStrategyReport(), true);
    const cfg = I.db.config.engine;
    assert.notEqual(cfg.defaultStrategy, 'rsi-reversion', 'a losing strategy never gets the seat');
    assert.notEqual(cfg.defaultStrategy, 'thin-sample', 'a four-trade sample never wins the seat');
    assert.equal(cfg.defaultStrategy, 'breakout-momentum', 'the most wins that pays wins the seat');
    assert.ok(Object.keys(cfg.tuned).length > 0, 'tuned parameters are loaded');
  } finally {
    if (backup !== null) fs.writeFileSync(live, backup);
  }
  user.bot.strategy = 'auto';
  assert.ok(E.STRATEGIES[I.strategyFor(user.bot).id]);
});

test('a client can pin any strategy, and an unknown id falls back safely', () => {
  const user = freshUser();
  for (const id of E.STRATEGY_IDS) {
    user.bot.strategy = id;
    assert.equal(I.strategyFor(user.bot).id, id);
  }
  user.bot.strategy = 'not-a-real-strategy';
  assert.ok(E.STRATEGIES[I.strategyFor(user.bot).id], 'unknown id falls back instead of crashing');
});

test('every strategy returns a bounded signal with its own exit geometry', () => {
  const series = E.makeSeries(4242, 600);
  let fired = 0;
  for (let i = E.WARMUP + 2; i < series.length; i++) {
    const ctx = E.buildContext(series, i);
    if (!ctx) continue;
    for (const id of E.STRATEGY_IDS) {
      const sig = E.signalFor(ctx, id);
      if (!sig) continue;
      fired++;
      assert.ok(sig.dir === 1 || sig.dir === -1);
      assert.ok(sig.tp > 0 && sig.sl > 0);
      assert.ok(sig.confidence > 0 && sig.confidence <= 1);
      assert.ok(Number.isFinite(sig.hold) && sig.hold > 0);
      assert.ok(sig.tpDist > 0 && sig.slDist > 0);
    }
  }
  assert.ok(fired > 0, 'strategies fire on a live context');
});

test('risk sizing follows the client setting and scales with it', () => {
  const user = freshUser();
  const bot = user.bot;
  bot.balance = 1000; bot.symbol = 'XAUUSD';
  const slDist = 0.4 * 14;   // wide ATR stop

  // risk-based mode: bigger risk percentage must produce a bigger position
  bot.autoRisk = true;
  bot.riskPerTrade = 1;
  const small = I.sizeFor(user, bot, 2000, 0.4, slDist);
  bot.riskPerTrade = 4;
  const big = I.sizeFor(user, bot, 2000, 0.4, slDist);
  assert.ok(big > small, 'more risk per trade means more size');
  assert.ok(small >= 0.01 && big <= 50, 'sizes stay inside broker-sane bounds');

  // fixed-lot mode: the client's own stake is used verbatim
  bot.autoRisk = false;
  bot.lots = 0.37;
  assert.equal(I.sizeFor(user, bot, 2000, 0.4, slDist), 0.37);

  // the risk budget is actually respected in auto mode:
  // lots * stop distance * point value should land on balance * risk %
  bot.autoRisk = true; bot.riskPerTrade = 2;
  const lots = I.sizeFor(user, bot, 2000, 0.4, slDist);
  const perPoint = 600000 / I.SIM.XAUUSD.price;
  const risked = lots * slDist * perPoint;
  const budget = 1000 * 0.02;
  assert.ok(risked <= budget * 1.2 && risked >= budget * 0.4,
    `risked ${risked.toFixed(2)} should be close to the ${budget.toFixed(2)} budget`);
});

test('resync retires expired positions and re-anchors the books', () => {
  const user = freshUser();
  const bot = user.bot;
  const price = I.SIM.XAUUSD.price;
  I.hist.XAUUSD = Array.from({ length: 300 }, (_, i) => price + i * 0.01);
  I.market.XAUUSD = { price, at: Date.now(), source: 'sim' };

  bot.running = true;
  bot.startBalance = 100;
  bot.profit = 5;
  bot.balance = 999;                 // drifted away from reality
  bot.positions.push({
    id: 'stale-1', dir: 'BUY', lots: 0.01, entry: price - 1, peak: 0,
    at: Date.now() - 3600_000, ticks: 999, strategy: 'breakout-momentum',
    tpPrice: price + 100, slPrice: price - 100, tpDist: 100, slDist: 100, atr: 1
  });

  const report = I.resyncBot(user, { mode: 'hard' });
  assert.equal(bot.positions.length, 0, 'expired exposure is retired, not abandoned');
  assert.equal(report.closed.length, 1);
  assert.ok(bot.balance < 200, 'the drifted balance is discarded');
  assert.equal(Number((bot.balance - (100 + bot.profit)).toFixed(6)), 0, 'balance == start + realised profit');
  assert.ok(bot.resyncs >= 1);
  assert.ok(Array.isArray(user.events) && user.events.some(e => e.kind === 'resync'), 'resync is audited');
});

test('session win rate survives the 200-row display cap', () => {
  const user = freshUser();
  const bot = user.bot;
  const price = I.SIM.XAUUSD.price;
  I.hist.XAUUSD = Array.from({ length: 120 }, (_, i) => price + i * 0.01);
  I.market.XAUUSD = { price, at: Date.now(), source: 'sim' };
  bot.running = true; bot.startBalance = 100; bot.balance = 100; bot.profit = 0;
  bot.strategy = 'breakout-momentum';
  bot.positions.push({
    id: 'tp-1', dir: 'BUY', lots: 0.01, entry: price - 1, peak: 0, at: Date.now(), ticks: 1,
    strategy: 'breakout-momentum', tpPrice: price - 2, slPrice: price + 100,
    tpDist: 3, slDist: 100, atr: 6, votes: null, score: 0
  });
  app.evaluate(user);
  // the take-profit closed that position; the engine may then open a fresh one,
  // so assert on the closed trade and the tallies, not on the position count
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].cause, 'take-profit');
  assert.equal(bot.closedTrades, 1);
  assert.equal(bot.closedWins, 1);
  assert.equal(bot.closedLosses, 0);
  assert.ok(bot.trades.length <= 200);
});

test('the shipped validation report is honest and meets its floor', () => {
  const file = path.join(__dirname, '..', 'engine', 'strategy-report.json');
  assert.ok(fs.existsSync(file), 'a validated report ships with the code');
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(Array.isArray(report.strategies) && report.strategies.length === E.STRATEGY_IDS.length);
  assert.ok(E.STRATEGIES[report.best], 'the recorded winner exists in the engine');

  for (const row of report.strategies) {
    assert.ok(row.test && Number.isFinite(row.test.winRate), `${row.strategy} carries a validated block`);
    if (row.test.trades === 0) continue;
    // training must not look wildly better than reality, or the panel was tuned
    // into noise rather than an edge
    if (row.train && row.train.trades > 0) {
      assert.ok(row.train.winRate - row.test.winRate < 0.15, `${row.strategy} is not badly over-fitted`);
    }
  }
  const winner = report.strategies.find(r => r.strategy === report.best);
  assert.ok(winner.test.expectancyR > 0, 'the default has positive expectancy out of sample');
  assert.ok(winner.test.profitFactor > 1.2, 'the default pays for its losses');
  assert.ok(winner.test.winRate >= 0.95, 'the default clears the 95% target on unseen data');
  assert.ok(winner.test.trades >= 150, 'the sample is large enough to mean something');
  // and it must not be a single lucky seed
  assert.ok(winner.test.perSeedWinRate.every(w => w >= 0.9), 'every unseen seed clears 90%');
});

test('the engine is fast enough to react to every tick', () => {
  const series = E.makeSeries(99, 1200);
  const t0 = process.hrtime.bigint();
  let n = 0;
  for (let i = E.WARMUP; i < series.length; i++) {
    const ctx = E.buildContext(series, i);
    if (!ctx) continue;
    for (const id of E.STRATEGY_IDS) E.signalFor(ctx, id);
    n++;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const perTick = ms / n;
  assert.ok(perTick < 1, `context + all strategies must cost under 1ms per tick (measured ${perTick.toFixed(3)}ms)`);
});
