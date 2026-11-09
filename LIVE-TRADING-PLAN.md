# Separate Deriv Options and MT5/CFD modes — Render and hosting proposal

**Decision recorded: two separate product modes — (1) Deriv Options, covering Rise/Fall and Digit Matches/Differs, and (2) MT5 / CFDs. Render is the selected hosting target.** These are scope choices only: not approval to spend, upgrade, provision, delete, deploy, or activate real orders. Each mode needs its own broker adapter, account binding, price/contract data, risk ledger and full order/settlement/reconciliation lifecycle. The existing Deriv connector authenticates/selects accounts but is not a running bot order adapter; no MT5 execution adapter exists. Durable storage, hosting configuration and both broker routes remain unresolved.

Pricing/source review date: **8 November 2026**. All estimates below are **USD per month**, not a Namibian-dollar quote or a guaranteed invoice.

## 1. Three distinct execution products; two separate modes selected

The Deriv Options mode must support both requested contract families. MT5/CFDs are a separate route; they are not a Deriv Options setting or fallback.

| Question | Deriv Rise/Fall Options | Deriv Digit Matches/Differs | MT5 / CFDs |
|---|---|---|---|
| What is traded? | A fixed-stake contract with a direction condition and broker-defined duration/expiry. | A fixed-stake digit contract: Matches predicts a selected last digit; Differs predicts a different last digit at contract expiry. | A leveraged or unleveraged position whose P/L changes with price and position size. |
| How does it end? | Broker settlement at expiry, or actual quoted early resale where the contract permits it. | Broker settlement at expiry under the selected digit condition; any early sale must be supported and confirmed by the broker. | Broker-confirmed close, stop/take-profit or liquidation; no fixed option expiry. |
| Main risk accounting | Reserve the full potential stake loss and use the broker's quoted contract terms; paper price stops are not settlement. | Reserve the full potential stake loss and use the broker's quoted digit payout/proposal; paper price stops are not settlement. | Validate contract size, minimum lot, tick value, margin, spread, commissions and adverse fills; a stop cannot insure against gaps/slippage. |
| This repository today | Deriv account authentication/selection and quote checks exist. A low-level CALL/PUT demo helper is not integrated with bot entries; no complete Options lifecycle is enabled. | No bot strategy, proposal/buy path or settlement lifecycle is implemented. | No implemented or tested MT5 execution adapter. The Deriv token connection is not an MT5 trade connection. |

The Deriv connector can identify demo and real account types, but account access or quote permission is not order permission. No live order route is enabled. Deriv's fixed-duration/fixed-stake model and CFD leverage/position management are materially different; cited comparisons here concern Rise/Fall and CFDs, not every contract family. [5](https://traders-academy.deriv.com/trading-guides/guide-to-understanding-volatility-indices) [3](https://docs.deriv.com/marketing/2025/ebook-synthetics-en-hq.pdf)

The paper bot's price-based SL/TP, break-even and trailing behavior is not a substitute for an Options contract proposal, stake, contract ID, sale quote and settlement. The selected Options and MT5/CFD modes therefore need separate entry and close state machines, quote sources, risk reservations and broker-authoritative P/L. The shared website/account layer must never permit a Deriv account, quote, position or ledger to be silently routed into an MT5 request or vice versa.

