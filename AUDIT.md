# R.H Pilot — engine and risk-control audit

Date: **2026-11-08**. Scope: this repository revision, isolated local tests and the post-push CI evidence below, not a deployed installation or an independently verified trading record.

## Decision

**Paper research only; not approved for real-money execution.** New broker orders are blocked by the backend and UI. No authenticated broker forward test, real trade, deployment, or broker-authoritative settlement was performed during this work.

There is no demonstrated basis for promising a **90–97% win rate, zero losses, guaranteed growth, or preservation of a $2 balance**. Conservative settings reduce planned exposure; they do not create a proven trading edge. A high win rate alone can hide poor expectancy, costs, or occasional large losses.

## Findings and changes

| Priority | Finding | Change / remaining limitation |
|---|---|---|
| Critical | The old live path bought five-minute CALL/PUT options, while the paper/backtest P/L model measured underlying price movements. | New real-money orders fail closed, including stale armed flags. Low-level demo transport independently checks the exact selected account is virtual. Actual option lifecycle, settlement, stake reservation and recovery are still missing. |
| Critical | Pending/uncertain broker exposure could be treated as local paper state or discarded by lifecycle operations. | Contract IDs, pending/failed buys and account-bound uncertainty are preserved. Stop/resync/restart/account replacement/restore checks cannot manufacture broker settlement. Preserving a record does **not** close a broker position: review the Deriv statement. |
| High | Same-quote entries, clipped adverse gaps, terminal scratches and non-stateful exit assumptions overstated backtest evidence. | One shared execution implementation now handles next-tick entries, adverse costs on both sides, persistent break-even/trailing state, observed gap fills and one terminal mark. Losses beyond planned budgets are recorded in full. |
| High | Synthetic test results influenced candidate selection, and trend-only headlines implied broad profitability. | A frozen paper reference is selected from training families only. Separate diagnostic families, costs, gaps, per-seed losses and drawdowns are reported. Development reuses diagnostic seeds, so this is not an untouched final test or proof of a real edge. |
| High | Tiny balances could face oversized fixed-dollar risk floors or upward-rounded minimum clips. | Default planned risk is 0.5%, without $0.05 trade/$0.25 daily floors. Fractional paper clips floor to affordable precision, including multiplication-order boundaries; an unaffordable minimum is skipped. This is not validation of broker minimum stakes or lots. |
| High | Risk and daily-loss accounting could ignore aggregate exposure, lifetime-profit offsets, growth double counting or restarts. | Original open risk reserves shared portfolio/daily capacity. Risk percentage applies once. UTC net-realised loss and day-start equity drive a latched daily stop. Restart, resync, preset changes and disabling a numeric limit cannot clear an existing daily latch. |
| Medium | Timers, stale quotes and live/simulator jumps could age positions or invent P/L. | Evaluation uses fresh tick identities, retains equal-price distinct ticks, rejects stale observations and resets source histories. Source-transition/manual closes use the last same-source paper mark and disclose stale marks. |
| Medium | Changing settings could rewrite exits, leave old queued entries, or loosen incomplete legacy stop geometry. | New positions freeze exit rules. Settings changes discard queued entries. Missing legacy distances are reconstructed without replacing valid targets or loosening existing stops. Legacy paper results remain unvalidated. |
| Medium | Paper/synthetic metrics and connection status could be mistaken for live readiness. | UI labels paper execution, synthetic trend diagnostics and research-only strategies; live controls are disabled. Public health distinguishes report validity and the live-order block from web-process health. |
| High, unresolved | The included Render Free configuration uses ephemeral state. | No durable storage was provisioned. Persistent account-bound storage and restart reconciliation are prerequisites for any future broker execution. |

## Default settings and small accounts

New paper accounts use the **Conservative** profile (`safe` is retained as the compatibility ID):

- Planned stop risk/cash budget: **0.5% per trade**.
- Daily net-loss budget: **3% of UTC day-start equity**, with existing open risk reserved.
- **One** open position; aggression **3/10**.
- Break-even trigger **0.5R**; trail starts at **1R**, at **0.35R** distance. Stops only tighten; fills are not insured.
- Risk-based sizing and compounding enabled. There is no automatic martingale or higher recovery percentage after a loss.
- Auto uses the synthetic training reference, not whichever strategy displays the highest test win rate.

