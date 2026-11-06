'use strict';

/* Production-network smoke test: no token or private account is required.
   Verifies Deriv's public API handshake, server time and a real XAUUSD tick. */
const assert = require('node:assert/strict');
const { derivRequest, _internals } = require('../server');

_internals.db = { users: [], sessions: {}, config: _internals.DEFAULT_CONFIG(), createdAt: Date.now() };

(async () => {
  const started = Date.now();
  const timeMessage = await derivRequest({ time: 1 }, null, 15000);
  assert.ok(timeMessage && Number.isFinite(Number(timeMessage.time)), 'Deriv did not return server time');

  const tickMessage = await derivRequest({ ticks: 'frxXAUUSD', subscribe: 1 }, null, 15000);
  assert.ok(tickMessage && tickMessage.tick, 'Deriv did not return an XAUUSD tick');
  assert.ok(Number.isFinite(Number(tickMessage.tick.quote)), 'Deriv tick has no valid quote');

  console.log(JSON.stringify({
    ok: true,
    apiLatencyMs: Date.now() - started,
    derivServerTime: new Date(Number(timeMessage.time) * 1000).toISOString(),
    symbol: tickMessage.tick.symbol,
    quote: Number(tickMessage.tick.quote),
    tickEpoch: tickMessage.tick.epoch
  }, null, 2));
})().catch(error => {
  console.error('Deriv production-network verification failed:', error.message);
  process.exitCode = 1;
});
