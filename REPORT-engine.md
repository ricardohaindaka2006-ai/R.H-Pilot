# Springboks engine — corrected synthetic diagnostic

Generated: 2026-11-08T09:36:09.899Z

**Live readiness: NOT approved. No strategy guarantees profit. New broker orders are blocked in this build.**

The previous report is superseded: it described a different exit geometry, selected candidates using its test panel, and relied on flawed backtest/accounting behaviour. Its headline results must not be used as trading evidence.

## Method

One frozen shipped configuration per strategy. Four training seeds per family, then six separate diagnostic seeds × 3400 ticks per family. Parameters are not selected using the test results. Paper auto reference: **scalper-pro**, selected on training score, not test win rate. Strategies clearing the training research floor: none. This is not a recommendation to trade.

Signal at tick i; entry at i+1. Both sides pay 0.02 ATR spread plus 0.01 ATR slippage. The same stateful exit implementation powers the paper bot (break-even at 0.5R; trail starts at 1R with 0.35R distance). A gap can lose more than 1R. Terminal exposure is marked to market once. 1R = initial planned stop distance. Drawdown below is the worst individual seed, not a cash-account forecast.

## Synthetic diagnostic panel

| Strategy | Family | Trades | Win rate | Expectancy R | PF | Worst-seed DD R |
|---|---|---:|---:|---:|---:|---:|
| Breakout Momentum | trend | 1034 | 96.8% | 3.075 | 142.05 | 1.93 |
| Breakout Momentum | walk | 60 | 46.7% | 0.067 | 1.11 | 7.82 |
| Breakout Momentum | revert | 40 | 45.0% | 0.078 | 1.15 | 8.01 |
| MACD Momentum | trend | 1337 | 86.3% | 2.586 | 23.03 | 4.00 |
| MACD Momentum | walk | 96 | 43.8% | 0.047 | 1.08 | 8.50 |
| MACD Momentum | revert | 85 | 37.6% | -0.061 | 0.90 | 7.42 |
| Springbok Fusion | trend | 1620 | 84.9% | 2.516 | 18.62 | 3.47 |
| Springbok Fusion | walk | 124 | 41.9% | 0.025 | 1.04 | 8.62 |
| Springbok Fusion | revert | 101 | 38.6% | -0.068 | 0.88 | 7.24 |
| Scalper Pro | trend | 299 | 83.3% | 1.782 | 10.05 | 6.29 |
| Scalper Pro | walk | 1208 | 41.6% | 0.045 | 1.08 | 23.81 |
| Scalper Pro | revert | 1065 | 48.5% | 0.216 | 1.46 | 13.39 |

## Adverse-cost and gap scenarios

Higher costs: 0.10 ATR spread + 0.05 ATR slippage per side. Gaps: 1% jump probability per tick with standard costs.

| Strategy | Scenario / family | Trades | Expectancy R | Worst-seed DD R |
|---|---|---:|---:|---:|
| Breakout Momentum | higherCosts / trend | 1016 | 3.066 | 1.62 |
| Breakout Momentum | higherCosts / walk | 60 | 0.018 | 7.86 |
| Breakout Momentum | higherCosts / revert | 40 | -0.155 | 7.54 |
| Breakout Momentum | priceGaps / trend | 1065 | 3.019 | 4.25 |
| Breakout Momentum | priceGaps / walk | 100 | 0.117 | 9.05 |
| Breakout Momentum | priceGaps / revert | 76 | -0.117 | 13.12 |
| MACD Momentum | higherCosts / trend | 1318 | 2.554 | 3.85 |
| MACD Momentum | higherCosts / walk | 95 | -0.062 | 10.02 |
| MACD Momentum | higherCosts / revert | 84 | -0.294 | 11.25 |
| MACD Momentum | priceGaps / trend | 1339 | 2.590 | 4.29 |
| MACD Momentum | priceGaps / walk | 167 | 0.049 | 13.39 |
| MACD Momentum | priceGaps / revert | 151 | -0.183 | 22.87 |
| Springbok Fusion | higherCosts / trend | 1585 | 2.479 | 4.37 |
| Springbok Fusion | higherCosts / walk | 124 | -0.123 | 11.98 |
| Springbok Fusion | higherCosts / revert | 102 | -0.310 | 11.72 |
| Springbok Fusion | priceGaps / trend | 1660 | 2.510 | 4.11 |
| Springbok Fusion | priceGaps / walk | 223 | 0.041 | 17.44 |
| Springbok Fusion | priceGaps / revert | 185 | -0.202 | 30.32 |
| Scalper Pro | higherCosts / trend | 297 | 1.762 | 5.34 |
| Scalper Pro | higherCosts / walk | 1231 | -0.068 | 43.20 |
| Scalper Pro | higherCosts / revert | 1105 | 0.036 | 19.90 |
| Scalper Pro | priceGaps / trend | 294 | 1.837 | 4.51 |
| Scalper Pro | priceGaps / walk | 1108 | 0.001 | 41.58 |
| Scalper Pro | priceGaps / revert | 918 | 0.287 | 23.55 |

## Limits and deployment decision

- All prices are deterministic synthetic data, not historical or live market observations.
- The trend generator has strong persistent drift; very high win rates on it are not a live forecast.
- Diagnostic seeds are excluded from this script's selection but reused during development; they are not an untouched final test.
- R is planned stop-distance risk. Adverse gaps can lose more than 1R; fills are not clipped.
- Signals fill on the next tick. Every entry and exit pays adverse spread and slippage.
- Paper profit locks and trailing exits share code with the server. Auto follows one training-selected reference.
- These fixed-size single-position tests exclude account sizing, daily stops, wall-clock cooldowns and legacy positions.
- Detector confidence is a heuristic ranking score, not the probability that a trade wins.
- Deriv five-minute options payouts, early-sale availability, settlement and network delays are NOT modelled.
- No real-market or broker-authoritative forward validation has been performed. New live orders are disabled.

Before real funds: implement durable account-bound contract tracking and broker-authoritative profit/settlement; verify rejected/uncertain buys, failed sells, expiry and restarts on demo; collect representative historical ticks and broker quotes; freeze settings and forward-test unseen market periods with realistic costs and drawdown limits. The included Render Free configuration uses ephemeral storage and is not appropriate for persistent trading state.

Regenerate with `npm run validate:strategies`; verify reproducibility with `npm run validate:strategies -- --check`. Machine-readable results: `engine/strategy-report.json`.
