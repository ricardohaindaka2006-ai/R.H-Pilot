'use strict';

// Microbenchmark the pure signal path, independent of broker/network latency.
// Measures context construction plus all four strategy decisions per tick.
const E = require('../engine/strategies.js');
const series = E.makeSeries(20261107, 1200, { family: 'trend' });
const index = series.length - 1;
const ids = E.STRATEGY_IDS;
const iterations = Number(process.env.BENCH_ITERATIONS || 12000);
const samples = [];

function evaluate() {
  const context = E.buildContext(series, index);
  if (!context) throw new Error('Engine context failed to initialise');
  let fired = 0;
  for (const id of ids) if (E.signalFor(context, id)) fired++;
  return fired;
}
for (let i = 0; i < 1500; i++) evaluate();
for (let i = 0; i < iterations; i++) {
  const start = process.hrtime.bigint();
  evaluate();
  samples.push(Number(process.hrtime.bigint() - start) / 1e6);
}
samples.sort((a, b) => a - b);
const percentile = p => samples[Math.min(samples.length - 1, Math.floor((samples.length - 1) * p))];
const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
const result = {
  iterations,
  strategiesPerTick: ids.length,
  meanMs: Number(avg.toFixed(4)),
  p50Ms: Number(percentile(0.50).toFixed(4)),
  p95Ms: Number(percentile(0.95).toFixed(4)),
  maxMs: Number(samples[samples.length - 1].toFixed(4)),
  note: 'Local signal-computation latency only; excludes Deriv network, proposal, broker execution and slippage.'
};
console.log(JSON.stringify(result, null, 2));
if (result.p95Ms > 5) {
  console.error('Engine signal path exceeded the 5 ms p95 CI budget.');
  process.exitCode = 1;
}
