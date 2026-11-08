'use strict';
/* Directional research strategies for a PAPER price-movement model.
 * No signal confidence is a calibrated probability of profit. Synthetic
 * diagnostics cannot validate MT5/CFD order execution or guarantee live returns.
 * Context work is bounded by the indicator window, not total history length.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const EXECUTION = require('./execution.js');

function modelFingerprint() {
  const hash = crypto.createHash('sha256');
  for (const file of ['strategies.js', 'execution.js']) hash.update(fs.readFileSync(path.join(__dirname, file)));
  return hash.digest('hex');
}

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

// Same seed/smoothing as emaLast, but works directly over a bounded segment
// of the history so long-period filters do not copy long arrays on each tick.
function emaRange(series, start, end, period) {
  if (end - start + 1 < period) return null;
  const k = 2 / (period + 1);
  let e = 0;
  for (let i = start; i < start + period; i++) e += series[i];
  e /= period;
  for (let i = start + period; i <= end; i++) e = series[i] * k + e * (1 - k);
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
    // Nominal 3:1 target/stop distance; actual fills can be worse after gaps.
    exit: { tp: 6, sl: 2, be: 0.99, hold: 420 }, minConfidence: 0.5,
    fn(ctx, p) {
      if (ctx.high == null) return null;
      // Require expansion beyond the prior range, not a noise-level break.
      const thrust = p.thrust == null ? 1.2 : p.thrust;
      if (!Number.isFinite(thrust) || thrust <= 0) return null;
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
    name: 'MACD Momentum', tagline: 'MACD alignment with a 5/20 EMA trend filter.',
    regimes: ['trend', 'volatile'],
    exit: { tp: 6, sl: 2, be: 0.99, hold: 420 }, minConfidence: 0.7,
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
    name: 'Springbok Fusion', tagline: 'Four-detector ensemble with fixed research weights.',
    // A fixed conservative gate, shared by pinned, auto and backtest paths.
    regimes: ['trend'],
    exit: { tp: 6, sl: 2, be: 0.99, hold: 420 }, minConfidence: 0.5,
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
  'apex-confluence': {
    name: 'Apex Trend Confluence',
    tagline: 'EMA20/50/200 alignment, slope, tick structure, RSI band and a confirmed range break.',
    regimes: ['trend'],
    // Research-only translation of the useful confluence ideas. The current
    // input is ticks, not OHLC bars: this does NOT claim to detect wick/reclaim
    // liquidity sweeps. All exits still use the shared paper execution layer.
    exit: { tp: 6, sl: 2, be: 0.5, hold: 420 }, minConfidence: 0.8,
    fn(ctx) {
      const a = ctx.apex;
      if (!a || !Number.isFinite(a.ema20) || !Number.isFinite(a.ema50) ||
          !Number.isFinite(a.ema200) || !Number.isFinite(a.ema20Slope) ||
          !Number.isFinite(a.volatilityRatio) || !Number.isFinite(ctx.rsi) ||
          !Number.isFinite(ctx.atr) || ctx.atr <= 0) return null;
      let dir = 0;
      if (a.ema20 > a.ema50 && a.ema50 > a.ema200) dir = 1;
      else if (a.ema20 < a.ema50 && a.ema50 < a.ema200) dir = -1;
      else return null;
      const opposedStructure = (dir === 1 && a.structure === 'BEARISH') ||
        (dir === -1 && a.structure === 'BULLISH');
      const opposedBreak = (dir === 1 && a.breakoutDown) || (dir === -1 && a.breakoutUp);
      const rsiAligned = dir === 1 ? (ctx.rsi >= 50 && ctx.rsi <= 70) : (ctx.rsi >= 30 && ctx.rsi <= 50);
      if (opposedStructure || opposedBreak || !rsiAligned || a.volatilityRatio > 1.9) return null;

      // Direction-specific scoring avoids the source's bug where bullish EMA
      // points could raise confidence on a bearish setup (and vice versa).
      let score = 35; // 25 for the aligned EMA stack, 10 for the directional RSI band
      if (dir * a.ema20Slope > 0) score += 15;
      if (a.structure === (dir === 1 ? 'BULLISH' : 'BEARISH')) score += 20;
      if (dir === 1 ? a.breakoutUp : a.breakoutDown) score += 15;
      if (a.volatilityRatio <= 1.9) score += 15;
      return score >= 80 ? { dir, confidence: score / 100 } : null;
    }
  },
  'scalper-pro': {
    name: 'Scalper Pro', tagline: 'Micro mean-reversion at stretched bands in choppy tape.',
    regimes: ['range', 'mixed'],
    exit: { tp: 4, sl: 2, be: 0.99, hold: 420 }, minConfidence: 0.7,
    fn(ctx, p) {
      // Band is in z-score units; it is not a probability of a reversal.
      const band = p.bandEntry == null ? 0.8 : p.bandEntry;
      if (!Number.isFinite(band) || band <= 0 || ctx.zLong == null || ctx.atr == null) return null;
      if (Math.abs(ctx.zLong) < band) return null;
      const dir = ctx.zLong < 0 ? 1 : -1;
      const confirmed = dir === 1 ? ctx.thrustUp : ctx.thrustDown;
      // Take the fade immediately when the tape is already turning; otherwise
      // still take it, but with lower confidence so ranking prefers the confirmed one.
      const confidence = 0.55 + 0.3 * Math.min(1, Math.abs(ctx.zLong) / 4) + (confirmed ? 0.1 : 0);
      return { dir, confidence };
    }
  }
};

const STRATEGY_IDS = Object.keys(STRATEGIES);

/* ---------------------------------------------------------------- context */

