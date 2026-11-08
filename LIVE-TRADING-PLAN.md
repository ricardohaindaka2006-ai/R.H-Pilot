# Real-trading product choice and hosting proposal

**Proposal only — no spending approval, upgrade, provisioning, deletion or real-order activation.** The user selected “Explain the difference first” and “Propose durable hosting”. A broker product has not yet been chosen. PR #18 implements client connection, not a completed real-trading system.

Pricing/source review date: **8 November 2026**. All estimates below are **USD per month**, not a Namibian-dollar quote or a guaranteed invoice.

## 1. Options and MT5/CFDs are different products

| Question | Deriv Rise/Fall Options | Deriv MT5 / CFDs |
|---|---|---|
| What is traded? | A contract with a stake, condition and specified expiry. | A position whose profit/loss changes with price movement and position size. |
| How does a direction prediction win? | For Rise/Fall, the contract condition must be satisfied at expiry; merely touching a paper target earlier is not settlement. | A buy benefits from a favorable rise and a sell from a favorable fall, net of the instrument's costs. Actual filled exits determine realized P/L. |
| How does it end? | Expiry/settlement, or an actual quoted early resale where the contract permits it. | A confirmed close, broker stop-loss/take-profit, or other broker liquidation event; no fixed option expiry. |
| Main risk accounting | Reserve the full potential contract loss, not a synthetic underlying-price stop. | Validate contract size, minimum lot, tick value, margin, spread, commissions and adverse fills. A stop is not insurance against slippage/gaps. |
| This repository today | Existing broker helper requests five-minute CALL/PUT contracts, but live execution is disabled. | No implemented or tested MT5 execution adapter. The Options token connection is not an MT5 trade connection. |

