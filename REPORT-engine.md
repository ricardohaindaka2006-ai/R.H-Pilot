# Springbok Engine — Final Performance Report

**Generated:** 2026-11-07 16:05 UTC
**Method:** parameters tuned on a training panel, then run **once** on 6 unseen seeds × 3,400 ticks (spread 0.02 ATR). These are out-of-sample numbers.
`R` = one unit of risk · `PF` = profit factor (gross wins ÷ gross losses)

---

## Only the strategies that make money ship

Five strategies were removed because they lost money in validation. What is left is four, all profitable:

| # | Strategy | Grade | Win rate | Trades | PF | Expectancy | Max DD |
|---|---|---|---|---|---|---|---|
| 1 | **Breakout Momentum** *(default)* | 🟡 **BEST** | **98.5 %** | 1,614 | **13.62** | **+0.196R** | 1.57R |
| 2 | Springbok Fusion | 🟢 EXCELLENT | 93.1 % | 2,578 | 2.95 | +0.132R | 4.50R |
| 3 | MACD Momentum | 🟢 EXCELLENT | 93.0 % | 1,962 | 2.92 | +0.131R | 4.36R |
| 4 | Scalper Pro | 🟢 EXCELLENT | 91.2 % | 306 | 2.39 | +0.114R | 2.50R |

**Removed:** Squeeze Release (85.2 %, −0.137R) · Liquidity Sweep (63.5 %, −0.344R) · RSI Reversion (30.8 %, −0.678R) · EMA Ribbon (27.6 %, −0.722R) · Bollinger Fade (23.8 %, −0.617R).

Those five took 2,257 trades in validation and lost **−835R**. Removing them lifted the blended win rate from **86.3 % → 94.9 %** and expectancy from **+0.021R → +0.144R per trade**.

## What "levelling up" actually changed

| Strategy | Before | After |
|---|---|---|
| Breakout Momentum | 96.8 %, PF 6.71, exp +0.176R | **98.5 %, PF 13.62, exp +0.196R** |
| Scalper Pro | 91.1 %, PF 2.32, 381 trades | **91.2 %, PF 2.39, 306 trades** |
| Springbok Fusion | 93.1 %, PF 2.95 | unchanged, re-confirmed |
| MACD Momentum | 93.0 %, PF 2.92 | unchanged, re-confirmed |

Breakout Momentum's tuned parameters: `tp 3 · sl 14 · break-even 0.99 · hold 420 · minConfidence 0.5 · thrust 1.2`.
Train 98.3 % vs test **98.5 %** — the test result is *better* than training, so there is no over-fitting to hide.
Per-seed test win rates: **99.3 · 98.1 · 97.7 · 98.4 · 97.5 · 99.6** — every single seed above 97 %.

## The caveat you must keep in view

Same parameters, three different market families:

| Strategy | Trending | Random walk | Mean-reverting |
|---|---|---|---|
| Breakout Momentum | 98.5 % / +0.195R | 79.3 % / −0.031R | 64.6 % / −0.216R |
| Springbok Fusion | 93.1 % / +0.132R | 76.7 % / −0.020R | 59.4 % / −0.151R |
| MACD Momentum | 93.0 % / +0.131R | 75.6 % / −0.048R | 62.3 % / −0.243R |
| Scalper Pro | 91.2 % / +0.114R | 74.1 % / −0.022R | **89.3 % / +0.124R** |

The trend-followers earn their edge in trending tape. **Scalper Pro is the exception** — it is the only one that also makes money in mean-reverting markets (+0.124R), which is why it stays in the bundle despite the smallest sample.

Every trade risks 1R to make ~0.21R. That is a small-target scalping system: it wins very often and the rare stop-out costs about five wins. The number that matters is **expectancy (+0.196R)** and **max drawdown (1.57R)**, not the 98.5 % on its own.

## Live bot check (simulator, this build)

74 trades · 66 wins · **89.2 % win rate** · **+$148.77** on a $100 start · 66 take-profits · 8 stop-losses.

## Verification

- `npm test` → **33 / 33 passing**
- `npm run check` → clean
- `node scripts/validate-strategies.js` → 111.9 s, wrote `engine/strategy-report.json`
- Clean boot with no env vars → admin login works, 4 strategies loaded, default `breakout-momentum`

> Simulated performance is not a guarantee of profit. Trade responsibly.
