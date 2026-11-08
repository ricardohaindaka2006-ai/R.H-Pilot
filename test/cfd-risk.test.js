'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const CFD = require('../engine/cfd-risk.js');

const expected = {
  accountId: 'demo-710001', symbol: 'XAUUSD.a', direction: 'BUY',
  entryPrice: 2000.25, stopPrice: 1998.25, accountCurrency: 'USD', quoteAt: 10000
};
function profitCalc(overrides = {}) {
  return { accountId: expected.accountId, symbol: expected.symbol, direction: expected.direction,
    volume: 1, entryPrice: expected.entryPrice, stopPrice: expected.stopPrice,
    profitAtStop: -200, currency: expected.accountCurrency,
    quoteAt: expected.quoteAt, calculatedAt: 10100, ...overrides };
}

test('MT5 profit-at-stop calculation is bound to the exact account, symbol, side, prices and quote', () => {
  const result = CFD.validateProfitCalculation(profitCalc(), expected, 10200);
  assert.deepEqual(result, { ok: true, lossPerLotCash: 200, currency: 'USD', calculatedAt: 10100, quoteAt: 10000 });
  for (const change of [
    { accountId: 'demo-other' }, { symbol: 'XAUUSD' }, { direction: 'SELL' },
    { entryPrice: 2000.5 }, { stopPrice: 1998 }, { quoteAt: 9999 }, { volume: 0.1 },
    { currency: 'EUR' }
  ]) assert.equal(CFD.validateProfitCalculation(profitCalc(change), expected, 10200).ok, false);
  const sell = { ...expected, direction: 'SELL', entryPrice: 2000.25, stopPrice: 2002.25 };
  const sellCalc = { ...profitCalc(), direction: 'SELL', entryPrice: 2000.25, stopPrice: 2002.25 };
  assert.equal(CFD.validateProfitCalculation(sellCalc, sell, 10200).lossPerLotCash, 200);
});

test('profit calculation fails closed for gains, stale/future results and invalid stop geometry', () => {
  for (const calc of [
    profitCalc({ profitAtStop: 10 }), profitCalc({ profitAtStop: 0 }),
    profitCalc({ calculatedAt: 9999 }), profitCalc({ calculatedAt: 1 }),
    profitCalc({ calculatedAt: 10201 })
  ]) assert.equal(CFD.validateProfitCalculation(calc, expected, 10200).ok, false);
  assert.equal(CFD.validateProfitCalculation(profitCalc({ quoteAt: 1 }),
    { ...expected, quoteAt: 1 }, 10200).reason, 'stale-profit-calculation');
  assert.equal(CFD.validateProfitCalculation(profitCalc({ stopPrice: 2000.5 }),
    { ...expected, stopPrice: 2000.5 }, 10200).reason, 'invalid-stop-direction');
  assert.equal(CFD.validateProfitCalculation(null, expected).reason, 'invalid-profit-calculation');
});

test('volume sizing rounds down to the broker step and never exceeds the cash-risk budget', () => {
  const sized = CFD.sizeForRisk({ budgetCash: 27, lossPerLotCash: 100,
    volumeMin: 0.01, volumeMax: 50, volumeStep: 0.01, accountCurrency: 'USD', lossCurrency: 'USD' });
  assert.equal(sized.ok, true);
  assert.equal(sized.volume, 0.27);
  assert.equal(sized.plannedLossCash, 27);
  assert.ok(sized.plannedLossCash <= sized.budgetCash);

  const fixed = CFD.sizeForRisk({ budgetCash: 27, lossPerLotCash: 100,
    volumeMin: 0.01, volumeMax: 50, volumeStep: 0.01, requestedVolume: 0.5,
    accountCurrency: 'USD', lossCurrency: 'USD' });
  assert.equal(fixed.volume, 0.27, 'the user request is clipped to the remaining planned-risk budget');
});

test('a broker minimum that breaches risk is skipped, never rounded up', () => {
  const result = CFD.sizeForRisk({ budgetCash: 1, lossPerLotCash: 200,
    volumeMin: 0.01, volumeMax: 10, volumeStep: 0.01, accountCurrency: 'USD', lossCurrency: 'USD' });
  assert.equal(result.ok, false);
  assert.equal(result.volume, 0);
  assert.equal(result.reason, 'minimum-volume-exceeds-risk-budget');
  assert.equal(result.minimumLossCash, 2);
});

test('requested volume below broker minimum is skipped and volume is capped to broker maximum', () => {
  const belowMin = CFD.sizeForRisk({ budgetCash: 1000, lossPerLotCash: 5,
    volumeMin: 0.1, volumeMax: 2, volumeStep: 0.1, requestedVolume: 0.05,
    accountCurrency: 'USD', lossCurrency: 'USD' });
  assert.equal(belowMin.reason, 'requested-volume-below-minimum');

  const capped = CFD.sizeForRisk({ budgetCash: 1000, lossPerLotCash: 5,
    volumeMin: 0.1, volumeMax: 2, volumeStep: 0.1, accountCurrency: 'USD', lossCurrency: 'USD' });
  assert.equal(capped.volume, 2);
  assert.equal(capped.plannedLossCash, 10);
});

test('account and terminal profit currencies must match, and malformed broker grids fail closed', () => {
  assert.equal(CFD.sizeForRisk({ budgetCash: 10, lossPerLotCash: 2,
    volumeMin: 0.1, volumeMax: 2, volumeStep: 0.1, accountCurrency: 'USD', lossCurrency: 'EUR' }).reason, 'currency-mismatch');
  for (const grid of [
    { volumeMin: 0, volumeMax: 1, volumeStep: 0.1 },
    { volumeMin: 0.1, volumeMax: 0.05, volumeStep: 0.01 },
    { volumeMin: 0.1, volumeMax: 1, volumeStep: 0.03 },
    { volumeMin: 0.1, volumeMax: 1, volumeStep: 1e-9 }
  ]) {
    assert.equal(CFD.sizeForRisk({ budgetCash: 10, lossPerLotCash: 2, ...grid,
      accountCurrency: 'USD', lossCurrency: 'USD' }).ok, false);
  }
});

test('sizing rejects absent, non-finite or non-positive values rather than inventing exposure', () => {
  for (const input of [
    {}, { budgetCash: NaN, lossPerLotCash: 1, volumeMin: 0.01, volumeMax: 1, volumeStep: 0.01, accountCurrency: 'USD', lossCurrency: 'USD' },
    { budgetCash: 1, lossPerLotCash: 0, volumeMin: 0.01, volumeMax: 1, volumeStep: 0.01, accountCurrency: 'USD', lossCurrency: 'USD' },
    { budgetCash: 1, lossPerLotCash: 1, volumeMin: 0.01, volumeMax: 1, volumeStep: 0.01, requestedVolume: 0, accountCurrency: 'USD', lossCurrency: 'USD' },
    { budgetCash: 1, lossPerLotCash: 1, volumeMin: 0.01, volumeMax: 1, volumeStep: 0.01, accountCurrency: 'USD', lossCurrency: 'US' }
  ]) {
    const result = CFD.sizeForRisk(input);
    assert.equal(result.ok, false);
    assert.equal(result.volume, 0);
  }
});
