'use strict';

// Diagnostics for FROZEN shipped paper strategies, not a profit optimiser.
// Selection sees training families only. Holdout/stress results cannot select
// a candidate, change its parameters, regime gates, or the paper reference.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const E = require('../engine/strategies.js');

const TRAIN_SEEDS = [11, 23, 37, 41];
const TEST_SEEDS = [2026110801, 2026110809, 2026110823, 2026110841, 2026110861, 2026110893];
const FAMILIES = ['trend', 'walk', 'revert'];
const TRAIN_LENGTH = 2600, TEST_LENGTH = 3400;
const EXECUTION = E.EXECUTION.DEFAULT_EXECUTION;
const LIMITATIONS = [
  'All prices are deterministic synthetic data, not historical or live market observations.',
  'The trend generator has strong persistent drift; very high win rates on it are not a live forecast.',
  'Diagnostic seeds are excluded from this script\'s selection but reused during development; they are not an untouched final test.',
  'R is planned stop-distance risk. Adverse gaps can lose more than 1R; fills are not clipped.',
  'Signals fill on the next tick. Every entry and exit pays adverse spread and slippage.',
  'Paper profit locks and trailing exits share code with the server. Auto follows one training-selected reference.',
  'These fixed-size single-position tests exclude account sizing, daily stops, wall-clock cooldowns and legacy positions.',
  'Detector confidence is a heuristic ranking score, not the probability that a trade wins.',
  'Deriv five-minute options payouts, early-sale availability, settlement and network delays are NOT modelled.',
  'No real-market or broker-authoritative forward validation has been performed. New live orders are disabled.'
];

function round(v, places = 4) { return Number.isFinite(v) ? Number(v.toFixed(places)) : null; }
function trim(r) {
  return {
    trades: r.trades, wins: r.wins, losses: r.losses, scratches: r.scratches,
    winRate: round(r.winRate), cleanWinRate: round(r.cleanWinRate), pnlR: round(r.pnlR),
    expectancyR: round(r.expectancyR), avgWinR: round(r.avgWinR), avgLossR: round(r.avgLossR),
    profitFactor: round(r.profitFactor), maxDrawdownR: round(r.maxDrawdownR),
    maxSeedDrawdownR: round(r.maxSeedDrawdownR), byReason: r.byReason,
    perSeed: (r.perSeed || []).map(s => ({ seed: s.seed, trades: s.trades, winRate: round(s.winRate),
      expectancyR: round(s.expectancyR), pnlR: round(s.pnlR), maxDrawdownR: round(s.maxDrawdownR) })),
    perSeedWinRate: (r.perSeed || []).map(s => round(s.winRate))
  };
}

function panel(id, seeds, length, options = {}) {
  return Object.fromEntries(FAMILIES.map(family => [family,
    trim(E.backtestMany(id, seeds, length, { ...options, family, params: E.paramsFor(id) }))]));
}

// Equal weight per family, penalty for the worst family and realised drawdown.
// A research preference only. No claim that this score predicts real returns.
function trainingScore(train) {
  const rows = FAMILIES.map(f => train[f]);
  if (rows.some(r => !r || !r.trades)) return -Infinity;
  return rows.reduce((n, r) => n + r.expectancyR, 0) / rows.length
    + 2 * Math.min(0, ...rows.map(r => r.expectancyR))
    - Math.max(...rows.map(r => r.maxSeedDrawdownR)) * 0.01;
}
function researchViable(train) {
  return FAMILIES.every(f => train[f].trades >= 30 && train[f].expectancyR > 0 &&
    (train[f].profitFactor == null || train[f].profitFactor > 1.2));
}
function chooseTrainingLeader(rows) {
  return [...rows].sort((a, b) => trainingScore(b.trainFamilies) - trainingScore(a.trainFamilies)
    || a.strategy.localeCompare(b.strategy))[0]?.strategy || null;
}

function generateReport(ids = E.STRATEGY_IDS) {
  const start = Date.now();
  // Freeze parameters and choose the reference BEFORE touching the holdout.
  const strategies = ids.map(id => ({ strategy: id, name: E.STRATEGIES[id].name, params: E.paramsFor(id),
    trainFamilies: panel(id, TRAIN_SEEDS, TRAIN_LENGTH) }));
  const trainingLeader = chooseTrainingLeader(strategies);
  for (const row of strategies) {
    row.trainingScore = round(trainingScore(row.trainFamilies));
    row.viable = researchViable(row.trainFamilies);
    row.train = row.trainFamilies.trend;
    row.crossFamily = panel(row.strategy, TEST_SEEDS, TEST_LENGTH);
    row.test = row.crossFamily.trend; // compatibility: explicitly labelled trend-only in the UI
    row.testPass = researchViable(row.crossFamily);
    row.stress = {
      higherCosts: panel(row.strategy, TEST_SEEDS, TEST_LENGTH, { spreadAtr: 0.10, slippageAtr: 0.05 }),
      priceGaps: panel(row.strategy, TEST_SEEDS, TEST_LENGTH, { gap: 0.01 })
    };
    row.liveEligible = false;
  }
  return {
    schemaVersion: 2, generatedAt: new Date().toISOString(), generator: 'scripts/validate-strategies.js',
    model: E.EXECUTION.MODEL_VERSION, modelFingerprint: E.modelFingerprint(),
    syntheticOnly: true, liveEligible: false, evidence: 'synthetic diagnostics only',
    objective: 'audit frozen paper strategies across regimes and adverse fills; do not optimise a headline win rate',
    method: 'one frozen configuration per strategy; reference selected on training families only before holdout evaluation',
    execution: EXECUTION, spreadAtr: EXECUTION.spreadAtr, slippageAtr: EXECUTION.slippageAtr,
    trainSeeds: TRAIN_SEEDS, trainLength: TRAIN_LENGTH, testSeeds: TEST_SEEDS, testLength: TEST_LENGTH,
    families: FAMILIES, trainingLeader,
    best: strategies.find(r => r.strategy === trainingLeader)?.viable ? trainingLeader : null,
    limitations: LIMITATIONS, elapsedMs: Date.now() - start, strategies
  };
}

