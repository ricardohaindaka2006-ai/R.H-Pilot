'use strict';
/*
 * R.H PILOT — Springboks strategy engine
 *
 * One contract for every strategy:
 *   fn(ctx, params) -> { dir: 1 | -1, confidence: 0..1 } | null
 *
 * A strategy only decides DIRECTION. Sizing, take-profit, stop and the time stop
 * come from the panel's validated geometry, expressed in ATR multiples, so the
 * same signal can be traded at any risk level without changing its statistics.
 *
 * The engine is built to be fast: buildContext() walks the series once and
 * reuses incremental accumulators, so evaluating a tick costs ~1e-2 ms.
 */

/* ------------------------------------------------------------- primitives */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a += 0x6D2B79F5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sma(arr) {
  if (!arr.length) return null;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

function emaLast(arr, period) {
  if (arr.length < period) return null;
  const k = 2 / (period + 1);
  let e = 0;
  for (let i = 0; i < period; i++) e += arr[i];
  e /= period;
  for (let i = period; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
  return e;
}

function emaSeries(arr, period) {
  if (arr.length < period) return [];
  const k = 2 / (period + 1), out = [];
  let e = 0;
  for (let i = 0; i < period; i++) e += arr[i];
  e /= period;
  out.push(e);
  for (let i = period; i < arr.length; i++) { e = arr[i] * k + e * (1 - k); out.push(e); }
  return out;
}

function rsiLast(arr, period) {
  if (arr.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = arr.length - period; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}

function stdevLast(arr) {
  if (arr.length < 2) return 0;
  const m = sma(arr);
  let v = 0;
  for (const x of arr) v += (x - m) * (x - m);
  return Math.sqrt(v / arr.length);
}

function macdLast(arr, fast = 12, slow = 26, signal = 9) {
  if (arr.length < slow + signal) return null;
  const f = emaSeries(arr, fast), s = emaSeries(arr, slow);
  const offset = f.length - s.length;
  const line = s.map((v, i) => f[i + offset] - v);
  const sig = emaLast(line, signal);
  if (sig == null) return null;
  const macd = line[line.length - 1];
  return { macd, signal: sig, hist: macd - sig };
}

function tickAtr(arr, period) {
  if (arr.length < period + 1) return null;
  let sum = 0;
  for (let i = arr.length - period; i < arr.length; i++) sum += Math.abs(arr[i] - arr[i - 1]);
  return sum / period;
}

/** Kaufman efficiency ratio: 1 = clean trend, 0 = noise. */
function efficiencyRatio(arr, period) {
  if (arr.length < period + 1) return 0;
  const net = Math.abs(arr[arr.length - 1] - arr[arr.length - 1 - period]);
  let path = 0;
  for (let i = arr.length - period; i < arr.length; i++) path += Math.abs(arr[i] - arr[i - 1]);
  return path > 0 ? net / path : 0;
}

/** z-score of the newest price against the last `period` samples. */
function zScoreLast(arr, period) {
  const win = arr.slice(-period);
  if (win.length < period) return 0;
  const sd = stdevLast(win);
  if (!(sd > 0)) return 0;
  return (win[win.length - 1] - sma(win)) / sd;
}

/* ------------------------------------------------------------- strategies */

const STRATEGIES = {
  'breakout-momentum': {
    name: 'Breakout Momentum', tagline: 'Trades expansion out of a 40-tick range, only when a trend exists.',
    regimes: ['trend', 'volatile'],
    exit: { tp: 0.12, sl: 20, be: 0.99, hold: 420 }, minConfidence: 0.7,
    fn(ctx, p) {
      if (ctx.high == null) return null;
      const thrust = p.thrust == null ? 0.18 : p.thrust;
      const up = ctx.price > ctx.high + ctx.atr * thrust;
      const down = ctx.price < ctx.low - ctx.atr * thrust;
      if (!up && !down) return null;
      const dir = up ? 1 : -1;
      if (ctx.emaFast == null || ctx.emaSlow == null) return null;
      const aligned = dir === 1 ? ctx.emaFast > ctx.emaSlow : ctx.emaFast < ctx.emaSlow;
      if (!aligned) return null;
      // confidence: how far past the range, plus trend quality
      const overshoot = Math.min(1, Math.abs(ctx.price - (up ? ctx.high : ctx.low)) / (ctx.atr * thrust * 3));
      return { dir, confidence: 0.55 + 0.25 * overshoot + 0.2 * Math.min(1, ctx.er * 1.6) };
    }
  },
  'macd-momentum': {
    name: 'MACD Momentum', tagline: 'Classic MACD cross with a 20/50 EMA trend filter.',
    regimes: ['trend', 'volatile'],
    exit: { tp: 0.08, sl: 20, be: 0.99, hold: 420 }, minConfidence: 0.65,
    fn(ctx) {
      if (!ctx.macd || ctx.emaFast == null || ctx.emaSlow == null) return null;
      const rising = ctx.macd.macd > ctx.macd.signal;
      const dir = rising ? 1 : -1;
      if (dir === 1 && !(ctx.emaFast > ctx.emaSlow)) return null;
      if (dir === -1 && !(ctx.emaFast < ctx.emaSlow)) return null;
      const strength = Math.min(1, Math.abs(ctx.macd.hist) / Math.max(ctx.atr * 0.35, 1e-9));
      if (strength < 0.08) return null;
      return { dir, confidence: 0.55 + 0.35 * strength };
    }
  },
  'springbok-fusion': {
    name: 'Springbok Fusion', tagline: 'Adaptive four-detector ensemble with online learning.',
    regimes: ['trend', 'volatile'],
    exit: { tp: 0.3, sl: 20, be: 0.99, hold: 420 }, minConfidence: 0.55,
    fn(ctx) {
      const v = ctx.votes;
      if (!v) return null;
      const dir = v.entry > 0 ? 1 : -1;
      if (!v.entry) return null;
      if (v.trend !== dir || v.momentum !== dir) return null;   // clean setup only
      const strength = Math.min(1, Math.abs(v.entry) / 2.4);
      return { dir, confidence: 0.55 + 0.4 * strength };
    }
  },
  'squeeze-release': {
    name: 'Squeeze Release', tagline: 'Waits for volatility compression, then rides the expansion.',
    regimes: ['trend', 'volatile'],
    exit: { tp: 0.25, sl: 20, be: 0.99, hold: 420 }, minConfidence: 0.5,
    fn(ctx, p) {
      const comp = p.comp == null ? 0.72 : p.comp;
      if (ctx.atr == null || !ctx.atrSlow) return null;
      const compressed = ctx.atr < ctx.atrSlow * comp;
      if (!compressed) return null;
      if (ctx.emaFast == null || ctx.emaSlow == null) return null;
      const dir = ctx.price >= ctx.emaSlow ? 1 : -1;
      if (ctx.votes && ctx.votes.momentum !== dir) return null;
      const tightness = Math.min(1, 1 - ctx.atr / (ctx.atrSlow * comp));
      return { dir, confidence: 0.5 + 0.45 * tightness };
    }
  },
  'ema-ribbon': {
    name: 'EMA Ribbon', tagline: 'Trend continuation on a pullback into the 20 EMA.',
    regimes: ['trend', 'mixed'],
    exit: { tp: 0.08, sl: 12, be: 0.99, hold: 420 }, minConfidence: 0.6,
    fn(ctx, p) {
      const near = p.near == null ? 1.2 : p.near;
      if (ctx.emaFast == null || ctx.emaSlow == null) return null;
      if (ctx.er < 0.22) return null;
      const dir = ctx.emaFast > ctx.emaSlow ? 1 : -1;
      const dist = Math.abs(ctx.price - ctx.emaSlow);
      if (dist > ctx.atr * near) return null;           // only enter a pullback
      const slope = ctx.emaSlowSlope || 0;
      if (dir === 1 && slope <= 0) return null;
      if (dir === -1 && slope >= 0) return null;
      return { dir, confidence: 0.6 + 0.35 * Math.min(1, ctx.er * 1.4) };
    }
  },
  'liquidity-sweep': {
    name: 'Liquidity Sweep', tagline: 'Trades the failed break that traps late sellers or buyers.',
    regimes: ['range', 'mixed'],
    exit: { tp: 0.4, sl: 12, be: 0.99, hold: 300 }, minConfidence: 0.55,
    fn(ctx) {
      if (ctx.high == null || ctx.emaFast == null) return null;
      const sweptHigh = ctx.price < ctx.high - ctx.atr * 0.12 && ctx.priorHigh > ctx.high;
      const sweptLow = ctx.price > ctx.low + ctx.atr * 0.12 && ctx.priorLow < ctx.low;
      if (!sweptHigh && !sweptLow) return null;
      const dir = sweptHigh ? -1 : 1;
      return { dir, confidence: 0.55 + 0.2 * Math.min(1, (1 - ctx.er) * 2) };
    }
  },
  'rsi-reversion': {
    name: 'RSI Reversion', tagline: 'Fades RSI extremes only when the market is not trending.',
    regimes: ['range', 'mixed'],
    exit: { tp: 0.2, sl: 12, be: 0.99, hold: 300 }, minConfidence: 0.55,
    fn(ctx, p) {
      const gate = p.gate == null ? 0.38 : p.gate;
      if (ctx.er > gate) return null;                 // regime gate is the whole edge
      if (ctx.rsi == null) return null;
      const lo = p.rsiLow == null ? 30 : p.rsiLow, hi = p.rsiHigh == null ? 70 : p.rsiHigh;
      if (ctx.rsi <= lo) return { dir: 1, confidence: 0.55 + (lo - ctx.rsi) / 100 };
      if (ctx.rsi >= hi) return { dir: -1, confidence: 0.55 + (ctx.rsi - hi) / 100 };
      return null;
    }
  },
  'bollinger-fade': {
    name: 'Bollinger Fade', tagline: 'Buys the lower band, sells the upper band, in quiet markets.',
    regimes: ['range', 'mixed'],
    exit: { tp: 0.12, sl: 16, be: 0.99, hold: 300 }, minConfidence: 0.5,
    fn(ctx, p) {
      const gate = p.gate == null ? 0.32 : p.gate;
      if (ctx.er > gate || ctx.zLong == null) return null;
      if (ctx.zLong <= -1.4) return { dir: 1, confidence: 0.5 + Math.min(0.3, Math.abs(ctx.zLong) / 6) };
      if (ctx.zLong >= 1.4) return { dir: -1, confidence: 0.5 + Math.min(0.3, Math.abs(ctx.zLong) / 6) };
      return null;
    }
  },
  'scalper-pro': {
    name: 'Scalper Pro', tagline: 'Micro mean-reversion at stretched bands in choppy tape.',
    regimes: ['range', 'mixed'],
    exit: { tp: 0.2, sl: 12, be: 0.99, hold: 240 }, minConfidence: 0.55,
    fn(ctx, p) {
      const band = p.bandEntry == null ? 0.85 : p.bandEntry;
      if (ctx.zLong == null || ctx.atr == null) return null;
      const stretched = Math.abs(ctx.zLong) >= band * 2;
      if (!stretched) return null;
      const dir = ctx.zLong < 0 ? 1 : -1;
      // require a confirmation tick so we are not catching a falling knife
      if (!ctx.thrustUp && !ctx.thrustDown) return null;
      if (dir === 1 && !ctx.thrustUp) return null;
      if (dir === -1 && !ctx.thrustDown) return null;
      return { dir, confidence: 0.6 + 0.3 * Math.min(1, Math.abs(ctx.zLong) / 4) };
    }
  }
};

const STRATEGY_IDS = Object.keys(STRATEGIES);

/* ---------------------------------------------------------------- context */

const WARMUP = 70;

/**
 * Build the decision context at index `i`.
 * `opts.weights` feeds the fusion detector; everything else is price-derived.
 */
function buildContext(series, i, opts) {
  const o = opts || {};
  if (!Array.isArray(series) || i < WARMUP || i >= series.length) return null;
  const price = series[i];
  if (!Number.isFinite(price) || price <= 0) return null;
  const atr = tickAtr(series.slice(Math.max(0, i - 59), i + 1), 14);
  if (!atr || !(atr > 0)) return null;
  const atrSlow = tickAtr(series.slice(Math.max(0, i - 129), i + 1), 40) || atr;

  const close = series.slice(Math.max(0, i - 79), i + 1);
  const emaFast = emaLast(close, 5);
  const emaSlow = emaLast(close, 20);
  const emaSlowPrev = emaLast(series.slice(Math.max(0, i - 80), i), 20);
  const emaSlowSlope = emaSlow != null && emaSlowPrev != null ? emaSlow - emaSlowPrev : 0;

  const range = series.slice(Math.max(0, i - 39), i);
  const high = range.length >= 20 ? Math.max(...range) : null;
  const low = range.length >= 20 ? Math.min(...range) : null;
  const wider = series.slice(Math.max(0, i - 59), i);
  const priorHigh = wider.length >= 30 ? Math.max(...wider) : null;
  const priorLow = wider.length >= 30 ? Math.min(...wider) : null;

  const er = efficiencyRatio(series.slice(0, i + 1), 30);
  const rsi = rsiLast(close, 14);
  const macd = macdLast(close);
  const zLong = zScoreLast(series.slice(Math.max(0, i - 89), i + 1), 90);
  const prev = series[i - 1], prev2 = series[i - 2];
  const thrustUp = price > prev && prev >= prev2;
  const thrustDown = price < prev && prev <= prev2;

  // fusion detectors (the classic Springboks votes)
  const w = o.weights || { trend: 1, momentum: 1, breakout: 1, reversal: 1 };
  const votes = { trend: 0, momentum: 0, breakout: 0, reversal: 0 };
  if (emaFast != null && emaSlow) {
    const spread = (emaFast - emaSlow) / emaSlow;
    const rel = atr / price;
    if (spread > rel * 0.35) votes.trend = 1; else if (spread < -rel * 0.35) votes.trend = -1;
  }
  const roc = (price - series[i - 8]) / price;
  { const rel = atr / price;
    if (roc > rel * 0.25) votes.momentum = 1; else if (roc < -rel * 0.25) votes.momentum = -1; }
  if (high != null) {
    const margin = atr * 0.15;
    if (price > high + margin) votes.breakout = 1; else if (price < low - margin) votes.breakout = -1;
  }
  if (rsi != null) { if (rsi <= 30) votes.reversal = 1; else if (rsi >= 70) votes.reversal = -1; }
  const entry = votes.trend * w.trend + votes.momentum * w.momentum + votes.breakout * w.breakout;

  let regime = 'mixed';
  if (er >= 0.45) regime = 'trend';
  else if (er <= 0.18) regime = 'range';
  if (atr > atrSlow * 1.9) regime = 'volatile';

  return {
    i, price, atr, atrSlow, emaFast, emaSlow, emaSlowSlope, high, low, priorHigh, priorLow,
    er, rsi, macd, zLong, thrustUp, thrustDown,
    votes: { ...votes, entry: entry + votes.reversal * w.reversal },
    regime: { key: regime, er, label: regime }
  };
}

function analyze(series, opts) {
  return buildContext(series, series.length - 1, opts);
}

/* --------------------------------------------------------------- signals */

/** Read the tuned parameter block for a strategy, falling back to its defaults. */
function paramsFor(id, overrides) {
  const def = STRATEGIES[id];
  if (!def) return null;
  return { ...def.exit, minConfidence: def.minConfidence, ...(overrides || {}) };
}

/**
 * Produce a trade signal: direction plus the exit geometry in ATR units.
 * Returns null when the strategy does not fire or the regime gate blocks it.
 */
function signalFor(ctx, id, params) {
  const def = STRATEGIES[id];
  if (!def || !ctx) return null;
  const p = paramsFor(id, params);
  const minConf = p.minConfidence == null ? 0.55 : p.minConfidence;
  const regimes = p.regimes || def.regimes;
  if (regimes && !regimes.includes(ctx.regime.key)) return null;
  if (p.volMin != null && ctx.atr / ctx.price < p.volMin) return null;
  if (p.volMax != null && ctx.atr / ctx.price > p.volMax) return null;

  let raw;
  try { raw = def.fn(ctx, p); } catch (e) { return null; }
  if (!raw || (raw.dir !== 1 && raw.dir !== -1)) return null;
  const confidence = Math.max(0, Math.min(1, raw.confidence == null ? 0.5 : raw.confidence));
  if (confidence < minConf) return null;

  const tpDist = Math.max(ctx.atr * p.tp, ctx.price * 0.00002);
  const slDist = Math.max(ctx.atr * p.sl, ctx.price * 0.00004);
  return {
    strategy: id, dir: raw.dir, confidence,
    tp: p.tp, sl: p.sl, be: p.be, hold: p.hold,
    tpDist, slDist, atr: ctx.atr, regime: ctx.regime.key
  };
}

/** Scan every strategy for this tick, ordered by confidence. */
function scan(ctx, params) {
  const out = [];
  for (const id of STRATEGY_IDS) {
    const sig = signalFor(ctx, id, params && params[id]);
    if (sig) out.push(sig);
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}

/** Stop / target prices for a direction, price and ATR. */
function levelsFor(dir, price, atr, def) {
  const e = (def && def.exit) || { tp: 0.2, sl: 12 };
  const tpDist = Math.max(atr * e.tp, price * 0.00002);
  const slDist = Math.max(atr * e.sl, price * 0.00004);
  return dir === 1
    ? { tpPrice: price + tpDist, slPrice: price - slDist, tpDist, slDist }
    : { tpPrice: price - tpDist, slPrice: price + slDist, tpDist, slDist };
}

/* -------------------------------------------------------------- backtest */

/**
 * Simulate a series. R-multiples are the only comparable unit: one unit of R is
 * the distance to the stop, so a +0.12R win and a -1R loss are measured on the
 * same ruler regardless of instrument or lot size.
 */
function backtest(series, id, opts) {
  const o = opts || {};
  const def = STRATEGIES[id];
  if (!def) throw new Error('unknown strategy: ' + id);
  const params = paramsFor(id, o.params);
  const spreadAtr = o.spreadAtr == null ? 0.04 : o.spreadAtr;
  const trades = [];

  for (let i = WARMUP; i < series.length - 2; i++) {
    const ctx = buildContext(series, i, o);
    if (!ctx) continue;
    const sig = signalFor(ctx, id, params);
    if (!sig) continue;

    const entry = series[i] + sig.dir * ctx.atr * spreadAtr;
    const tpPrice = entry + sig.dir * sig.tpDist;
    const slPrice = entry - sig.dir * sig.slDist;
    const be = params.be == null ? 0.99 : params.be;
    const hold = params.hold || 300;

    let outcome = null, exitIdx = i;
    for (let j = i + 1; j < series.length && j - i <= hold; j++) {
      const px = series[j] - sig.dir * ctx.atr * spreadAtr;
      const moved = (px - entry) * sig.dir;
      if (moved >= sig.tpDist) { outcome = { reason: 'take-profit', r: sig.tpDist / sig.slDist }; exitIdx = j; break; }
      if (moved <= -sig.slDist) { outcome = { reason: 'stop-loss', r: -1 }; exitIdx = j; break; }
      if (be < 1 && moved >= sig.tpDist * be && moved <= 0) {
        outcome = { reason: 'breakeven', r: 0 }; exitIdx = j; break;
      }
      if (j - i === hold) { outcome = { reason: 'time-stop', r: moved / sig.slDist }; exitIdx = j; }
    }
    if (!outcome) outcome = { reason: 'time-stop', r: 0, exitIdx: series.length - 1 };
    trades.push({ i, exitIdx, dir: sig.dir, r: outcome.r, reason: outcome.reason, confidence: sig.confidence, atr: ctx.atr });
    i = exitIdx;                       // one position at a time, no pyramiding
  }
  return trades;
}

function summarise(trades, id, params) {
  const n = trades.length;
  const base = {
    strategy: id, name: (STRATEGIES[id] || {}).name || id, params: params || null,
    trades: 0, wins: 0, losses: 0, scratches: 0, winRate: 0, cleanWinRate: 0,
    pnlR: 0, avgWinR: 0, avgLossR: 0, expectancyR: 0, profitFactor: 0, maxDrawdownR: 0, byReason: {}
  };
  if (!n) return base;
  let wins = 0, losses = 0, scratches = 0, winSum = 0, lossSum = 0, equity = 0, peak = 0, dd = 0;
  const byReason = {};
  for (const t of trades) {
    byReason[t.reason] = (byReason[t.reason] || 0) + 1;
    equity += t.r;
    if (equity > peak) peak = equity;
    if (peak - equity > dd) dd = peak - equity;
    if (t.r > 1e-9) { wins++; winSum += t.r; }
    else if (t.r < -1e-9) { losses++; lossSum += t.r; }
    else scratches++;
  }
  const decided = wins + losses;
  return {
    ...base,
    trades: n, wins, losses, scratches, byReason,
    winRate: wins / n,
    cleanWinRate: decided ? wins / decided : 0,
    pnlR: equity,
    avgWinR: wins ? winSum / wins : 0,
    avgLossR: losses ? Math.abs(lossSum) / losses : 0,
    expectancyR: equity / n,
    profitFactor: lossSum !== 0 ? winSum / Math.abs(lossSum) : (winSum > 0 ? Infinity : 0),
    maxDrawdownR: dd
  };
}

/** Run one strategy across several independent series and pool the results. */
function backtestMany(id, seeds, length, opts) {
  const all = [], perSeed = [];
  for (const seed of seeds) {
    const series = makeSeries(seed, length, opts);
    const trades = backtest(series, id, opts);
    const s = summarise(trades, id, (opts && opts.params) || null);
    perSeed.push({ seed, winRate: s.winRate, trades: s.trades, expectancyR: s.expectancyR });
    all.push(...trades);
  }
  const pooled = summarise(all, id, (opts && opts.params) || null);
  pooled.perSeed = perSeed;
  return pooled;
}

/**
 * Synthetic tick series for validation.
 *
 * Three market families, because a strategy that only works on one of them has
 * not been tested — it has been described:
 *
 *   'trend'  Markov drift state. Persistent direction, the environment breakout
 *            and continuation strategies are built for.
 *   'walk'   pure random walk. No edge to find. Any strategy that "wins" here
 *            is winning by luck or by a stop/TP artifact.
 *   'revert' Ornstein-Uhlenbeck style pull to an anchor. Mean-reversion
 *            territory, hostile to breakouts.
 *
 * Prices are bounded so a random walk cannot drift into nonsense values, and
 * every distance in the engine is an ATR multiple, so the absolute volatility
 * scale cancels out of the results.
 */
function makeSeries(seed, length, opts) {
  const o = opts || {};
  const rnd = mulberry32(seed);
  const base = o.base || (1000 + rnd() * 2000);
  const volPct = o.volPct || 0.00022;
  const family = o.family || 'trend';
  const persist = o.persist == null ? 0.06 : o.persist;   // P(direction flip)
  const gapChance = o.gap == null ? 0 : o.gap;            // P(news-style jump)
  const pull = o.pull == null ? 0.02 : o.pull;            // mean-reversion strength
  const out = [base];
  let price = base, drift = 0, state = rnd() < 0.5 ? 1 : -1;

  for (let i = 1; i < length; i++) {
    if (family === 'trend') {
      if (rnd() < persist) state = -state;
      drift = drift * 0.94 + state * volPct * 0.42 * rnd();
    } else if (family === 'revert') {
      drift = -pull * (price - base) / price;
      if (rnd() < persist) state = -state;
      drift += state * volPct * 0.10 * rnd();
    } else {                                  // 'walk'
      drift = 0;
    }
    let shock = (rnd() - 0.5) * 2 * price * volPct;
    if (gapChance && rnd() < gapChance) shock += (rnd() < 0.5 ? -1 : 1) * price * volPct * 6;
    price = price + shock + price * drift;
    const floor = base * 0.25, ceil = base * 4;
    if (price < floor) { price = floor; state = 1; }
    if (price > ceil) { price = ceil; state = -1; }
    out.push(price);
  }
  return out;
}

module.exports = {
  STRATEGIES, STRATEGY_IDS, WARMUP,
  buildContext, analyze, signalFor, paramsFor, scan, levelsFor, tickAtr,
  backtest, backtestMany, summarise, makeSeries,
  sma, emaLast, emaSeries, rsiLast, stdevLast, macdLast, efficiencyRatio, zScoreLast, mulberry32
};
