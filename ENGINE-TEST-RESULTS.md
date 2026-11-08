# Engine health and tuning — fresh test results

Run date: **2026-11-08 UTC**. Source: commit `c85304c3cbf7cb3e484cb37754dcafc8be41c6b4`, branch `arena/4a8893c2-r-h-pilot`.

## Verdict

**Software correctness/safety checks passed; conservative paper defaults confirmed. The engine is not demonstrated to be robustly tuned for profitable live trading. Keep real execution disabled.**

No trading parameters, strategy selection, production settings, model code or shipped strategy reports were changed. These tests concern this checkout and its defaults, not a hosted account's saved custom settings. No production or broker account was accessed; broker unit tests use mocks.

## 1. Fresh software and speed checks

Commands actually run:

```bash
npm ci --ignore-scripts
npm run verify:local
npm audit --omit=dev --json
git diff --check
```

| Check | Actual result |
|---|---|
| JavaScript syntax | **15 files passed** |
| Automated tests | **104 passed, 0 failed, 0 skipped** |
| Test-suite duration | **1.772 seconds** |
| Frozen strategy diagnostic | Recomputed and matched the shipped report exactly |
| Runtime dependency scan | **0 reported vulnerabilities**, not a full security audit |
| Signal microbenchmark | 12,000 iterations; context + all 4 strategies per tick |
| Mean / median computation | **0.0072 / 0.0045 ms** |
| p95 / maximum computation | **0.0181 / 2.8910 ms** |

Coverage includes causal/next-tick fills, adverse gap accounting, break-even/trailing persistence, frozen open-position exits, daily-loss latches, fractional affordability, balance growth/drawdown, source/stale-tick handling, lifecycle/uncertain-exposure preservation, HTTP settings, client-form/focus unit harnesses and blocked real-order entry paths. This run did not include a new real-browser E2E session or an endurance/load test.

**Timing is local signal computation only.** It excludes broker/network latency, order placement/settlement, slippage and full multi-user processing. It cannot establish “millisecond broker execution.”

## 2. Fresh-seed tuning/robustness results

Before any new result was evaluated, the protocol froze **8 new seeds**, **5,000 ticks per seed**, three synthetic families (trend, random walk, mean reversion), three scenarios (standard, higher costs, price gaps) and the unchanged shipped settings. All four strategies were reported: **36 pooled cells / 288 seed-level backtests completed**. There was no parameter search, post-result adjustment or replacement of the existing reference/report.

The current Auto paper reference remains **scalper-pro**, selected by the existing training process. **0 of 4 strategies clear the shipped all-family training research floor** (at least 30 trades, positive expectancy and profit factor above 1.2 in every family). Selection is not live approval.

### Random-walk summary — the important negative result

| Strategy | Standard-cost trades | Standard-cost win rate | Standard-cost net R/trade | Higher-cost net R/trade |
|---|---:|---:|---:|---:|
| Breakout Momentum | 119 | 32.8% | -0.271 | -0.302 |
| MACD Momentum | 185 | 32.4% | -0.242 | -0.321 |
| Springbok Fusion | 244 | 30.7% | -0.287 | -0.396 |
| Scalper Pro | 2477 | 42.1% | -0.017 | -0.155 |

**All four strategies lost on this fresh random-walk batch after assumed costs.** A random-walk generator has no intended predictive edge; these results do not establish that all real markets behave like it. They do show why favourable trend-only results cannot substantiate broadly profitable tuning.

For the current Scalper Pro reference:

- Standard-cost walk: **2,477 trades, 42.1% wins, -0.0165R/trade**, with 6/8 losing seeds.
- Higher-cost walk: **2,535 trades, 36.3% wins, -0.1554R/trade**, with **8/8 losing seeds** and **73.00R** worst-seed drawdown.
- Gap walk: **-0.0246R/trade**, worst-seed drawdown **60.53R**.
- Mean reversion was more favourable: **+0.1511R/trade** at standard costs, but only **+0.0289R/trade** at higher costs; the latter still had **4/8 losing seeds**. This is regime/cost sensitivity, not a reliable universal edge.

**1R = initial planned stop-distance risk.** Negative net R/trade means loss on average after the model's adverse costs. Drawdown is the worst individual seed in fixed-size R units, **not a cash-account percentage or dollar-loss forecast**. Gaps may lose more than 1R.

### Complete fresh panel — including favourable and adverse results

### standard

Spread 0.02 ATR + slippage 0.01 ATR **per side**; gap probability 0% per tick.

