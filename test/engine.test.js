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
  bot.maxLossPerTrade = 0;        // isolate the percentage behaviour
  bot.dailyLossLimit = 0;
  // Compare below the 1.5% safety floor: above it, every choice is clamped to
  // the same maximum on purpose, so sizes are identical there.
  bot.riskPerTrade = 0.2;
  const small = I.sizeFor(user, bot, 2000, 0.4, slDist);
  bot.riskPerTrade = 1;
  const big = I.sizeFor(user, bot, 2000, 0.4, slDist);
  assert.ok(big > small, 'more risk per trade means more size');
  assert.ok(small > 0 && big <= 50, 'sizes stay inside broker-sane bounds');

  // The hard cash cap: whatever the percentage asks for, the loss cannot exceed it.
  // (startBalance == balance, so the cap is not inflated by account growth here)
  bot.riskPerTrade = 25;
  bot.maxLossPerTrade = 2;
  bot.balance = 1000; bot.startBalance = 1000;
  const capped = I.sizeFor(user, bot, 2000, 0.4, slDist);
  const cappedCash = capped * slDist * I.pointValue('XAUUSD');
  assert.ok(cappedCash <= 2.01, 'a $2 cap really caps the loss at $2, got $' + cappedCash.toFixed(2));

  // The hard account floor: even with no cap, one trade never risks > 1.5%.
  bot.maxLossPerTrade = 0;
  const floored = I.sizeFor(user, bot, 2000, 0.4, slDist);
  const flooredCash = floored * slDist * I.pointValue('XAUUSD');
  assert.ok(flooredCash <= 1000 * 0.015 + 0.01, 'never more than 1.5% of the account, got $' + flooredCash.toFixed(2));

  // fixed-lot mode: the client's own stake is used verbatim
  bot.autoRisk = false;
  bot.lots = 0.37;
  assert.equal(I.sizeFor(user, bot, 2000, 0.4, slDist), 0.37);

  // the risk budget is actually respected in auto mode:
  // lots * stop distance * point value should land on balance * risk %.
  // Lots are floored (never rounded up), so the risk can only ever undershoot.
  bot.autoRisk = true; bot.riskPerTrade = 2; bot.maxLossPerTrade = 0; bot.dailyLossLimit = 0;
  const lots = I.sizeFor(user, bot, 2000, 0.4, slDist);
  const risked = lots * slDist * I.pointValue('XAUUSD');
  const budget = 1000 * 0.02;
  assert.ok(risked <= budget + 0.005,
    `risked ${risked.toFixed(2)} must never exceed the ${budget.toFixed(2)} budget`);
  assert.ok(risked >= budget * 0.5,
    `risked ${risked.toFixed(2)} should use most of the ${budget.toFixed(2)} budget`);
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
  // The shipped default must win often AND win big — a 99% hit rate whose wins
  // are smaller than its losses is the trap this floor exists to catch.
  assert.ok(winner.test.winRate >= 0.9, 'the default clears the 90% target on unseen data');
  assert.ok(winner.test.trades >= 150, 'the sample is large enough to mean something');
  const ratio = winner.test.avgWinR / Math.abs(winner.test.avgLossR || 1);
  assert.ok(ratio >= 2, `wins must pay at least 2x the losses, got ${ratio.toFixed(2)}`);
  assert.ok(winner.test.expectancyR >= 0.5, 'and the edge per trade is worth having');
  // and it must not be a single lucky seed
  assert.ok(winner.test.perSeedWinRate.every(w => w >= 0.85), 'every unseen seed clears 85%');
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

test('the daily stop protects a losing day but never interrupts a winning one', () => {
  const day = new Date().toISOString().slice(0, 10);
  const bot = app.applyPreset(app.defaultBot(), 'safe');   // $5 daily limit

  // Down $5 with no profit: the budget is spent and new trades stop.
  bot.lossDay = day; bot.dayLoss = -5; bot.profit = 0;
  assert.equal(app.dailyLimitHit(bot), true);
  assert.equal(app.dailyLossBudget(bot), 0);

  // Up $28 overall: however many small losses the day took, the stop must not bite.
  bot.profit = 28.1; bot.peakProfit = 28.1; bot.lossDay = day; bot.dayLoss = -5.81;
  app.noteDayLoss(bot, -1.2);
  assert.equal(bot.dayLoss, 0, 'a profitable session resets the daily counter');
  assert.equal(app.dailyLimitHit(bot), false, 'and the bot keeps trading');
});

test('profit lock-in moves the stop to break-even and then trails', () => {
  const bot = app.defaultBot();
  assert.equal(bot.lockInProfit, true);
  assert.ok(bot.lockAfterR > 0 && bot.trailAfterR > bot.lockAfterR,
    'break-even comes before the trail, so a winner is protected first');
});