const WARMUP = 89; // index of the 90th sample: enough for every indicator

/**
 * Build the decision context at index `i`.
 * `opts.weights` feeds the fusion detector; everything else is price-derived.
 */
function buildContext(series, i, opts) {
  const o = opts || {};
  if (!Array.isArray(series) || i < WARMUP || i >= series.length) return null;
  const price = series[i];
  if (!Number.isFinite(price) || price <= 0) return null;
  for (let k = Math.max(0, i - WARMUP); k <= i; k++) {
    if (!Number.isFinite(series[k]) || series[k] <= 0) return null;
  }
  const atr = tickAtr(series.slice(Math.max(0, i - 59), i + 1), 14);
  if (!atr || !(atr > 0)) return null;
  const atrSlow = tickAtr(series.slice(Math.max(0, i - 129), i + 1), 40) || atr;

  const close = series.slice(Math.max(0, i - 79), i + 1);
  const emaFast = emaLast(close, 5);
  const emaSlow = emaLast(close, 20);
  const emaSlowPrev = emaLast(series.slice(Math.max(0, i - 80), i), 20);
  const emaSlowSlope = emaSlow != null && emaSlowPrev != null ? emaSlow - emaSlowPrev : 0;

  // Range extremes are scanned in place: no throwaway arrays and no spread
  // calls on the hot path, and the values are identical to the slice+spread
  // version this replaces.
  const rangeStart = Math.max(0, i - 39);
  let high = null, low = null;
  if (i - rangeStart >= 20) {
    high = -Infinity; low = Infinity;
    for (let k = rangeStart; k < i; k++) { const v = series[k]; if (v > high) high = v; if (v < low) low = v; }
  }
  const widerStart = Math.max(0, i - 59);
  let priorHigh = null, priorLow = null;
  if (i - widerStart >= 30) {
    priorHigh = -Infinity; priorLow = Infinity;
    for (let k = widerStart; k < i; k++) { const v = series[k]; if (v > priorHigh) priorHigh = v; if (v < priorLow) priorLow = v; }
  }

  const er = efficiencyRatio(series.slice(i - 30, i + 1), 30);
  const rsi = rsiLast(close, 14);
  const macd = macdLast(close);
  const zLong = zScoreLast(series.slice(Math.max(0, i - 89), i + 1), 90);
  const prev = series[i - 1], prev2 = series[i - 2];
  const thrustUp = price > prev && prev >= prev2;
  const thrustDown = price < prev && prev <= prev2;

  // Apex-inspired longer trend context. It is deliberately based on ticks,
  // because this engine currently ingests prices rather than OHLC candles.
  // A tick breakout is not a wick/reclaim liquidity sweep. The longer 200-tick
  // filter is optional context: existing strategies keep their 90-tick warmup.
  let apex = null;
  if (i >= 204) {
    const previousEnd = i - 5;
    const previousStart = Math.max(0, previousEnd - 799);
    const currentStart = Math.max(0, i - 799);
    let valid = true;
    for (let k = previousStart; k <= i; k++) {
      if (!Number.isFinite(series[k]) || series[k] <= 0) { valid = false; break; }
    }
    if (valid) {
      const ema20 = emaRange(series, currentStart, i, 20);
      const ema50 = emaRange(series, currentStart, i, 50);
      const ema200 = emaRange(series, currentStart, i, 200);
      const ema20Previous = emaRange(series, previousStart, previousEnd, 20); // same bounded window, five ticks earlier
      let recentHigh = -Infinity, recentLow = Infinity, priorSwingHigh = -Infinity, priorSwingLow = Infinity;
      for (let k = i - 4; k <= i; k++) { recentHigh = Math.max(recentHigh, series[k]); recentLow = Math.min(recentLow, series[k]); }
      for (let k = i - 9; k <= i - 5; k++) { priorSwingHigh = Math.max(priorSwingHigh, series[k]); priorSwingLow = Math.min(priorSwingLow, series[k]); }
      const structure = recentHigh > priorSwingHigh && recentLow > priorSwingLow ? 'BULLISH'
        : recentHigh < priorSwingHigh && recentLow < priorSwingLow ? 'BEARISH' : 'RANGE';
      apex = { ema20, ema50, ema200, ema20Slope: ema20 - ema20Previous, structure,
        breakoutUp: priorHigh != null && price > priorHigh + atr * 0.05,
        breakoutDown: priorLow != null && price < priorLow - atr * 0.05,
        volatilityRatio: atrSlow > 0 ? atr / atrSlow : Infinity };
    }
  }

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
    er, rsi, macd, zLong, thrustUp, thrustDown, apex,
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
  if (![ctx.atr, ctx.price, p.tp, p.sl, p.hold].every(v => Number.isFinite(v) && v > 0) ||
      !Number.isInteger(p.hold) || !Number.isFinite(p.be) || p.be <= 0 || p.be > 1 ||
      !Number.isFinite(p.minConfidence) || p.minConfidence < 0 || p.minConfidence > 1 || !ctx.regime) return null;
  const minConf = p.minConfidence;
  const regimes = p.regimes || def.regimes;
  if (regimes && !regimes.includes(ctx.regime.key)) return null;
  if (p.volMin != null && ctx.atr / ctx.price < p.volMin) return null;
  if (p.volMax != null && ctx.atr / ctx.price > p.volMax) return null;

  let raw;
  try { raw = def.fn(ctx, p); } catch (e) { return null; }
  if (!raw || (raw.dir !== 1 && raw.dir !== -1) || !Number.isFinite(raw.confidence)) return null;
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
  const e = (def && def.exit) || { tp: 6, sl: 2 };
  const tpDist = Math.max(atr * e.tp, price * 0.00002);
  const slDist = Math.max(atr * e.sl, price * 0.00004);
  return dir === 1
    ? { tpPrice: price + tpDist, slPrice: price - slDist, tpDist, slDist }
    : { tpPrice: price - tpDist, slPrice: price + slDist, tpDist, slDist };
}