function markdown(report) {
  const pct = v => (v * 100).toFixed(1) + '%';
  const pf = v => v == null ? 'no losses' : v.toFixed(2);
  const rows = report.strategies.flatMap(row => FAMILIES.map(f => {
    const r = row.crossFamily[f];
    return `| ${row.name} | ${f} | ${r.trades} | ${pct(r.winRate)} | ${r.expectancyR.toFixed(3)} | ${pf(r.profitFactor)} | ${r.maxSeedDrawdownR.toFixed(2)} |`;
  })).join('\n');
  const stress = report.strategies.flatMap(row => Object.entries(row.stress).flatMap(([scenario, families]) => FAMILIES.map(f => {
    const r = families[f];
    return `| ${row.name} | ${scenario} / ${f} | ${r.trades} | ${r.expectancyR.toFixed(3)} | ${r.maxSeedDrawdownR.toFixed(2)} |`;
  }))).join('\n');
  return `# Springboks engine — corrected synthetic diagnostic\n\nGenerated: ${report.generatedAt}\n\n` +
    `**Live readiness: NOT approved. No strategy guarantees profit. New broker orders are blocked in this build.**\n\n` +
    `The previous report is superseded: it described a different exit geometry, selected candidates using its test panel, and relied on flawed backtest/accounting behaviour. Its headline results must not be used as trading evidence.\n\n` +
    `## Method\n\nOne frozen shipped configuration per strategy. Four training seeds per family, then six separate diagnostic seeds × ${TEST_LENGTH} ticks per family. Parameters are not selected using the test results. Paper auto reference: **${report.trainingLeader}**, selected on training score, not test win rate. ` +
    `Strategies clearing the training research floor: ${report.strategies.filter(r => r.viable).map(r => r.strategy).join(', ') || 'none'}. This is not a recommendation to trade.\n\n` +
    `Signal at tick i; entry at i+1. Both sides pay ${EXECUTION.spreadAtr} ATR spread plus ${EXECUTION.slippageAtr} ATR slippage. The same stateful exit implementation powers the paper bot (break-even at 0.5R; trail starts at 1R with 0.35R distance). A gap can lose more than 1R. Terminal exposure is marked to market once. 1R = initial planned stop distance. Drawdown below is the worst individual seed, not a cash-account forecast.\n\n` +
    `## Synthetic diagnostic panel\n\n| Strategy | Family | Trades | Win rate | Expectancy R | PF | Worst-seed DD R |\n|---|---|---:|---:|---:|---:|---:|\n${rows}\n\n` +
    `## Adverse-cost and gap scenarios\n\nHigher costs: 0.10 ATR spread + 0.05 ATR slippage per side. Gaps: 1% jump probability per tick with standard costs.\n\n` +
    `| Strategy | Scenario / family | Trades | Expectancy R | Worst-seed DD R |\n|---|---|---:|---:|---:|\n${stress}\n\n` +
    `## Limits and deployment decision\n\n${LIMITATIONS.map(l => '- ' + l).join('\n')}\n\n` +
    `Before real funds: implement durable account-bound contract tracking and broker-authoritative profit/settlement; verify rejected/uncertain buys, failed sells, expiry and restarts on demo; collect representative historical ticks and broker quotes; freeze settings and forward-test unseen market periods with realistic costs and drawdown limits. The included Render Free configuration uses ephemeral storage and is not appropriate for persistent trading state.\n\n` +
    `Regenerate with \`npm run validate:strategies\`; verify reproducibility with \`npm run validate:strategies -- --check\`. Machine-readable results: \`engine/strategy-report.json\`.\n`;
}

function main() {
  const args = process.argv.slice(2), onlyIdx = args.indexOf('--strategy');
  const only = onlyIdx < 0 ? null : args[onlyIdx + 1];
  if (onlyIdx >= 0 && !E.STRATEGIES[only]) throw new Error('unknown strategy');
  const report = generateReport(only ? [only] : E.STRATEGY_IDS);
  for (const row of report.strategies) {
    console.log(row.strategy, Object.entries(row.crossFamily).map(([f, r]) =>
      `${f}: ${r.trades} trades, ${(r.winRate * 100).toFixed(1)}% win, ${r.expectancyR.toFixed(3)}R`).join(' | '));
  }
  console.log('Training-only paper reference:', report.trainingLeader, '| Live eligible: false');
  if (only) { console.log('Single-strategy diagnostic; no report written.'); return; }
  const target = path.join(__dirname, '..', 'engine', 'strategy-report.json');
  if (args.includes('--check')) {
    const stable = r => { const { generatedAt, elapsedMs, ...metrics } = r; return metrics; };
    assert.deepEqual(stable(report), stable(JSON.parse(fs.readFileSync(target, 'utf8'))), 'Shipped diagnostic does not match this model; regenerate it.');
    console.log('Shipped diagnostic reproduced exactly.');
  } else {
    fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n');
    fs.writeFileSync(path.join(__dirname, '..', 'REPORT-engine.md'), markdown(report));
    console.log('Wrote strategy-report.json and REPORT-engine.md in', report.elapsedMs, 'ms.');
  }
}
if (require.main === module) main();
module.exports = { generateReport, chooseTrainingLeader, trainingScore, researchViable };