Balanced is 1%/5% with two positions; Aggressive is 1.5%/8% with three. The hard planned ceilings remain **1.5% per trade / 3% across open positions**, regardless of custom fixed-lot requests. Other guards and profit-lock controls are editable; existing exit snapshots are retained.

| Paper balance | Default planned trade risk | Default daily budget at day open |
|---:|---:|---:|
| $2 | $0.01 | $0.06 |
| $10 | $0.05 | $0.30 |
| $100 | $0.50 | $3.00 |

Growth changes dollars, not win probability. Given the same R outcome, gains **and losses** scale with size. Turning compounding off uses the lesser of starting and current equity, so growth no longer increases the base while drawdown still reduces it. Fractional paper precision reaches `0.00000001` lots; it is explicitly not a broker contract rule. Broker minimum stakes/costs can make a $2 real account unsuitable.

Tighter profit locks can exit winners early and reduce expectancy. These settings are cautious defaults, **not proven optimal parameters**. A gap can exceed daily/per-trade budgets and can exhaust or make paper equity negative; the engine must disclose the actual loss and stop rather than silently clip it or invent capital.

## Strategy evidence

See [REPORT-engine.md](REPORT-engine.md) and `engine/strategy-report.json` for reproducible figures, parameters and all stress scenarios.

- Model: `paper-tick-v2`, code fingerprint required for the report to load.
- Training: four seeds × 2,600 ticks per family. Diagnostic panel: six different seeds × 3,400 ticks per family; trend, random walk and mean reversion.
- Standard adverse cost per side: 0.02 ATR spread + 0.01 ATR slippage. Higher-cost scenario: 0.10 + 0.05 ATR per side. Gap scenario: 1% jump probability per tick.
- **No strategy clears the all-family training research floor.** Scalper Pro is only a training-ranked paper reference, not a validated recommendation.

Reference strategy, standard-cost synthetic diagnostics:

| Family | Trades | Win rate | Expectancy | Worst-seed drawdown |
|---|---:|---:|---:|---:|
| Trend | 299 | 83.3% | +1.782R | 6.29R |
| Random walk | 1,208 | 41.6% | +0.045R | 23.81R |
| Mean reversion | 1,065 | 48.5% | +0.216R | 13.39R |

Its higher-cost random-walk expectancy is **−0.068R**, with worst-seed drawdown **43.20R**. Breakout's 96.8% trend-generator win rate falls to 46.7% on random walk and 45.0% on mean reversion; it is not proof of the requested 90–97% real-market target.

These are fixed-size, single-position synthetic diagnostics. They do not validate account sizing/compounding, daily cash guards, custom exits, wall-clock cooldowns, option payouts, settlement, network delays, or broker execution. Detector confidence is not a calibrated win probability. The intentionally persistent trend generator inflates directional success; results must not be marketed as verified live performance.

## Local verification

Environment: Node **22.22.3**, npm **10.9.8**.

Executed successfully on this revision:

```sh
npm run validate:strategies
npm run verify:local
npm audit --omit=dev
git diff --check
```

- **15 JavaScript files** syntax-checked.
- **104/104 tests passed**, including dashboard palette/metadata, mobile navigation state, scrollable tables and dialog focus/background protection, plus $2 risk budgets, growth/shrinkage, optional compounding, unaffordable minimums, never-round-up boundaries, orderly losing sequences, editable protection, frozen exits, client form logic, HTTP validation, honest adverse gaps, tick/source identity, lifecycle and live-order blocking.
- The diagnostic report reproduced **exactly** from its frozen inputs. Reproducibility is not profitability validation.
- Local signal microbenchmark: 12,000 varying contexts, four strategies per tick, three synthetic families of 5,000 observations. Mean **0.0058 ms**, median **0.0038 ms**, p95 **0.0117 ms**, maximum **2.1517 ms**. These timings exclude broker/network latency, whole-engine multi-user load and execution quality.
- Runtime dependency audit: **0 reported vulnerabilities** at this check, not a comprehensive security certification.

### Dashboard design and local browser smoke checks

