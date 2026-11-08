'use strict';

// A paper price-movement model, NOT Deriv's five-minute CALL/PUT payoff model.
// Costs are adverse ATR fractions per side. Stops are triggers, not guaranteed
// fills: all exits use the observed executable quote, including gap losses.
const MODEL_VERSION = 'paper-tick-v2';
const DEFAULT_EXECUTION = Object.freeze({
  spreadAtr: 0.02, slippageAtr: 0.01,
  lockInProfit: true, lockAfterR: 0.5, trailAfterR: 1.0, trailByR: 0.35,
  trailing: true
});

function executionOptions(overrides = {}) {
  const out = { ...DEFAULT_EXECUTION };
  for (const key of Object.keys(DEFAULT_EXECUTION)) {
    if (overrides[key] !== undefined) out[key] = overrides[key];
  }
  for (const key of ['spreadAtr', 'slippageAtr']) {
    if (!Number.isFinite(out[key]) || out[key] < 0) throw new Error('invalid-' + key);
  }
  for (const key of ['lockAfterR', 'trailAfterR', 'trailByR']) {
    if (!Number.isFinite(out[key]) || out[key] <= 0) throw new Error('invalid-' + key);
  }
  for (const key of ['lockInProfit', 'trailing']) {
    if (typeof out[key] !== 'boolean') throw new Error('invalid-' + key);
  }
  if (out.trailAfterR <= out.lockAfterR) throw new Error('invalid-profit-protection');
  return out;
}

function paperPosition(signal, mid, options) {
  const execution = executionOptions(options);
  if (![1, -1].includes(signal.dir) || !Number.isFinite(mid) || mid <= 0 ||
      !Number.isFinite(signal.atr) || signal.atr <= 0 ||
      !Number.isFinite(signal.tpDist) || signal.tpDist <= 0 ||
      !Number.isFinite(signal.slDist) || signal.slDist <= 0 ||
      !Number.isInteger(signal.hold) || signal.hold <= 0) throw new Error('invalid-paper-position');
  const costPerSide = signal.atr * (execution.spreadAtr + execution.slippageAtr);
  const entry = mid + signal.dir * costPerSide;
  return {
    execution: 'paper', executionModel: MODEL_VERSION,
    dir: signal.dir === 1 ? 'BUY' : 'SELL', entry, atr: signal.atr,
    tpDist: signal.tpDist, slDist: signal.slDist,
    tpPrice: entry + signal.dir * signal.tpDist,
    slPrice: entry - signal.dir * signal.slDist,
    holdTicks: signal.hold, beFraction: signal.be, ticks: 0,
    beTriggered: false, profitPeak: 0, lastMid: mid, costPerSide, exitSettings: execution
  };
}

function exitPrice(position, mid) {
  const dir = position.dir === 'BUY' ? 1 : -1;
  return mid - dir * (position.costPerSide || 0);
}

// Called ONCE per fresh market tick, for both the backtest and the paper bot.
// Exit settings are frozen at entry; changing the strategy cannot move an
// existing trade's target, stop, time limit or profit-lock rules.
function advancePosition(position, mid) {
  if (!Number.isFinite(mid) || mid <= 0) return null;
  const p = position, dir = p.dir === 'BUY' ? 1 : -1;
  const fill = exitPrice(p, mid), moved = (fill - p.entry) * dir;
  p.lastMid = mid;
  p.ticks = (p.ticks || 0) + 1;
  p.profitPeak = Math.max(p.profitPeak || 0, moved);
  const result = cause => ({ cause, price: fill, moved, r: moved / p.slDist });

  // Check existing triggers BEFORE updating a trailing stop. A gap cannot be
  // retroactively filled at the stop price, and losses are never clipped to 1R.
  if (p.slPrice != null && (fill - p.slPrice) * dir <= 0) return result(p.beTriggered ? 'profit-locked' : 'stop-loss');
  if (p.tpPrice != null && (fill - p.tpPrice) * dir >= 0) return result('take-profit');
  if (p.holdTicks && p.ticks >= p.holdTicks) return result('time-stop');

  const settings = p.exitSettings || DEFAULT_EXECUTION;
  const gainR = moved / p.slDist;
  const tighten = value => {
    if (p.slPrice == null || (value - p.slPrice) * dir > 0) p.slPrice = value;
  };
  if (settings.lockInProfit !== false) {
    if (!p.beTriggered && gainR >= settings.lockAfterR) {
      p.beTriggered = true;
      p.lockedAtR = gainR;
      tighten(p.entry); // break-even is a trigger, never a no-loss promise
    }
    if (p.beTriggered && settings.trailing !== false && gainR >= settings.trailAfterR) {
      tighten(fill - dir * p.slDist * settings.trailByR);
    }
  } else if (!p.beTriggered && Number.isFinite(p.beFraction) && p.beFraction < 1 && moved >= p.tpDist * p.beFraction) {
    p.beTriggered = true;
    tighten(p.entry);
  }
  return null;
}

module.exports = { MODEL_VERSION, DEFAULT_EXECUTION, executionOptions, paperPosition, advancePosition, exitPrice };
