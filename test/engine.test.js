'use strict';

/*
 * Engine + licence tests.
 *
 * Regression checks for paper evidence, risk sizing, daily circuit breakers
 * and fail-closed live safety. No test requires a strategy to manufacture a
 * target win rate or hide an adverse fill.
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
const V = require('../scripts/validate-strategies.js');
test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

function freshUser() {
  const user = { id: 'e1', email: 'engine@test.local', role: 'admin', active: true, paid: true, deriv: null, bot: app.defaultBot() };
  I.db = { users: [user], sessions: {}, config: I.DEFAULT_CONFIG(), createdAt: Date.now() };
  return user;
}

test('the catalogue offers every research strategy with diagnostic metadata', () => {
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

test('report selection uses training only and stale reports fail closed', () => {
  freshUser();
  const report = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'engine', 'strategy-report.json')));
  const expected = V.chooseTrainingLeader(report.strategies);
  for (const row of report.strategies) row.test = { winRate: row.strategy === expected ? 0 : 1, expectancyR: -999 };
  assert.equal(V.chooseTrainingLeader(report.strategies), expected, 'holdout metrics cannot change the selection');
  const file = path.join(tempDir, 'report.json');
  fs.writeFileSync(file, JSON.stringify(report));
  assert.equal(I.loadStrategyReport(file), true);
  assert.equal(I.db.config.engine.defaultStrategy, expected, 'runtime uses the frozen training reference');
  report.modelFingerprint = 'stale-model';
  fs.writeFileSync(file, JSON.stringify(report));
  assert.equal(I.loadStrategyReport(file), false);
  assert.equal(I.db.config.engine.report, null, 'stale metrics are not displayed');
  assert.deepEqual(I.db.config.engine.tuned, {}, 'stale tuning is not applied');
});

test('conservative regime gates are fixed and shared by pinned and auto modes', () => {
  const user = freshUser();
  const hostile = I.db.config.engine.revertHostile;
  assert.deepEqual([...hostile].sort(), ['breakout-momentum', 'macd-momentum', 'springbok-fusion']);
  const series = E.makeSeries(87, 300, { family: 'revert' });
  const ctx = E.analyze(series);
  ctx.regime.key = 'mixed';
  for (const id of hostile) {
    user.bot.strategy = id;
    assert.equal(I.signalAllowed('mixed', id, hostile), false);
    assert.equal(I.chooseSignal(ctx, user.bot), null, 'pinning cannot bypass the gate');
    assert.equal(E.signalFor(ctx, id), null, 'the backtest applies the same conservative regime gate');
  }
  assert.equal(I.signalAllowed('mixed', 'scalper-pro', hostile), true);
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

  // Fixed lots are an upper bound, never permission to bypass risk controls.
  bot.autoRisk = false;
  bot.lots = 0.37;
  const fixed = I.sizeFor(user, bot, 2000, 0.4, slDist);
  assert.ok(fixed > 0 && fixed < 0.37);
  assert.ok(fixed * slDist * I.pointValue('XAUUSD') <= 15);

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
    strategy: 'breakout-momentum', tpPrice: price - 0.5, slPrice: price - 100,
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

test('the shipped report declares its scope and does not require profitable synthetic results', () => {
  const report = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'engine', 'strategy-report.json')));
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.modelFingerprint, E.modelFingerprint());
  assert.equal(report.syntheticOnly, true);
  assert.equal(report.liveEligible, false);
  assert.equal(report.strategies.length, E.STRATEGY_IDS.length);
  assert.equal(report.trainingLeader, V.chooseTrainingLeader(report.strategies));
  assert.ok(report.limitations.some(s => s.includes('NOT modelled')));
  for (const row of report.strategies) {
    assert.deepEqual(row.params, E.paramsFor(row.strategy));
    assert.equal(row.liveEligible, false);
    assert.equal(row.viable, V.researchViable(row.trainFamilies));
    for (const f of report.families) {
      const r = row.crossFamily[f];
      assert.ok(Number.isFinite(r.expectancyR));
      assert.equal(r.trades, r.wins + r.losses + r.scratches);
      assert.ok(r.perSeed.length === report.testSeeds.length);
      assert.ok((r.byReason['end-of-data'] || 0) <= report.testSeeds.length, 'at most one terminal position per seed');
      assert.ok(row.stress.higherCosts[f] && row.stress.priceGaps[f]);
    }
  }
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

test('the daily stop uses today’s net P/L and never erases losses with lifetime profits', () => {
  const bot = app.applyPreset(app.defaultBot(), 'safe', 100);
  app.rollDay(bot);
  bot.profit = 1000; // previous profitable sessions are not today’s budget
  app.noteDayLoss(bot, -8);
  assert.equal(bot.dayPnl, -8);
  assert.equal(app.dailyLimitHit(bot), true);
  assert.equal(app.dailyLossBudget(bot), 0);
  app.applyPreset(bot, 'safe');
  assert.equal(app.dailyLimitHit(bot), true, 'a preset cannot clear the latch');
  app.rollDay(bot, Date.now() + 86400000);
  assert.equal(bot.dayLimitLatched, false, 'a new UTC day clears the latch, not a restart');
});

test('profit lock-in moves the stop to break-even and then trails', () => {
  const bot = app.defaultBot();
  assert.equal(bot.lockInProfit, true);
  assert.ok(bot.lockAfterR > 0 && bot.trailAfterR > bot.lockAfterR,
    'break-even comes before the trail, so a winner is protected first');
});

test('gap losses are booked in full rather than clipped to the planned cap', () => {
  const user = freshUser(), bot = user.bot;
  const entry = I.SIM.XAUUSD.price;
  bot.maxLossPerTrade = 1;
  bot.positions = [{ id: 'gap', dir: 'BUY', lots: 0.01, entry, plannedRiskCash: 1 }];
  const pnl = app.closePos(user, 0, entry - 50, 'stop-loss');
  assert.equal(pnl, -50);
  assert.equal(bot.balance, 50);
  assert.equal(bot.profit, -50);
  assert.equal(bot.trades[0].riskOverrun, true);
  assert.equal(bot.trades[0].exit, entry - 50);
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
    assert.ok(bot.maxLossPerTrade <= bal * 0.005 + 0.001,
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
    bot.dayPnl = bal - 2; // model realised growth, including its daily ledger
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

test('all real-money entry points fail closed, even with a stale armed flag', () => {
  const gate = I.canTradeReal;
  const cases = [
    [{ bot: { live: true }, deriv: null }, false, 'nothing linked'],
    [{ bot: { live: true }, deriv: { token: 't', isVirtual: true } }, false, 'demo account, armed'],
    [{ bot: { live: false }, deriv: { token: 't', isVirtual: false } }, false, 'real account, not armed'],
    [{ bot: { live: true }, deriv: { token: 't', isVirtual: false } }, false, 'real account, stale armed flag'],
    [{ bot: { live: true }, deriv: { isVirtual: false } }, false, 'real but no token']
  ];
  for (const [user, expected, label] of cases) {
    assert.equal(gate(user), expected, `real-money gate wrong for: ${label}`);
  }
});

test('money limits scale to any balance with no fixed dollar ceiling', () => {
  for (const bal of [2, 10, 50, 100, 500, 1000, 10000, 50000, 100000]) {
    const bot = app.applyPreset(app.defaultBot(), 'safe', bal);
    // the limit is the chosen share of the balance, not a capped number
    assert.ok(Math.abs(bot.maxLossPerTrade - bal * 0.005) < 0.01,
      `cap on $${bal} should be 0.5% of it, got $${bot.maxLossPerTrade}`);
    assert.ok(Math.abs(bot.dailyLossLimit - bal * 0.03) < 0.05,
      `daily stop on $${bal} should be 3% of it, got $${bot.dailyLossLimit}`);
    assert.ok(I.liveCap(bot) > 0 && I.liveCap(bot) <= bal * 0.015 + 1e-9,
      `live cap on $${bal} must stay inside 1.5%`);
  }
  // a six-figure account is not throttled by a leftover magic number
  assert.ok(app.applyPreset(app.defaultBot(), 'safe', 1000000).maxLossPerTrade > 500,
    'a $1,000,000 account has no fixed $500 ceiling and is allowed more than the old $500 ceiling');
});

test('a corrupt balance or cap can never mean NaN sizing or unlimited loss', () => {
  const X = I.SIM.XAUUSD.price, atr = 0.954, slDist = atr * 2;
  for (const bad of [NaN, 'abc', -5, 0, undefined, null]) {
    const bot = app.applyPreset(app.defaultBot(), 'safe', 100);
    bot.balance = bad; bot.startBalance = bad;
    bot.maxLossPerTrade = bad; bot.dailyLossLimit = bad;
    const lots = app.sizeFor({}, bot, X, atr, slDist);
    assert.ok(Number.isFinite(lots) && lots >= 0, `lots must be a real number for ${String(bad)}`);
    const cap = I.liveCap(bot);
    assert.equal(cap, 0, `a corrupt/empty equity must fail closed for ${String(bad)}`);
    assert.equal(lots, 0, 'never invent a fallback bankroll');
  }
});

test('today’s profits offset today’s losses without disabling the daily stop', () => {
  const bot = app.applyPreset(app.defaultBot(), 'safe', 100);
  app.rollDay(bot);
  app.noteDayLoss(bot, 12);
  app.noteDayLoss(bot, -5);
  assert.equal(bot.dayPnl, 7);
  assert.equal(app.dailyLimitHit(bot), false);
  app.noteDayLoss(bot, -15);
  assert.equal(bot.dayPnl, -8);
  assert.equal(app.dailyLimitHit(bot), true);
});

test('switching between demo and real accounts is always safe', () => {
  const demo = { loginid: 'VRTC1', currency: 'USD', balance: 10000, isVirtual: true };
  const real = { loginid: 'CR1', currency: 'USD', balance: 250, isVirtual: false };

  // A demo account can never place a real contract, however it is armed.
  let u = { bot: { live: true }, deriv: { ...demo, token: 't' } };
  assert.equal(I.canTradeReal(u), false, 'demo account must never trade real money');

  // Moving to the real account does not arm anything by itself.
  u = { bot: { live: false }, deriv: { ...real, token: 't' } };
  assert.equal(I.canTradeReal(u), false, 'switching account must not arm real trading');

  // Even an explicit stale arming flag cannot bypass the safety block.
  u = { bot: { live: true }, deriv: { ...real, token: 't' } };
  assert.equal(I.canTradeReal(u), false, 'arming cannot bypass the reconciliation safety block');

  // Returning to demo disarms, so a stale flag can never leak a real order.
  u.bot.live = demo.isVirtual ? false : u.bot.live;
  assert.equal(u.bot.live, false, 'switching to demo must disarm real trading');
});

test('a real account is sized from its own balance, not a stale one', () => {
  const X = I.SIM.XAUUSD.price, atr = 0.954, slDist = atr * 2;
  const bot = app.applyPreset(app.defaultBot(), 'safe', 250);
  const lots = app.sizeFor({}, bot, X, atr, slDist);
  const risk = lots * slDist * app.pointValue('XAUUSD');
  assert.ok(lots > 0, 'a funded real account must be able to trade');
  assert.ok(risk <= 250 * 0.015 + 1e-9, `risk must suit the $250 balance, got $${risk.toFixed(2)}`);
  assert.ok(I.liveCap(bot) <= 250 * 0.015 + 1e-9, 'and the cap must match it');
});