/* -------------------------------------------------------------- backtest */

/** One position at a time; decide at tick i, fill at tick i+1.
 * The exact same adverse-cost and exit functions drive the paper server.
 * End-of-data exposure is marked to market once, never scratched or re-used.
 * This does NOT model option payouts, portfolio sizing or wall-clock cooldowns.
 */
function backtest(series, id, opts) {
  const o = opts || {};
  if (!STRATEGIES[id]) throw new Error('unknown strategy: ' + id);
  if (!Array.isArray(series) || series.some(v => !Number.isFinite(v) || v <= 0)) throw new Error('invalid-price-series');
  const params = paramsFor(id, o.params);
  const execution = EXECUTION.executionOptions({ ...o.execution,
    ...(o.spreadAtr == null ? {} : { spreadAtr: o.spreadAtr }),
    ...(o.slippageAtr == null ? {} : { slippageAtr: o.slippageAtr })
  });
  const trades = [];
  for (let i = WARMUP; i < series.length - 1; i++) {
    const ctx = buildContext(series, i, o);
    const sig = signalFor(ctx, id, params);
    if (!sig) continue;
    const entryIdx = i + 1;
    const pos = EXECUTION.paperPosition(sig, series[entryIdx], execution);
    let exit = null, exitIdx = series.length - 1;
    for (let j = entryIdx + 1; j < series.length; j++) {
      exit = EXECUTION.advancePosition(pos, series[j]);
      if (exit) { exitIdx = j; break; }
    }
    if (!exit) {
      const price = EXECUTION.exitPrice(pos, series[exitIdx]);
      exit = { cause: 'end-of-data', price, r: (price - pos.entry) * sig.dir / pos.slDist };
    }
    trades.push({ i, entryIdx, exitIdx, dir: sig.dir, entry: pos.entry, exit: exit.price,
      r: exit.r, reason: exit.cause, confidence: sig.confidence, atr: ctx.atr });
    i = exitIdx;
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
    perSeed.push({ seed, winRate: s.winRate, trades: s.trades, expectancyR: s.expectancyR, pnlR: s.pnlR, maxDrawdownR: s.maxDrawdownR });
    all.push(...trades);
  }
  const pooled = summarise(all, id, (opts && opts.params) || null);
  pooled.perSeed = perSeed;
  pooled.maxSeedDrawdownR = Math.max(0, ...perSeed.map(s => s.maxDrawdownR));
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
  STRATEGIES, STRATEGY_IDS, WARMUP, EXECUTION, modelFingerprint,
  buildContext, analyze, signalFor, paramsFor, scan, levelsFor, tickAtr,
  backtest, backtestMany, summarise, makeSeries,
  sma, emaLast, emaSeries, rsiLast, stdevLast, macdLast, efficiencyRatio, zScoreLast, mulberry32
};