| Strategy | Family | Trades | Win rate | Net R/trade | Worst-seed drawdown R | Losing seeds / seeds with trades |
|---|---|---:|---:|---:|---:|---:|
| Breakout Momentum | trend | 2099 | 97.2% | +3.082 | 2.15 | 0/8 |
| MACD Momentum | trend | 2715 | 88.5% | +2.627 | 4.93 | 0/8 |
| Springbok Fusion | trend | 3283 | 86.3% | +2.545 | 7.71 | 0/8 |
| Scalper Pro | trend | 551 | 87.5% | +1.972 | 4.62 | 0/8 |
| Breakout Momentum | walk | 119 | 32.8% | -0.271 | 10.42 | 7/8 |
| MACD Momentum | walk | 185 | 32.4% | -0.242 | 13.19 | 6/8 |
| Springbok Fusion | walk | 244 | 30.7% | -0.287 | 15.70 | 8/8 |
| Scalper Pro | walk | 2477 | 42.1% | -0.017 | 38.87 | 6/8 |
| Breakout Momentum | revert | 83 | 26.5% | -0.435 | 10.12 | 7/8 |
| MACD Momentum | revert | 146 | 26.7% | -0.403 | 12.66 | 8/8 |
| Springbok Fusion | revert | 175 | 29.1% | -0.355 | 14.42 | 8/8 |
| Scalper Pro | revert | 2208 | 47.8% | +0.151 | 35.68 | 1/8 |

### higherCosts

Spread 0.1 ATR + slippage 0.05 ATR **per side**; gap probability 0% per tick.

| Strategy | Family | Trades | Win rate | Net R/trade | Worst-seed drawdown R | Losing seeds / seeds with trades |
|---|---|---:|---:|---:|---:|---:|
| Breakout Momentum | trend | 2065 | 96.8% | +3.054 | 1.68 | 0/8 |
| MACD Momentum | trend | 2653 | 87.4% | +2.604 | 5.04 | 0/8 |
| Springbok Fusion | trend | 3214 | 85.5% | +2.510 | 7.76 | 0/8 |
| Scalper Pro | trend | 541 | 86.3% | +1.925 | 4.14 | 0/8 |
| Breakout Momentum | walk | 119 | 30.3% | -0.302 | 11.50 | 8/8 |
| MACD Momentum | walk | 186 | 28.5% | -0.321 | 16.96 | 6/8 |
| Springbok Fusion | walk | 244 | 26.6% | -0.396 | 20.08 | 8/8 |
| Scalper Pro | walk | 2535 | 36.3% | -0.155 | 73.00 | 8/8 |
| Breakout Momentum | revert | 83 | 24.1% | -0.604 | 16.08 | 7/8 |
| MACD Momentum | revert | 144 | 25.7% | -0.518 | 15.34 | 8/8 |
| Springbok Fusion | revert | 175 | 26.9% | -0.498 | 15.43 | 8/8 |
| Scalper Pro | revert | 2225 | 43.3% | +0.029 | 49.29 | 4/8 |

### priceGaps

Spread 0.02 ATR + slippage 0.01 ATR **per side**; gap probability 1% per tick.

| Strategy | Family | Trades | Win rate | Net R/trade | Worst-seed drawdown R | Losing seeds / seeds with trades |
|---|---|---:|---:|---:|---:|---:|
| Breakout Momentum | trend | 2049 | 95.4% | +2.976 | 3.87 | 0/8 |
| MACD Momentum | trend | 2628 | 88.2% | +2.608 | 6.17 | 0/8 |
| Springbok Fusion | trend | 3263 | 86.0% | +2.517 | 6.29 | 0/8 |
| Scalper Pro | trend | 557 | 87.8% | +1.971 | 4.48 | 0/8 |
| Breakout Momentum | walk | 238 | 42.0% | +0.059 | 20.38 | 2/8 |
| MACD Momentum | walk | 351 | 38.2% | -0.184 | 20.83 | 6/8 |
| Springbok Fusion | walk | 491 | 39.3% | -0.084 | 25.21 | 4/8 |
| Scalper Pro | walk | 2146 | 41.3% | -0.025 | 60.53 | 4/8 |
| Breakout Momentum | revert | 182 | 31.3% | -0.382 | 16.23 | 7/8 |
| MACD Momentum | revert | 335 | 31.0% | -0.395 | 31.04 | 8/8 |
| Springbok Fusion | revert | 402 | 30.6% | -0.415 | 42.23 | 7/8 |
| Scalper Pro | revert | 1863 | 49.6% | +0.275 | 33.38 | 0/8 |

## 3. Default risk/protection checks

Fresh-account budget checks passed at **10 balances from $2 through $100,000**, without accessing a real account. Conditions: no open positions/P&L, current equity equals starting and UTC day-start equity. Later drawdown, reserved exposure and daily limits can reduce the available planned entry budget further.

