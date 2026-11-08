'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../engine/strategies.js');
const P = E.EXECUTION;
const zeroCosts = { spreadAtr: 0, slippageAtr: 0 };
const signal = (dir = 1) => ({ strategy: 'breakout-momentum', dir, confidence: 0.9,
  atr: 1, tp: 6, sl: 2, tpDist: 6, slDist: 2, be: 0.99, hold: 10 });

function forcedBacktest(series, overrides = {}) {
  const def = E.STRATEGIES['breakout-momentum'], original = def.fn;
  def.fn = () => ({ dir: 1, confidence: 1 });
  try {
    return E.backtest(series, 'breakout-momentum', {
      params: { regimes: ['trend', 'range', 'mixed', 'volatile'], ...overrides },
      execution: { ...zeroCosts, lockInProfit: false }
    });
  } finally { def.fn = original; }
}

test('terminal exposure is marked once at its actual final quote with no overlapping trades', () => {
  const series = Array.from({ length: 100 }, (_, i) => 100 + i * 0.01);
  const trades = forcedBacktest(series, { tp: 10000, sl: 10000 });
  assert.equal(trades.length, 1);
  const t = trades[0];
  assert.equal(t.i, E.WARMUP);
  assert.equal(t.entryIdx, t.i + 1, 'entry cannot use the decision quote');
  assert.equal(t.exitIdx, series.length - 1);
  assert.equal(t.reason, 'end-of-data');
  assert.equal(t.entry, series[t.entryIdx]);
  assert.equal(t.exit, series.at(-1));
  assert.ok(t.r > 0, 'an unfinished winner is not invented as a zero scratch');
});

test('terminal losing positions are not hidden as scratches', () => {
  const series = Array.from({ length: 100 }, (_, i) => 100 + i * 0.01);
  series[90] = 102;
  const [t] = forcedBacktest(series, { tp: 10000, sl: 10000 });
  assert.equal(t.reason, 'end-of-data');
  assert.ok(t.r < 0);
});

test('backtest fills an adverse stop gap at the observed quote, not an invented -1R', () => {
  const series = Array.from({ length: 94 }, (_, i) => 100 + (i % 2) * 0.2);
  series[90] = 100; series[91] = 95;
  const [t] = forcedBacktest(series);
  assert.equal(t.entryIdx, 90);
  assert.equal(t.exitIdx, 91);
  assert.equal(t.reason, 'stop-loss');
  assert.equal(t.exit, 95);
  assert.ok(t.r < -10, 'gap losses can exceed the planned stop by many R');
});

test('favourable gaps also use observed fills instead of clipping wins to the target', () => {
  const series = Array.from({ length: 94 }, (_, i) => 100 + (i % 2) * 0.2);
  series[90] = 100; series[91] = 110;
  const [t] = forcedBacktest(series);
  assert.equal(t.reason, 'take-profit');
  assert.equal(t.exit, 110);
  assert.ok(t.r > 3);
});

test('breakeven activation persists across ticks, and a later gap can still lose money', () => {
  const p = P.paperPosition({ ...signal(), be: 0.5 }, 100, { ...zeroCosts, lockInProfit: false });
  assert.equal(P.advancePosition(p, 104), null);
  assert.equal(p.beTriggered, true);
  assert.equal(p.slPrice, 100);
  const exit = P.advancePosition(p, 99);
  assert.equal(exit.cause, 'profit-locked');
  assert.equal(exit.r, -0.5, 'a break-even stop is not a guaranteed fill');
});

test('long and short profit locks tighten monotonically and honour the trailing switch', () => {
  for (const dir of [1, -1]) {
    const p = P.paperPosition(signal(dir), 100, zeroCosts);
    P.advancePosition(p, 100 + dir);
    assert.equal(p.beTriggered, true);
    assert.equal(p.slPrice, 100);
    P.advancePosition(p, 100 + dir * 4);
    assert.equal(p.slPrice, 100 + dir * 3.3);
    P.advancePosition(p, 100 + dir * 3.5);
    assert.equal(p.slPrice, 100 + dir * 3.3, 'a retrace never loosens the stop');
    const exit = P.advancePosition(p, 100 + dir * 2);
    assert.equal(exit.cause, 'profit-locked');
    assert.equal(exit.r, 1);
    const noTrail = P.paperPosition(signal(dir), 100, { ...zeroCosts, trailing: false });
    P.advancePosition(noTrail, 100 + dir * 4);
    assert.equal(noTrail.slPrice, 100);
  }
});