Deriv documents the fixed-duration/fixed-stake distinction, CFD leverage and their different management requirements. Some Options provide early resale; resale availability is not the same as a guaranteed price-based exit. These comparisons concern Rise/Fall, not every Deriv contract family. [5](https://traders-academy.deriv.com/trading-guides/guide-to-understanding-volatility-indices) [3](https://docs.deriv.com/marketing/2025/ebook-synthetics-en-hq.pdf)

**Technical fit:** the requested behavior—open a buy/sell position and manage price-based SL/TP, break-even and trailing exits—is closer to a **CFD/MT5 execution model** than to the current five-minute Rise/Fall helper. This is an architecture assessment, not a recommendation to invest, use leverage, or expect a particular win rate. A new adapter and real broker specifications are required either way; the paper engine's $100-per-price-unit notional is not a broker specification.

MT5 access must be resolved separately. MetaQuotes' Python integration connects to the MT5 **terminal**, with separate initialization/login, order-check/send, position and deal-history APIs. It is not a drop-in replacement for this application's Options REST/WebSocket account calls. A supported execution route, terminal/bridge hosting, credentials and per-account isolation must be verified before selecting or pricing that component. [1](https://www.mql5.com/en/docs/python_metatrader5)

Neither product establishes a trading edge. Faster computation cannot guarantee profitable trades, zero losses, 90–95% wins or microsecond broker fills. Keep the current fail-closed real-order gate while the product decision and lifecycle implementation remain unresolved.

## 2. Keep one canonical bot

Keep `ricardohaindaka2006-ai/R.H-Pilot` and the existing `r-h-pilot-3` application as the canonical product. Supporting storage is not a second competing bot.

Proposed initial topology:

```text
Existing GitHub repository
           |
           v
One always-on Render web service: dashboard + API + one execution leader
           |
           +-- private durable PostgreSQL: users, sessions, risk, orders, settlements
           |
           +-- chosen broker execution adapter
                 Options API OR a separately verified MT5 execution bridge
```

Do not create a second public bot or delete an unidentified service. Render's actual service inventory is still unverified. No additional worker, cache or database has been provisioned.

## 3. Monthly hosting options

Published Render rates checked for this proposal: 512 MB web compute **$7**, 2 GB web compute **$25**, 256 MB Postgres compute **$6**, 1 GB Postgres compute **$19**, Postgres storage **$0.30/GB**, and persistent disks **$0.25/GB**. Workspace fees are separate: Hobby **$0**, Pro **$25**. [2](https://render.com/pricing)

| Proposal | Components | Compute/storage subtotal | With a $25 Pro workspace |
|---|---|---:|---:|
| Minimum durable demo | $7 web + 1 GB persistent disk ($0.25) | **$7.25/month** | **$32.25/month** |
| Preferred small-pilot architecture | $7 web + $6 Postgres + 5 GB database storage ($1.50) | **$14.50/month** | **$39.50/month** |
| More memory/CPU headroom | $25 web + $19 Postgres + 5 GB database storage ($1.50) | **$45.50/month** | **$70.50/month** |

These totals are arithmetic estimates using the cited published rates. They assume one continuously running application and the listed storage. Taxes, usage overages, external backup storage, MT5 bridge/VPS/licensing and broker/market fees are **not included**. They are not a high-availability/SLA or client-capacity commitment. The existing account's actual workspace, payment method and bill have not been inspected.

**Suggested direction, subject to approval:** use the **$14.50 compute/database pilot** to implement and validate the architecture; budget **$39.50/month if selecting the Pro workspace**. Confirm capacity with representative client/demo load before a customer launch, and resize if needed. The larger $70.50 configuration is an option, not an assumed purchase or proof of production readiness.

The minimal disk option is useful for a single-instance durable demo but retains the JSON store's single-writer constraints. The PostgreSQL option is the preferred design for atomic risk/order reservations and recovery, but **the PostgreSQL storage adapter/migration has not yet been implemented**. Attaching a database to the existing code does not move its data automatically.

Free hosting is not the proposed execution platform: Render documents idle spin-down, local-file loss on redeploy, and expiry of free Postgres. A paid compute plan alone also does not make the current local data directory persistent. [3](https://render.com/docs/free)

## 4. Engineering and acceptance sequence

1. **Choose Options or MT5/CFDs.** Confirm supported instruments, account types and the broker's execution route without sharing secrets in chat.
2. **Approve an itemized hosting design and spend limit.** Confirm the canonical service and any exact obsolete cleanup targets. For MT5, obtain a separate bridge/terminal quote first; the Render figures above are not the complete MT5 cost.
3. **Implement durable storage before live activation.** Migrate existing users/licences/sessions and risk history without resetting financial state. Preserve token encryption with a separately retained environment key. Demonstrate encrypted backup/restore and restart recovery.
4. **Build the selected broker ledger.** Persist account-bound order intents/reservations before submission; record broker IDs and authoritative balances, fills, charges and settlements. Treat an ambiguous buy as unresolved exposure, not an invitation to retry. Recover and reconcile before new entries after restart/disconnection.
5. **Demo-test actual lifecycle failures.** Include rejection, delayed/lost acknowledgments, disconnect, early-sell failure or stop-order failure, expiry, partial fills where relevant, storage faults and restart with open exposure. Multiple clients must not contend for or duplicate a single account's execution authority.
6. **Validate risk and evidence.** Broker minimum stake/lot and charges must fit the mandatory budget; otherwise skip the trade. Keep no daily trade-count/default-profit ceiling, while honoring protective stops. Revalidate any strategy against the selected instrument's real payoff/costs; do not port synthetic win rates into a live claim.
7. **Review before a real-execution gate.** Product correctness, demo evidence, security, customer consent, operating permissions, monitoring and rollback/recovery must pass review. Configure production App ID, callback and secrets through secure hosting/application interfaces, not chat.

## Decision needed next

Select **Deriv Options** or **MT5/CFD scalping**. The technical preference above does not choose on the user's behalf. Hosting remains a proposal; no purchases or upgrades are authorized by choosing to receive this estimate.