MetaQuotes' Python integration connects to an MT5 **terminal**, with separate initialization/login, order-check/send, position and deal-history APIs. It is not a drop-in replacement for the application's Options REST/WebSocket account calls. The actual MT5 broker, supported terminal/bridge hosting, credentials and per-account isolation must be verified before selecting or pricing that component. [1](https://www.mql5.com/en/docs/python_metatrader5)

Neither mode establishes a trading edge. Faster computation cannot guarantee profitable trades, zero losses, 90–95% wins or microsecond broker fills. Keep the fail-closed real-order gate while each broker-specific lifecycle and independent safety review remain incomplete.

## 2. Keep one canonical bot

Keep `ricardohaindaka2006-ai/R.H-Pilot` and the existing `r-h-pilot-3` application as the canonical product. Supporting storage is not a second competing bot.

Proposed target topology (not deployed):

```text
Existing GitHub repository
           |
           v
Render web service: dashboard + API + authenticated mode selection
           |
           +-- private durable database: users, sessions, mode-scoped risk/order/settlement ledgers
           |
           +-- Deriv Options adapter: Rise/Fall + Digit Matches/Differs
           |       exact Deriv account, proposal/buy/sell/settlement state
           |
           +-- separate MT5/CFD adapter: terminal or verified broker gateway
                   exact MT5 account, symbol rules, orders/positions/deals
```

Sharing a login or dashboard does not mean sharing broker credentials, quotes, risk budgets or positions. Every order intent and session limit must be bound to an exact user, mode and broker account. No adapter may silently fall back to the other mode. Do not create a second public bot or delete an unidentified service. Render's actual service inventory is still unverified; no additional worker, cache or database has been provisioned.

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

1. **Resolve both broker routes independently.** Confirm the Deriv Options API capabilities for Rise/Fall and Digit Matches/Differs (demo first, then any real-account approval) and the actual MT5 broker/terminal bridge. Define exact-account ownership for each; never share or fall back across modes.
2. **Approve an itemized Render design and spend limit.** Render is the selected host, but the existing account/service inventory, production secrets and durable database are unverified. Confirm the canonical service and any exact obsolete cleanup targets. Obtain separate quotes for the MT5 bridge/terminal and any Deriv/broker fees; the Render figures above do not include these.
3. **Implement durable, mode-scoped storage before execution.** Migrate existing users/licences/sessions and risk history without resetting financial state. Persist exact broker account, product mode, settings, intents, positions, fills, exits, fees, settlements and reconciliation state. Preserve encryption keys separately; demonstrate backup/restore and restart recovery.
4. **Build separate broker lifecycles.** Deriv Options needs proposal validation, a durable stake reservation, buy/contract ID, confirmed sell where supported, expiry/settlement and authoritative P/L for both contract families. MT5/CFD needs account/symbol validation, order check/send, confirmed positions/deals and close/P&L. Persist account-bound intents before submission. An ambiguous submit is unresolved exposure, never an automatic retry.
5. **Demo-test each mode and cross-mode isolation.** Exercise rejection, delayed/lost acknowledgments, disconnect, early-sell/stop failure, expiry, partial fills where relevant, storage faults and restart with open exposure. Prove demo and real account identity is broker-confirmed; ensure one client/mode cannot read or act on another account.
6. **Enforce risk, consent and entry limits.** Broker minimum stake/lot and charges must fit the budget or the trade is skipped. The implemented per-session entry cap currently governs paper fills only; each future broker adapter must reserve a session entry slot before submission so timeouts/retries cannot bypass it. Keep no daily trade-count/default-profit ceiling unless separately configured; safety limits remain mandatory. Validate strategies on representative data for each contract payoff/cost model; do not port synthetic win rates into a live claim.
7. **Review before any real-execution gate.** Product correctness, complete demo evidence, security, customer consent, permissions, monitoring, and rollback/recovery must pass independent review. Configure App IDs, callbacks and secrets through secure hosting/application interfaces, never chat.

## Decision recorded and next blockers

The user selected **two separate modes**—Deriv Options (**Rise/Fall and Digit Matches/Differs**) and **MT5/CFDs**—and **Render** hosting. The per-session entry limit is a paper feature for now, not evidence of a broker-safe order cap. Deriv Options account login/selection and public market data exist, but the bot does not yet run either requested Options family end to end. The Deriv demo CALL/PUT helper is not wired into bot entries or settlement. No MT5 terminal bridge, CFD broker connection or order lifecycle is implemented. The paper price-based engine and its synthetic sizing are not broker specifications or broker P/L.

The implementation plan is therefore two independent routes:

- **Deriv Options:** confirm API support and contract terms for Rise/Fall and Matches/Differs, exact demo/real account IDs, proposal prices, duration, stake and payout; then implement durable buy, contract tracking, permitted early sale and expiry settlement. Do not use the CFD price-stop model as an Options settlement model.
- **MT5/CFDs:** confirm the actual broker, supported demo account and terminal-hosted bridge or existing gateway. Do not send account passwords, investor passwords, bridge secrets or tokens in chat. The bridge must provide exact-account quotes/rules and must never silently fall back to another account or symbol. Deriv public prices are not the selected CFD execution feed.

The pure helper in `engine/cfd-risk.js` is only an MT5/CFD sizing primitive. It consumes a fresh, exact-account/symbol/side/price-bound one-lot `order_calc_profit` loss in the account currency, floors volume to the broker step and skips if broker minimum size exceeds the remaining cash-risk budget. It sends no requests and is not connected to bot entries.

For both modes: migrate to approved durable storage and prove backup/restore/restart recovery without resetting account or risk history; reconcile every ambiguous order before new entries; validate instrument-specific commissions, payout, margin, volume, market-hours and currency rules on demo; and keep real orders disabled until lifecycle evidence, risk/security review, user consent, operating procedures and rollback have all passed.

Hosting remains a Render proposal; no purchases, upgrades, service changes, deployments or real orders are authorized by this selection.
