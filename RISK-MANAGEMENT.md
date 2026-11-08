# Paper risk management — policy and verification

Updated **2026-11-08**. This implements stronger controls, not a verified “world’s best” system, a profitable strategy, or insurance against losses. **New demo/real broker orders remain disabled.** Dollar figures describe the paper ledger, not a reconciled broker wallet or validated currency conversion.

## Mandatory controls

These backend ceilings in `engine/risk.js` apply to every preset and to custom/fixed-lot requests. Editable settings can make exposure smaller, not remove these ceilings.

| Control | Enforced behavior |
|---|---|
| Planned risk per new trade | Lesser of **$1**, **1.5% of current paper cash**, the requested risk percentage/cash budget and all remaining shared budgets. |
| Total original planned open risk | Lesser of **$2** and **3% of current paper cash**. Moving an existing stop to break-even does not free its original reservation. |
| UTC-day net realised loss | At most **3% of day-start paper equity**, or a smaller chosen cash budget. `dailyLossLimit: 0` retains the mandatory ceiling; it no longer disables daily protection. Today's net profits offset today's losses, not losses on another day. |
| Account drawdown rail | **10% below the realised-cash high-water mark**. Adverse same-source open marks count toward the rail; unrealised winners do not fund risk or raise the cash watermark. A breach latches an entry halt; valid paper positions are flattened on a fresh tick using observed fills. |
| Loss-streak hold | **Three consecutive losing closes pause new entries for five minutes**. Another consecutive loss extends the pause. A scratch does not reset the streak. A winner resets the streak count but cannot cancel an already active timer. Existing exits remain managed. |
| New-entry capacity | Original open risk is reserved against portfolio, day and remaining drawdown headroom. There is no recovery-bet doubling. Affordable paper lots round down; unaffordable clips are skipped. |
| Trading frequency | **No daily trade-count ceiling** and no default profit target. `maxTrades` means simultaneously open positions, not trades per day. Entry pacing, exposure limits, market hours and safety holds remain. |
| Data/execution safety | Fresh, finite, same-source observations; next-tick entries; no simulator/live price bridging. Invalid/future/missing timestamps cannot execute queued entries. Frozen existing exits and full actual gap accounting remain intact. |

**These are planning limits and stop triggers, not maximum realised losses.** An adverse gap, stale market, outage or costs can exceed $1, the daily budget, the drawdown rail, or the entire paper balance. Tests deliberately require an extreme gap to produce negative equity instead of clipping losses. Broker minimum lots, actual payouts, fees, settlement and execution are not validated by paper fractions.

## Defaults and growth

Conservative remains **0.5% requested planned risk**, one position, aggression 3/10, compounding and break-even/trailing enabled. Balanced requests 1%/two positions; Aggressive requests 1.5%/three positions. **All three use a 3% daily ceiling and the same mandatory cash/drawdown rules.** Conservative break-even/trailing remains 0.5R / 1R / 0.35R.

Fresh accounts, no open exposure/P&L, before any tighter constraints:

| Paper balance | Conservative planned trade budget | Daily budget at day open | Maximum shared open-risk budget |
|---:|---:|---:|---:|
| $2 | $0.01 | $0.06 | $0.06 |
| $10 | $0.05 | $0.30 | $0.30 |
| $100 | $0.50 | $3.00 | $2.00 |
| $500 | $1.00 | $15.00 | $2.00 |
| $1,000 | $1.00 | $30.00 | $2.00 |
| $100,000 | $1.00 | $3,000.00 | $2.00 |

The default single-position setting can be tighter than the shared open-risk budget. Compounding increases planned dollars only **until the $1 ceiling**, not indefinitely to $500/trade on a $100k balance. Turning it off uses the lesser of starting/current cash; losses can reduce size or stop trading entirely. Larger balances do not establish a higher win probability or guaranteed growth.

## Persistence and bypass resistance

