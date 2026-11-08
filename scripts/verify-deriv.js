'use strict';

/* Production-network smoke test: no token or private account is required.
   Always verifies Deriv server time. Verifies XAUUSD while its market is open;
   during scheduled weekend closures, proves live market data with VOL10 and
   records the XAUUSD closure honestly instead of misreporting a network error. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { derivRequest, _internals } = require('../server');

_internals.db = { users: [], sessions: {}, config: _internals.DEFAULT_CONFIG(), createdAt: Date.now() };

(async () => {
  const started = Date.now();
  const timeMessage = await derivRequest({ time: 1 }, 15000);
  assert.ok(timeMessage && Number.isFinite(Number(timeMessage.time)), 'Deriv did not return server time');

  const symbolsMessage = await derivRequest({ active_symbols: 'brief' }, 15000);
  assert.ok(Array.isArray(symbolsMessage && symbolsMessage.active_symbols) && symbolsMessage.active_symbols.length > 0,
    'Deriv did not return active symbols');
  const offeredSymbols = symbolsMessage.active_symbols
    .map(x => x && (x.symbol || x.underlying_symbol)).filter(Boolean);
  assert.ok(offeredSymbols.length > 0, 'Deriv active-symbol response had no usable symbol codes');

  let tickMessage;
  let xauUsdStatus = offeredSymbols.includes('frxXAUUSD') ? 'live' : 'not-offered';
  let xauUsdMessage = xauUsdStatus === 'not-offered' ? 'The current Options API does not offer XAUUSD.' : '';
  if (xauUsdStatus === 'live') {
    try {
      tickMessage = await derivRequest({ ticks: 'frxXAUUSD', subscribe: 1 }, 15000);
      assert.ok(tickMessage && tickMessage.tick, 'Deriv did not return an XAUUSD tick');
    } catch (error) {
      if (error.code !== 'deriv-market-closed') throw error;
      xauUsdStatus = 'closed'; xauUsdMessage = error.message;
    }
  }
  if (!tickMessage) {
    const fallbackSymbol = offeredSymbols.includes('R_10') ? 'R_10' : offeredSymbols.find(s => s !== 'frxXAUUSD');
    assert.ok(fallbackSymbol, 'Deriv did not offer an alternate market to check');
    tickMessage = await derivRequest({ ticks: fallbackSymbol, subscribe: 1 }, 15000);
  }
  assert.ok(tickMessage && tickMessage.tick, 'Deriv did not return a live market tick');
  assert.ok(Number.isFinite(Number(tickMessage.tick.quote)) && Number(tickMessage.tick.quote) > 0, 'Deriv tick has no valid positive quote');
  const providerAt = Number(tickMessage.tick.epoch) * 1000;
  assert.ok(Number.isFinite(providerAt) && providerAt <= Date.now() && Date.now() - providerAt <= 8000,
    'Deriv returned a stale or future-dated tick');

  const result = {
    ok: true,
    apiLatencyMs: Date.now() - started,
    derivServerTime: new Date(Number(timeMessage.time) * 1000).toISOString(),
    xauUsdStatus,
    xauUsdMessage: xauUsdMessage || undefined,
    activeSymbols: offeredSymbols.length,
    symbol: tickMessage.tick.symbol,
    quote: Number(tickMessage.tick.quote),
    tickEpoch: tickMessage.tick.epoch
  };
  fs.writeFileSync('deriv-diagnostic.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
})().catch(error => {
  const result = { ok: false, code: error.code || undefined, error: error.message, stack: error.stack, at: new Date().toISOString() };
  fs.writeFileSync('deriv-diagnostic.json', JSON.stringify(result, null, 2));
  console.error('Deriv production-network verification failed:', error.message);
  process.exitCode = 1;
});