- Conservative profile: **0.5% planned risk per trade**, **3% daily net-loss budget**, **one position**, aggression **3/10**.
- Break-even trigger **0.5R**; trail begins **1R**, at **0.35R** distance; profit locks and trailing enabled.
- Risk sizing and optional compounding enabled by default. Compounding changes both gains and losses; it is not a profitability improvement by itself.
- Default profit target is zero (no automatic profit ceiling), not unlimited or guaranteed profits.

| Fresh paper balance | Planned trade budget | Daily net-loss budget |
|---|---:|---:|
| $2.00 | $0.01 | $0.06 |
| $5.00 | $0.025 | $0.15 |
| $10.00 | $0.05 | $0.30 |
| $20.00 | $0.10 | $0.60 |
| $100.00 | $0.50 | $3.00 |
| $500.00 | $2.50 | $15.00 |
| $1,000.00 | $5.00 | $30.00 |
| $10,000.00 | $50.00 | $300.00 |
| $50,000.00 | $250.00 | $1,500.00 |
| $100,000.00 | $500.00 | $3,000.00 |

**The previously requested fixed $1 planned cash ceiling is still not implemented.** The default budget is $5 at $1,000 and $500 at $100,000, before other exposure/day constraints. These are planned budgets, not maximum realised-loss guarantees. Stop gaps/slippage can exceed them. Fractional paper lots do not validate broker minimum stakes or lot rules.

## 4. What these tests do NOT prove

- Fresh seeds come from the same known synthetic generators; they are **not independent historical data or an untouched real-market forward period**. Once inspected, this batch is development evidence, not a future pristine test set.
- Trend data has strong persistent drift. The very high trend win rates in the full tables are artificial-regime results, **not verified live 90–97% wins**.
- Fixed-size, single-position price-movement backtests exclude full account sizing, daily-stop/cooldown behavior and concurrent exposures. The unit tests cover aspects of these controls separately, not a measured full-account return.
- Costs are assumed ATR fractions, not measured broker spreads/quotes. Five-minute option payouts, early-sale availability, settlement and broker/network delays are not modelled.
- No representative historical broker backtest, authenticated demo-forward lifecycle test, cash-account performance guarantee or production deployment check was performed in this run.

## 5. Tuning decision and next work

The code passed its current safety/correctness tests and the conservative controls behave as configured, but **profitable tuning is not established**. I would not raise risk/aggression or enable real orders on the strength of these results.

Before treating the engine as live-ready: implement durable account-bound broker settlement/recovery and persistent hosting; obtain representative broker price/quote data for the actual instrument/payoff; tune entry/regime/cost rules on training data only; freeze the configuration; then evaluate untouched historical/forward periods and authenticated **demo** failures/restarts with measured costs and drawdown limits. Tightening stops alone cannot create an edge or guarantee a $1 realised loss ceiling.

## Reproducibility and raw evidence

Model fingerprint: `87d0effb764a2a0507d62144f05318f1763c9464bfffdab7df548466aff0a8f7`.

Protocol SHA-256 (written before evaluating the new batch): `16289b3af896e34d9b1f18a6bf5db49d56aa5f2fc66af59d773699cb1c6e493c`.

Seeds: `1137342960, 1144884002, 2800207688, 1028004703, 1362073898, 1572003428, 1971881746, 4202785735`.

Raw local/ignored artifacts: `test-results/engine-check-2026-11-08/` — environment, install/verification logs, dependency audit, frozen protocol, fresh stress JSON and risk-budget checks. Generated artifacts were kept out of Git. The shipped `REPORT-engine.md` and `engine/strategy-report.json` remain unchanged.

To reproduce the fresh stress metrics on this same model:

```bash
node <<'NODE'
const assert = require('node:assert/strict');
const E = require('./engine/strategies.js');
assert.equal(E.modelFingerprint(), '87d0effb764a2a0507d62144f05318f1763c9464bfffdab7df548466aff0a8f7');
const seeds = [1137342960, 1144884002, 2800207688, 1028004703, 1362073898, 1572003428, 1971881746, 4202785735];
const scenarios = {
  standard: {},
  higherCosts: { spreadAtr: 0.10, slippageAtr: 0.05 },
  priceGaps: { gap: 0.01 }
};
for (const [scenario, options] of Object.entries(scenarios)) {
  for (const family of ['trend', 'walk', 'revert']) {
    for (const id of E.STRATEGY_IDS) {
      const r = E.backtestMany(id, seeds, 5000, {
        ...options, family, params: E.paramsFor(id)
      });
      console.log(id, scenario, family, r.trades, r.winRate,
        r.expectancyR, r.maxSeedDrawdownR);
    }
  }
}
NODE
```

Environment at verification start:

```text
UTC run time: 2026-11-08T10:36:28Z
Commit: c85304c3cbf7cb3e484cb37754dcafc8be41c6b4
Branch: arena/4a8893c2-r-h-pilot
v22.22.3
10.9.8
Linux x86_64
```