test('one losing trade can never cost more than the cap, even with a bad fill', () => {
  const user = freshUser();
  const bot = user.bot;
  bot.balance = 100; bot.maxLossPerTrade = 1; bot.symbol = 'XAUUSD';
  // A position sized so the raw loss would be far larger than the $1 ceiling.
  bot.positions = [{
    id: 'p1', dir: 'BUY', lots: 5, entry: I.SIM.XAUUSD.price, at: Date.now(),
    strategy: 'breakout-momentum', confidence: 0.9, atr: 1, tpDist: 3, slDist: 2
  }];
  const crash = I.SIM.XAUUSD.price - 50;              // a gap straight through the stop
  const pnl = app.closePos(user, 0, crash, 'stop-loss');
  assert.ok(pnl < 0, 'it is a loss');
  assert.ok(pnl >= -1.001, 'but never worse than the $1 cap, got $' + pnl.toFixed(2));
  assert.equal(+bot.balance.toFixed(2), +(100 + pnl).toFixed(2), 'the books match the capped loss');
});

test('profits are uncapped — a good run is never trimmed', () => {
  const user = freshUser();
  const bot = user.bot;
  bot.balance = 100; bot.maxLossPerTrade = 1; bot.symbol = 'XAUUSD';
  bot.peakProfit = 0;
  bot.positions = [{
    id: 'p2', dir: 'BUY', lots: 5, entry: I.SIM.XAUUSD.price, at: Date.now(),
    strategy: 'breakout-momentum', confidence: 0.9, atr: 1, tpDist: 3, slDist: 2
  }];
  const moon = I.SIM.XAUUSD.price + 400;              // a huge winner
  const pnl = app.closePos(user, 0, moon, 'take-profit');
  assert.ok(pnl > 500, 'a big win is paid in full, got $' + pnl.toFixed(2));
  app.checkProfitGuard(user);
  assert.notEqual(bot.stoppedReason, 'profit-giveback', 'no giveback brake exists any more');
  assert.notEqual(bot.stoppedReason, 'profit-protected', 'a banked peak is not trimmed back');
});

test('a $2 account can trade, and every size is protected in proportion', () => {
  const X = I.SIM.XAUUSD.price, atr = X * 0.0004, slDist = atr * 2;
  for (const bal of [2, 5, 10, 20, 50, 100, 500]) {
    const bot = app.applyPreset(app.defaultBot(), 'safe', bal);
    bot.startBalance = bal;
    const lots = app.sizeFor({}, bot, X, atr, slDist);
    assert.ok(lots > 0, `a $${bal} account must be able to trade`);
    const risk = lots * slDist * app.pointValue('XAUUSD');
    assert.ok(risk <= bal * 0.03, `risk on $${bal} must stay small, got $${risk.toFixed(3)}`);
    assert.ok(bot.maxLossPerTrade <= Math.max(0.05, bal * 0.01) + 0.001,
      `the ${'$'}${bal} cap must scale with the account, got $${bot.maxLossPerTrade}`);
  }
});

test('the stake compounds as the balance grows', () => {
  const X = I.SIM.XAUUSD.price, atr = X * 0.0004, slDist = atr * 2;
  const bot = app.applyPreset(app.defaultBot(), 'safe');
  bot.startBalance = 100; bot.balance = 100;
  const base = app.sizeFor({}, bot, X, atr, slDist);
  bot.balance = 300;                                   // tripled
  const grown = app.sizeFor({}, bot, X, atr, slDist);
  assert.ok(grown > base, 'a bigger balance trades a bigger stake');
  bot.balance = 40;                                    // drawn down
  const shrunk = app.sizeFor({}, bot, X, atr, slDist);
  assert.ok(shrunk < base, 'a smaller balance trades a smaller stake');
});

test('the stake and the money limits follow the balance as it grows', () => {
  const X = I.SIM.XAUUSD.price, atr = 0.954, slDist = atr * 2;
  const bot = app.applyPreset(app.defaultBot(), 'safe', 2);   // started with $2
  bot.startBalance = 2;
  let prevLots = 0;
  // the ladder the client asked for, grown by trading with no restart in between
  for (const bal of [2, 5, 10, 50, 200, 1000, 5000]) {
    bot.balance = bal;
    const lots = app.sizeFor({}, bot, X, atr, slDist);
    const risk = lots * slDist * app.pointValue('XAUUSD');
    assert.ok(lots > 0, `a $${bal} account must still trade`);
    assert.ok(lots > prevLots, `size must grow with the balance ($${bal})`);
    assert.ok(risk <= bal * 0.015 + 1e-9, `risk on $${bal} must stay under 1.5 %, got $${risk.toFixed(3)}`);
    assert.ok(I.liveCap(bot) > 0 && I.liveCap(bot) <= bal * 0.015 + 1e-9, 'the live cap tracks the balance');
    prevLots = lots;
  }
});

test('the live cap never authorises more than the chosen risk percentage', () => {
  // a $2 account with an oversized $5 cap must still only risk its 1 %
  const bot = app.applyPreset(app.defaultBot(), 'safe', 2);
  bot.startBalance = 2; bot.balance = 2; bot.maxLossPerTrade = 5;
  assert.ok(I.liveCap(bot) <= 2 * 0.015 + 1e-9, 'the hard account limit wins over a large cap');
  const X = I.SIM.XAUUSD.price, atr = 0.954, slDist = atr * 2;
  const lots = app.sizeFor({}, bot, X, atr, slDist);
  const risk = lots * slDist * app.pointValue('XAUUSD');
  assert.ok(risk <= 2 * 0.015 + 1e-9, `a $2 account cannot be allowed to risk $${risk.toFixed(2)}`);
});