test('paper costs are adverse on BOTH entry and exit for both directions', () => {
  for (const dir of [1, -1]) {
    const p = P.paperPosition(signal(dir), 100, { spreadAtr: 0.1, slippageAtr: 0.05 });
    const exit = P.exitPrice(p, 100);
    assert.ok(Math.abs((exit - p.entry) * dir + 0.3) < 1e-10);
    assert.equal(p.execution, 'paper');
  }
});

test('time stops count fresh observations and retain marked-to-market P/L', () => {
  const p = P.paperPosition({ ...signal(), hold: 2 }, 100, zeroCosts);
  assert.equal(P.advancePosition(p, 100.1), null);
  const exit = P.advancePosition(p, 99.5);
  assert.equal(p.ticks, 2);
  assert.equal(exit.cause, 'time-stop');
  assert.equal(exit.r, -0.25);
});

test('signals and contexts are causal: appending future prices cannot change the past', () => {
  const series = E.makeSeries(2026, 240);
  const future = [...series, 50000, 0.01, 99999];
  for (const i of [90, 130, 239]) {
    const before = E.buildContext(series, i), after = E.buildContext(future, i);
    assert.deepEqual(after, before);
    for (const id of E.STRATEGY_IDS) assert.deepEqual(E.signalFor(after, id), E.signalFor(before, id));
  }
});

test('invalid prices, confidence and geometry fail closed', () => {
  const series = E.makeSeries(42, 140), ctx = E.analyze(series);
  for (const params of [{ tp: NaN }, { sl: 0 }, { hold: Infinity }, { hold: 1.5 }, { minConfidence: NaN }]) {
    assert.equal(E.signalFor(ctx, 'breakout-momentum', params), null);
  }
  assert.throws(() => E.backtest([1, NaN, 2], 'breakout-momentum'), /invalid-price-series/);
  series[135] = NaN;
  assert.equal(E.analyze(series), null);
  assert.throws(() => P.paperPosition(signal(), 100, { slippageAtr: -1 }), /invalid-slippageAtr/);
});

test('context construction never copies unbounded history', () => {
  const series = E.makeSeries(19, 50000);
  series.slice = function (start, end) {
    assert.ok((end == null ? this.length : end) - start <= 130, 'indicator copies must be bounded');
    return Array.prototype.slice.call(this, start, end);
  };
  assert.ok(E.analyze(series));
});

test('backtest records are chronological and contain finite actual-fill returns', () => {
  for (const family of ['trend', 'walk', 'revert']) {
    for (const id of E.STRATEGY_IDS) {
      const trades = E.backtest(E.makeSeries(83, 800, { family, gap: 0.02 }), id);
      let previous = -1;
      for (const t of trades) {
        assert.ok(t.i > previous && t.entryIdx === t.i + 1 && t.exitIdx >= t.entryIdx);
        assert.ok(Number.isFinite(t.r));
        previous = t.exitIdx;
      }
    }
  }
});

test('conservative defaults activate break-even at 0.5R and trail at 1R in either direction', () => {
  for (const dir of [1, -1]) {
    const p = P.paperPosition(signal(dir), 100, zeroCosts);
    assert.equal(P.advancePosition(p, 100 + dir * 0.9), null);
    assert.equal(p.beTriggered, false);
    assert.equal(P.advancePosition(p, 100 + dir), null);
    assert.equal(p.beTriggered, true);
    assert.equal(p.slPrice, 100);
    assert.equal(P.advancePosition(p, 100 + dir * 2), null);
    assert.ok(Math.abs(p.slPrice - (100 + dir * 1.3)) < 1e-12, '1R gain leaves a 0.35R trailing distance');
    const exit = P.advancePosition(p, 100 + dir * 1.2);
    assert.equal(exit.cause, 'profit-locked');
    assert.ok(Math.abs(exit.r - 0.6) < 1e-12, 'exit uses the next actual quote, not the stop price');
  }
});

test('the shared execution layer rejects malformed or inverted profit-protection rules', () => {
  for (const options of [{ lockAfterR: 0 }, { trailByR: Infinity }, { trailing: 'false' },
    { lockInProfit: 1 }, { lockAfterR: 0.5, trailAfterR: 0.5 }, { lockAfterR: 1, trailAfterR: 0.5 }]) {
    assert.throws(() => P.executionOptions(options), /invalid-/);
  }
});
