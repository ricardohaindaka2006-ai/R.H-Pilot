'use strict';

// MT5/CFD risk primitives. This module intentionally cannot place orders.
// It sizes only from an account-bound MT5 order_calc_profit result for the
// exact quote, side, entry and stop; generic "contract size" guesses are not
// a safe substitute for the broker's account-currency calculation.
const MAX_VOLUME_DECIMALS = 8;
const DEFAULT_CALC_MAX_AGE_MS = 5000;

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function positive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
function decimalPlaces(value) {
  const text = String(value).toLowerCase();
  const [mantissa, exponentText] = text.split('e');
  const fraction = (mantissa.split('.')[1] || '').length;
  const exponent = exponentText == null ? 0 : Number(exponentText);
  return Math.max(0, fraction - exponent);
}
function nearInteger(value) {
  return Number.isFinite(value) && Math.abs(value - Math.round(value)) <= Number.EPSILON * Math.max(1, Math.abs(value)) * 16;
}

/**
 * Verify a terminal-computed loss for exactly one standard lot. MetaTrader's
 * order_calc_profit is expected to account for the symbol's contract rules and
 * conversion into the selected account currency. A quote or account mismatch
 * invalidates the result; the caller must fetch/recalculate, never guess.
 */
function validateProfitCalculation(calc, expected, now = Date.now(), maxAgeMs = DEFAULT_CALC_MAX_AGE_MS) {
  const fail = reason => ({ ok: false, reason });
  if (!isRecord(calc) || !isRecord(expected)) return fail('invalid-profit-calculation');
  if (typeof expected.accountId !== 'string' || !expected.accountId.trim() ||
      typeof expected.symbol !== 'string' || !expected.symbol.trim() ||
      !['BUY', 'SELL'].includes(expected.direction) ||
      !positive(expected.entryPrice) || !positive(expected.stopPrice) ||
      typeof expected.accountCurrency !== 'string' || !/^[A-Z]{3}$/.test(expected.accountCurrency) ||
      !positive(expected.quoteAt)) return fail('invalid-profit-calculation-context');
  if (!Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return fail('invalid-clock');
  if (calc.accountId !== expected.accountId) return fail('account-mismatch');
  if (calc.symbol !== expected.symbol) return fail('symbol-mismatch');
  if (calc.direction !== expected.direction) return fail('direction-mismatch');
  if (calc.currency !== expected.accountCurrency) return fail('currency-mismatch');
  if (calc.volume !== 1) return fail('calculation-must-use-one-lot');
  if (calc.entryPrice !== expected.entryPrice || calc.stopPrice !== expected.stopPrice ||
      calc.quoteAt !== expected.quoteAt) return fail('quote-or-price-mismatch');
  if (!Number.isFinite(calc.profitAtStop) || calc.profitAtStop >= 0) return fail('stop-is-not-a-calculated-loss');
  if (!Number.isFinite(calc.calculatedAt) || calc.calculatedAt < expected.quoteAt ||
      calc.calculatedAt > now || now - calc.calculatedAt > maxAgeMs ||
      expected.quoteAt > now || now - expected.quoteAt > maxAgeMs) return fail('stale-profit-calculation');
  if ((expected.direction === 'BUY' && expected.stopPrice >= expected.entryPrice) ||
      (expected.direction === 'SELL' && expected.stopPrice <= expected.entryPrice)) return fail('invalid-stop-direction');
  return { ok: true, lossPerLotCash: -calc.profitAtStop, currency: expected.accountCurrency,
    calculatedAt: calc.calculatedAt, quoteAt: calc.quoteAt };
}

/**
 * Fit a requested CFD volume to a remaining planned-loss budget. `lossPerLotCash`
 * must come from validateProfitCalculation and is already denominated in the
 * exact account currency. Volume is rounded DOWN to the broker step. If the
 * broker minimum exceeds the budget, this returns zero instead of rounding up.
 *
 * `budgetCash` should already reflect per-trade, portfolio, daily, drawdown and
 * existing-position reservations. Stops can still gap; this is planned risk,
 * not a loss guarantee or a maximum realised loss.
 */
function sizeForRisk({ budgetCash, lossPerLotCash, volumeMin, volumeMax, volumeStep,
  requestedVolume = null, accountCurrency, lossCurrency } = {}) {
  const fail = (reason, extra = {}) => ({ ok: false, reason, volume: 0, plannedLossCash: 0, ...extra });
  if (!positive(budgetCash) || !positive(lossPerLotCash) || !positive(volumeMin) ||
      !positive(volumeMax) || !positive(volumeStep) || volumeMax < volumeMin ||
      (requestedVolume !== null && !positive(requestedVolume)) ||
      typeof accountCurrency !== 'string' || !/^[A-Z]{3}$/.test(accountCurrency) ||
      typeof lossCurrency !== 'string' || !/^[A-Z]{3}$/.test(lossCurrency)) return fail('invalid-sizing-input');
  if (accountCurrency !== lossCurrency) return fail('currency-mismatch');
  const maxSteps = volumeMax / volumeStep;
  if ([volumeMin, volumeMax, volumeStep].some(value => decimalPlaces(value) > MAX_VOLUME_DECIMALS) ||
      volumeMax > 1000000 || maxSteps > 1000000000 || !nearInteger(volumeMin / volumeStep) ||
      !Number.isSafeInteger(Math.floor(maxSteps)) || Math.floor(maxSteps) * volumeStep < volumeMin) return fail('invalid-volume-grid');

  const minimumLossCash = volumeMin * lossPerLotCash;
  if (!Number.isFinite(minimumLossCash) || minimumLossCash > budgetCash) {
    return fail('minimum-volume-exceeds-risk-budget', { minimumLossCash });
  }
  if (requestedVolume !== null && requestedVolume < volumeMin) {
    return fail('requested-volume-below-minimum', { minimumLossCash });
  }

  const riskLimitedVolume = budgetCash / lossPerLotCash;
  const desired = Math.min(volumeMax, riskLimitedVolume,
    requestedVolume === null ? volumeMax : requestedVolume);
  const stepCount = Math.floor(desired / volumeStep + Number.EPSILON * Math.max(1, desired / volumeStep) * 4);
  const precision = Math.max(decimalPlaces(volumeMin), decimalPlaces(volumeMax), decimalPlaces(volumeStep));
  let volume = Number((stepCount * volumeStep).toFixed(precision));

  // Defend against binary floating-point boundaries: the final persisted risk
  // must be at or below the budget, not merely close to it. The validated grid
  // bounds this correction to a few steps; never spin on hostile broker data.
  for (let correction = 0; correction < 4 && volume >= volumeMin &&
      volume * lossPerLotCash > budgetCash; correction++) {
    volume = Number((volume - volumeStep).toFixed(precision));
  }
  if (!(Number.isFinite(volume) && volume >= volumeMin && volume <= volumeMax)) {
    return fail('volume-below-minimum', { minimumLossCash });
  }
  const plannedLossCash = volume * lossPerLotCash;
  if (!(Number.isFinite(plannedLossCash) && plannedLossCash > 0 && plannedLossCash <= budgetCash)) {
    return fail('risk-budget-exceeded', { minimumLossCash });
  }
  return { ok: true, volume, plannedLossCash, budgetCash,
    lossPerLotCash, minimumLossCash, currency: accountCurrency };
}

module.exports = { DEFAULT_CALC_MAX_AGE_MS, validateProfitCalculation, sizeForRisk };