- Account watermark, drawdown latch, loss streak and pause deadline are persisted. Pre-policy stores reconstruct the best known cash peak and available recent losing streak rather than treating a depleted account as a new bankroll. Truncated/legacy history is not an authoritative broker record.
- Start, settings, stop/flatten, new accepted paper exposure, realised closes, guard transitions and resync use critical state saves. Files are written to an owner-only temporary file, file-synced, atomically renamed, and parent-directory-synced on non-Windows hosts. Ordinary state also retains periodic saves.
- A failed state write **halts entries for all users**, clears queued entries, rejects a staged paper entry without inventing P/L, and reports degraded `/api/health` with HTTP 503. Critical start/settings operations cannot report success when persistence fails. A successful retry clears storage degradation, but does not automatically restart stopped bots.
- Corrupt/unreadable databases, malformed risk/position containers and unfinished `.tmp` writes **fail startup closed** rather than creating fresh users, balances or credentials. The original files remain available for review.
- Starting balances may seed only never-traded paper accounts. Restart, preset changes, custom fields and soft/hard resync cannot erase cash history, an account drawdown latch, an active loss pause, or the current day's loss latch. A UTC rollover clears only the daily latch; stopped bots still require manual restart. The account drawdown latch has **no automatic or UI reset**.
- Backup restore validates before replacing the database and uses the same durable writer. It rejects open-exposure snapshots, account removal and rollback of an existing account's balance/risk ledger. An old backup cannot be a UI shortcut around a newer loss or hold.
- Malformed/unpriceable paper exposure is preserved and blocks new risk; it is not silently removed or recorded as a fake scratch. Uncertain broker positions remain separately blocked for reconciliation; they are never synthetically settled.

These controls assume **one server process and persistent storage**. They are not a distributed transaction database, tamper-proof external ledger, independently audited security system, or broker-authoritative execution journal. File sync cannot protect against lost/ephemeral volumes, an operator overwriting data, storage hardware faults, or multiple independent writers. The included free-host deployment has not been converted to durable hosting by this change.

### Operator recovery

1. Stop the sole server process. Preserve copies of **both** `db.json` and any `db.json.tmp`; do not blindly delete an unfinished write or initialise fresh accounts.
2. Review the latest complete state/backup, paper positions, cash/P&L, watermark, daily latch and pause deadlines. Reconcile any historical broker contracts against the actual broker statement; this app cannot prove their settlement.
3. Restore only validated state that retains the financial/risk history. The admin restore endpoint intentionally refuses older contradictory ledgers. Offline recovery requires operator review, not a “clear risk” button.
4. Correct permissions/capacity/storage failures, keep `DATA_DIR` on a persistent volume, and run one writer. Backups contain credentials/tokens/session data: restrict access and never commit or share them in chat.
5. Check health and the account's risk status before a deliberate manual restart. A drawdown stop is a reason to review/stop the paper experiment, not automatically restart trading with invented capital.

## Verification performed

Local run started **2026-11-08T11:18:19Z**, Node **22.22.3**, npm **10.9.8**:

```sh
npm run verify:local
npm audit --omit=dev
# Focused new regressions:
node --test --test-reporter=spec test/risk-rails.test.js
git diff --check
```

- **17 JavaScript files** syntax-checked; **131 tests passed**, zero failures/skips/cancellations. The 27 new risk-rail regressions augment the previous 104 tests; changed growth tests now require cash-ceiling saturation rather than unbounded scaling. Losing-sequence tests advance past the mandatory pause instead of disabling it. Affordability and full gap-loss assertions remain.
- Includes **162 sizing combinations** across $0.01–$100k, all presets, auto/fixed sizing and zero/tight/oversized optional caps; shared original reservations; adverse marks/headroom; daily-zero behavior; persistent drawdown/pause/day states; legacy migration; restart/UTC/resync/backup bypass attempts; malformed inputs; durable-writer fault injection; and HTTP degraded-health behavior.
- A runtime regression closes **260 winners** and then accepts another next-tick paper entry, distinguishing display-log retention/concurrent slots from a daily count limit. This is a constructed software test, **not** a measured profitable trading record.
- The frozen strategy diagnostic reproduced **exactly**. Strategy parameters, `paper-tick-v2` execution and shipped performance tables were not retuned to manufacture a win rate. No strategy clears the all-family training research floor; real execution remains blocked.
- Latest full local signal-only benchmark after adding Apex Confluence: 12,000 contexts × five strategies; mean **0.0172 ms**, median **0.0149 ms**, p95 **0.0214 ms**, maximum **4.5995 ms** (one local timing outlier). This excludes the file-sync path, full-account/multi-user load, MT5/CFD quote and network latency, broker execution and slippage. It is not order-execution speed or a 24/7 reliability test; the earlier four-strategy timing is superseded.
- Runtime dependency audit: **0 reported vulnerabilities**, not a comprehensive security certification.

Raw local logs are ignored under `test-results/risk-hardening-2026-11-08/`. Historical pre-hardening performance evidence remains in [ENGINE-TEST-RESULTS.md](ENGINE-TEST-RESULTS.md); its old uncapped cash-risk table is explicitly superseded by this policy.

**Not established:** an independently verified 90–95% live win rate, positive daily expectancy, profits 24/7, principal preservation, production deployment/health, representative historical or authenticated demo-forward results, multi-user endurance, new real-browser/accessibility certification, or broker settlement/restart recovery. Stronger risk controls limit exposure; they do not turn an unproven strategy into a profitable one.
