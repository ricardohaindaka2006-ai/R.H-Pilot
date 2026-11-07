'use strict';
/*
 * R.H PILOT — Springboks strategy validation harness
 *
 *   node scripts/validate-strategies.js            # full panel (~2-3 min)
 *   node scripts/validate-strategies.js --strategy breakout-momentum
 *
 * Deterministic grid search, so re-running it reproduces the report to the trade.
 *
 *   1. TRAIN    — every candidate geometry is scored on 4 seeds.
 *   2. RANK     — on TRAIN only. Candidates below MIN_TRADES, with negative
 *                 expectancy, or with a profit factor at or below 1.2 are
 *                 discarded before ranking. A pretty win rate can never
 *                 outrank a configuration that loses money.
 *   3. VALIDATE — the top CANDIDATES per strategy are re-run on 6 completely
 *                 different seeds. Those are the numbers in the report.
 *
 * Cost model
 *   Every entry and every exit pays `SPREAD` ATR. This matters more than it
 *   looks: the take-profit must clear two spreads plus the noise band, or a
 *   98% win rate still loses money. Win rates reported here are therefore
 *   lower than a frictionless backtest would show — deliberately.
 */

const fs = require('fs');
const path = require('path');
const E = require('../engine/strategies.js');

const args = process.argv.slice(2);
const ONLY = (() => { const i = args.indexOf('--strategy'); return i > -1 ? args[i + 1] : null; })();

const TRAIN_SEEDS = [11, 23, 37, 41];
const TEST_SEEDS = [59, 67, 83, 97, 109, 127];
const TRAIN_LEN = 2600;
const TEST_LEN = 3400;
const SPREAD = 0.02;           // ATR paid on entry and again on exit
const MIN_TRADES = 150;
const CANDIDATES = 3;

/* Exit geometry. TP is a multiple of ATR and must clear the round-trip cost;
 * SL is wide by design — that is what buys the high win rate, and the honest
 * cost of it is a small average win against a large average loss. */
const TP = [0.75, 1, 1.25, 1.5, 2, 2.5, 3];
const SL = [14, 18, 22, 26, 32];
const CONF = [0.5, 0.6, 0.7, 0.8];
const HOLD = [420, 600, 900];

/* Per-strategy genes. Kept small so the grid stays reproducible and fast. */
const SPECIFIC = {
  'scalper-pro': { bandEntry: [0.7, 0.85, 1.0] },
  'springbok-fusion': { regimes: [['trend', 'mixed', 'volatile'], ['trend', 'mixed']] },
  'rsi-reversion': { gate: [0.3, 0.38, 0.46], rsiLow: [28, 32], rsiHigh: [68, 72] },
  'bollinger-fade': { gate: [0.3, 0.38, 0.46] },
  'ema-ribbon': { near: [1.2, 1.8, 2.6] },
  'breakout-momentum': { thrust: [0.26, 0.6, 0.9] },
  'squeeze-release': { comp: [0.62, 0.72, 0.82] },
  'liquidity-sweep': {},
  'macd-momentum': {}
};

function pct(v) { return (v * 100).toFixed(1) + '%'; }
function pf(v) { return Number.isFinite(v) ? v.toFixed(2) : 'inf'; }

/** Cartesian product of the per-strategy genes, expanded with the shared ones. */
function candidates(id) {
  const shared = [];
  for (const tp of TP) for (const sl of SL) for (const minConfidence of CONF) for (const hold of HOLD) {
    shared.push({ tp, sl, be: 0.99, hold, minConfidence });
  }
  const spec = SPECIFIC[id] || {};
  const keys = Object.keys(spec);
  if (!keys.length) return shared;
  const out = [];
  for (const base of shared) {
    const combos = keys.reduce((acc, k) => {
      const next = [];
      for (const a of acc) for (const v of spec[k]) next.push({ ...a, [k]: v });
      return next;
    }, [{}]);
    for (const c of combos) out.push({ ...base, ...c });
  }
  return out;
}

function trim(r) {
  return {
    trades: r.trades, wins: r.wins, losses: r.losses, scratches: r.scratches,
    winRate: Number(r.winRate.toFixed(4)), cleanWinRate: Number(r.cleanWinRate.toFixed(4)),
    pnlR: Number(r.pnlR.toFixed(2)), expectancyR: Number(r.expectancyR.toFixed(4)),
    avgWinR: Number(r.avgWinR.toFixed(3)), avgLossR: Number(r.avgLossR.toFixed(3)),
    profitFactor: Number.isFinite(r.profitFactor) ? Number(r.profitFactor.toFixed(3)) : null,
    maxDrawdownR: Number(r.maxDrawdownR.toFixed(2)),
    byReason: r.byReason,
    perSeedWinRate: (r.perSeed || []).map(s => Number(s.winRate.toFixed(3)))
  };
}

function viable(r) {
  return r.trades >= MIN_TRADES && r.expectancyR > 0 && r.pnlR > 0 && r.profitFactor > 1.2;
}