Implemented the supplied savanna/bronze reference in the actual dashboard: static acacia/springbok scenery, bronze emblem and panels, cream/gold type, red-ochre primary actions, bronze secondary actions, four-column desktop stats and two-column tablet/phone stats. Removed competing historical colour skins and continuous decorative animation. Sign-in, settings, tables, charts and dialogs use the same warm palette. Paper/execution/feed disclosures remain visible; sign-in no longer advertises verified millisecond order placement or production readiness.

Local **Chromium 153 + Playwright + axe-core** checks used an isolated paper-only preview user with broker linking blocked. Its temporary session/bootstrap and iframe exception were outside the repository; production authentication and framing headers were not relaxed.

- Screenshots reviewed at **1440×1050**, **820×1180** and **390×844**; no application JavaScript errors or automated WCAG 2 A/AA violations in the overview at those sizes.
- No overview horizontal overflow at **320, 375, 390, 620, 820, 1024 and 1440px**; correct two/four stat columns. Reduced-motion rendering checked. Browser-only display fixtures confirmed $100,000 balance and negative P/L fit in cards at 320px; that is a display check, not a funded-account test.
- Verified mobile Tab/Shift+Tab focus containment, Escape/focus return, scrim/close-button dismissal, active-page state and resizing an open drawer to desktop without leaving content inert.
- Navigated trading, markets, wallet, engine and support views; opened/closed the manual; saved a 0.25% paper-risk edit. Confirmed cancellation leaves the bot stopped, confirmation starts only paper mode and stopping succeeds. Verified dialog focus containment/background blocking.
- Automated WCAG 2 A/AA checks reported **zero violations in the checked mobile client views, navigation, manual, trade confirmation and sign-in state**. Fixed low-contrast footer text and keyboard-inaccessible horizontal tables. Added shaded section-heading surfaces after visual readability review. Automated checks cannot establish full accessibility, especially photographic backgrounds; no screen-reader or physical-device certification is claimed.

Browser tooling and screenshots are local/ignored verification artifacts, not production dependencies or a committed CI browser suite. The committed client form/focus unit tests additionally use minimal VM harnesses. This theme update does not implement a fixed $1 planned cash-risk ceiling: current dollar budgets still scale proportionally, and observed gaps can exceed planned risk.

The local public-only Deriv verification attempt failed before establishing TLS from this environment. After push, both GitHub Actions workflows passed on implementation commit `2e26f2f`: [syntax/simulator CI](https://github.com/ricardohaindaka2006-ai/R.H-Pilot/actions/runs/42471689090) and [verification](https://github.com/ricardohaindaka2006-ai/R.H-Pilot/actions/runs/42471689059). The latter's [public-only Deriv diagnostic](https://github.com/ricardohaindaka2006-ai/R.H-Pilot/pull/16#issuecomment-6720377088) succeeded from the GitHub runner: 89 active symbols, XAUUSD reported closed and an R_10 tick received. Production-deployment verification/publication steps were skipped for the PR. This confirms public market-data connectivity from that runner only—not authenticated account access, execution, settlement or profitability. Broker successes in unit tests are mocked; no authenticated external account/settlement/production verification is claimed.

Not performed: Docker build, deployment, representative historical broker backtest, authenticated demo-forward lifecycle validation, exhaustive browser/screen-reader coverage, or multi-user endurance/security testing.

## Prerequisites before any future real-money enablement

1. Implement durable account-bound exposure, uncertain-buy recovery, broker-authoritative P/L/settlement, stake/balance reservations and restart reconciliation. Never infer option profit from underlying movement.
2. Test the full lifecycle on demo: rejected/uncertain buys, failed/partial sells, expiry, disconnections and restarts. Confirm broker minimums, payout/cost rules and balances without sending real orders.
3. Use representative broker historical data, freeze settings, then forward-test genuinely unseen periods. Evaluate net expectancy, drawdown, tail loss, costs and sample size—not only win rate.
4. Provision persistent private storage, backups and operational monitoring. Review credentials, hosting, recovery and exposure handling separately from process health.
5. Keep the real-order block until these prerequisites have independently passed. No win-rate/profit/principal guarantee can replace them.
