# ApexAI strategy review and research translation

## Decision

The supplied Python example was **not copied directly or used as a live strategy**. Its useful confluence ideas were translated into the existing Node.js, tick-based research engine as `apex-confluence` (`Apex Trend Confluence`) in `engine/strategies.js`. It is selectable for paper research only. It does not place broker orders, and it is not the production reference.

## What needed correction

- The source's `BUY_SWEEP` test is a break above a recent high; it does not require a wick through a level followed by a candle close back below it. That is a range break, not a confirmed liquidity sweep. The current engine receives ticks rather than OHLC candles, so it cannot reliably evaluate that wick/reclaim pattern.
- EMA direction, EMA slope, RSI, and the generic liquidity bonus are not consistently tied to the proposed trade direction. Bullish trend points can therefore inflate a sell score (and the reverse).
- The RSI calculation treats a no-loss window as RSI 100, including a flat window; that is not a neutral reading. The nearby-high/low structure comparison is only a short lookback comparison, not confirmed swing structure.
- The confidence value is a hand-built score, not a calibrated probability. ATR/range thresholds do not supply evidence of an edge.
- The example supplies no order sizing, spread/commission/slippage model, exit lifecycle, restart handling, or validation evidence. A good signal score alone cannot show net profitability.

## What the translated candidate does

It reuses directionally consistent ideas while staying compatible with the actual engine input:

- Requires 205 ticks before building its EMA20/50/200 context. EMAs are computed directly over a bounded history of up to 800 ticks without allocating large per-tick arrays; the existing strategies retain their 90-observation base warmup.
- Chooses direction only from a fully aligned EMA20/50/200 stack; uses a five-tick EMA20 slope comparison and rejects a contradictory five-versus-five tick structure or opposing range break.
- Applies direction-specific RSI bands (long 50–70, short 30–50) and the existing trend-regime gate. It rejects an ATR/slow-ATR ratio above 1.9.
- Scores the aligned stack (25), RSI band (10), slope (15), structure (20), range break (15), and acceptable volatility (15). It requires at least 0.80 confidence. This is a deterministic filter score, not an 80% win probability.
- A tick-derived break beyond the preceding range is used instead of calling the event a liquidity sweep. No wick/reclaim claim is made.
- Frozen candidate geometry is TP 6 ATR, SL 2 ATR, and a 420-tick time limit. It uses the shared paper exit code: break-even trigger at +0.5R, trailing from +1R at a 0.35R distance. Stops are triggers, not guaranteed fills; gaps and adverse costs can still turn a gain into a loss.

These are cautious research settings, not optimized or proven best settings. No test results were used to alter them.

## Synthetic diagnostic results

Reproduced in `REPORT-engine.md` and `engine/strategy-report.json` using four training seeds per family (2,600 ticks per seed) and six diagnostic seeds per family (3,400 ticks per seed), with trend, random-walk, and mean-reverting synthetic families. Standard fills charge adverse 0.02 ATR spread and 0.01 ATR slippage on both sides. The report also includes higher-cost and price-gap stress cases.

| Apex confluence panel | Trades | Win rate | Expectancy |
|---|---:|---:|---:|
| Training / trend | 27 | 70.4% | +2.018R |
| Training / random walk | 22 | 40.9% | +0.037R |
| Training / mean reversion | 17 | 29.4% | -0.487R |
| Diagnostic / trend | 53 | 67.9% | +1.957R |
| Diagnostic / random walk | 38 | 44.7% | +0.062R |
| Diagnostic / mean reversion | 28 | 28.6% | -0.418R |

The candidate does **not** clear the training research floor (too few trades in two families and negative mean-reversion expectancy). Its training score is -0.5241, below the current Scalper Pro paper reference at +0.1711. **No strategy clears the all-family training floor; `best` remains null.** The Apex results are synthetic diagnostics—not historical/live evidence, and not a forecast. The diagnostic seeds have been reused during development, so they are not an untouched final test.

## Profit protection and speed

The work retains the shared, tested paper profit-protection implementation rather than adding a separate Apex exit path. Defaults move the stop to break-even after +0.5R and begin trailing after +1R with a 0.35R gap. This improves how a favorable move is managed in the paper model; it does not guarantee a winning exit.

The latest full local verification benchmark ran 12,000 contexts × five strategies across three synthetic families: mean **0.0172 ms**, median **0.0149 ms**, p95 **0.0214 ms**, maximum **4.5995 ms**. The p95 is well below the script's 5 ms budget; the single maximum is a local timing outlier. This measures local context/signal computation only—not MT5/CFD quote or network latency, broker response, order fills, or 24/7 reliability.

## Launch status

The candidate is research-only. MT5/CFD spreads, commissions, financing, contract specifications, margin, order rejection/reconciliation, broker latency, account-bound execution, and demo forward results are not modeled here. Real orders remain disabled. Do not treat synthetic paper performance as evidence that the engine is ready for live money or capable of maximizing profit/minimizing losses.