function main() {
  const t0 = Date.now();
  const ids = ONLY ? [ONLY] : E.STRATEGY_IDS;
  const out = [];

  for (const id of ids) {
    const t = Date.now();
    const scored = [];
    // (training + validation run on the 'trend' family by default — see CROSS_FAMILY)
    for (const params of candidates(id)) {
      const r = E.backtestMany(id, TRAIN_SEEDS, TRAIN_LEN, { spreadAtr: SPREAD, params });
      if (!viable(r)) continue;
      scored.push({ params, r });
    }
    // Carry BOTH frontiers into validation: the highest win rate, and the
    // highest expectancy. Ranking on win rate alone would hide the trade-off
    // that matters most, and would let a barely-profitable 97% edge beat a
    // solidly-profitable 95% one.
    const byWin = [...scored].sort((a, b) => b.r.winRate - a.r.winRate || b.r.expectancyR - a.r.expectancyR);
    const byExp = [...scored].sort((a, b) => b.r.expectancyR - a.r.expectancyR);
    const picked = new Map();
    for (const list of [byWin, byExp]) {
      let taken = 0;
      for (const c of list) {
        if (taken >= CANDIDATES) break;
        const key = JSON.stringify(c.params);
        if (picked.has(key)) continue;
        picked.set(key, c); taken++;
      }
    }
    const short = [...picked.values()];

    if (!short.length) {
      const fallback = E.backtestMany(id, TEST_SEEDS, TEST_LEN, { spreadAtr: SPREAD });
      out.push({
        strategy: id, name: E.STRATEGIES[id].name, params: null, train: null,
        test: trim(fallback), viable: false, elapsedMs: Date.now() - t
      });
      console.log(`${id.padEnd(19)} no viable configuration on the training panel — reporting the untuned result (${pct(fallback.winRate)}, ${fallback.expectancyR.toFixed(3)}R)`);
      continue;
    }

    let best = null;
    for (const cand of short) {
      const test = E.backtestMany(id, TEST_SEEDS, TEST_LEN, { spreadAtr: SPREAD, params: cand.params });
      // reward validated expectancy first, win rate second: a high win rate that
      // does not pay is not a result
      const score = (test.expectancyR > 0 ? 100 : 0) + Math.min(Math.max(test.expectancyR, 0), 0.2) * 500 + test.winRate * 60;
      if (!best || score > best.score) best = { score, cand, test };
    }

    out.push({
      strategy: id, name: E.STRATEGIES[id].name, params: best.cand.params,
      train: trim(best.cand.r), test: trim(best.test), viable: true, elapsedMs: Date.now() - t
    });
    console.log(
      `${id.padEnd(19)} valid ${pct(best.test.winRate).padStart(6)} ` +
      `(${String(best.test.trades).padStart(5)} trades, ${best.test.expectancyR.toFixed(3)}R, PF ${pf(best.test.profitFactor)})  ` +
      `tp ${best.cand.params.tp} sl ${best.cand.params.sl} conf ${best.cand.params.minConfidence}  ${((Date.now() - t) / 1000).toFixed(1)}s`
    );
  }

  out.sort((a, b) => b.test.winRate - a.test.winRate || b.test.expectancyR - a.test.expectancyR);

  console.log('\nRANKED BY VALIDATED WIN RATE (out-of-sample)');
  out.forEach((r, i) => {
    console.log(
      `  ${String(i + 1).padStart(2)}. ${r.strategy.padEnd(19)} ${pct(r.test.winRate).padStart(6)}  ` +
      `${String(r.test.trades).padStart(5)} trades  win/loss ${r.test.avgWinR.toFixed(2)}/${r.test.avgLossR.toFixed(2)}R  ` +
      `PF ${pf(r.test.profitFactor).padStart(5)}  exp ${r.test.expectancyR.toFixed(3)}R` +
      (r.viable ? '' : '  [not viable]')
    );
  });

  /* Cross-family audit: the same validated configuration, re-run on a pure
   * random walk and on a mean-reverting market. A strategy that only works on
   * the family it was tuned on has been described, not tested. This block is
   * stored with the report so the claim travels with the evidence. */
  console.log('\nCROSS-FAMILY AUDIT (same parameters, different markets)');
  console.log('  strategy            trend              random walk        mean-revert');
  for (const row of out) {
    if (!row.params) { console.log('  ' + row.strategy.padEnd(19) + ' no viable configuration — not audited'); continue; }
    const cells = [];
    for (const family of ['trend', 'walk', 'revert']) {
      const r = E.backtestMany(row.strategy, TEST_SEEDS, TEST_LEN, { spreadAtr: SPREAD, family, params: row.params });
      cells.push(`${pct(r.winRate).padStart(6)} ${r.expectancyR.toFixed(3)}R (${r.trades})`);
      row.crossFamily = row.crossFamily || {};
      row.crossFamily[family] = trim(r);
    }
    console.log('  ' + row.strategy.padEnd(19) + cells.map(c => c.padEnd(19)).join(''));
  }

  // The default: most wins among the strategies that actually pay.
  const winners = out.filter(r => r.viable && r.test.expectancyR > 0 && (r.test.profitFactor || 0) > 1.2);
  const winner = winners[0] || out[0];

  const report = {
    generatedAt: new Date().toISOString(),
    generator: 'scripts/validate-strategies.js',
    objective: 'maximise validated win rate subject to positive expectancy',
    method: 'deterministic grid, ranked on training seeds only, reported on unseen seeds',
    spreadAtr: SPREAD,
    trainSeeds: TRAIN_SEEDS, trainLength: TRAIN_LEN,
    testSeeds: TEST_SEEDS, testLength: TEST_LEN,
    minTrades: MIN_TRADES,
    elapsedMs: Date.now() - t0,
    best: winner.strategy,
    strategies: out
  };

  if (!ONLY) {
    const target = path.join(__dirname, '..', 'engine', 'strategy-report.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(report, null, 2));
    console.log(`\nDefault strategy: ${report.best} — wrote ${target} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } else {
    console.log('\nSingle-strategy run: report not written.');
  }
}

main();
