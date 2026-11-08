# MT5 / CFD implementation status

**Selected product direction: MT5 / CFDs. Execution status: not connected; real orders remain disabled.** This is a build checklist, not trading approval or a promise of live performance.

## What is in this repository now

- The running product remains the paper-trading application. Its market-data connection and wallet flow are for Deriv Options; they do not connect to an MT5 terminal, and Deriv public quotes must not be used as the selected CFD broker's execution quote.
- `engine/cfd-risk.js` is a pure, order-free risk primitive. It validates a fresh one-lot `order_calc_profit` loss against the exact account, symbol, direction, entry, stop, quote timestamp and account currency. It floors volume to the broker's step and refuses a trade if the minimum volume breaches the supplied budget.
- The helper does not fetch account state, verify broker stop rules or margin, persist risk, submit an order, track a position, close a position, or reconcile after restart. It is not wired into the bot's entry path. No configuration switch enables live execution.

## Required terminal/gateway boundary

The Node web application cannot treat an MT5 login as an ordinary Deriv PAT. A concrete route must be selected and operated: either a dedicated MT5 terminal/bridge for each isolated workspace, or an existing broker gateway whose account isolation and execution semantics are verified. A single shared terminal/account must not serve unrelated clients. Keep broker passwords and bridge secrets out of the browser, database exports, logs, source control and chat; prefer keeping terminal credentials at the terminal host.

The gateway must provide authenticated, server-to-server, account-bound snapshots and must fail closed if its configured account or symbol differs from the requested one. Do not accept a client-supplied URL as a gateway address. Production traffic needs authenticated TLS, request timeouts, response size limits, bounded retries for read-only requests, and no redirects that could leak credentials.

Before any order work, its normalized snapshot must expose at least:

- exact broker account ID/server, account currency, demo/real status, trading permission, balance, equity, free margin and margin;
- the exact broker symbol and current bid/ask with a UTC epoch-millisecond quote time from that terminal;
- trade mode, price point/tick size, stop/freeze levels, and volume minimum, maximum and step;
- a terminal-calculated `order_calc_profit` loss for one lot in the selected account currency, tied to that exact account, symbol, side, entry, stop and quote timestamp.

The intended sizing boundary is `sizeForRisk({ budgetCash, lossPerLotCash, volumeMin, volumeMax, volumeStep, accountCurrency, lossCurrency, requestedVolume })`. `budgetCash` must come from the account's persisted risk ledger after open-position, daily-loss and drawdown reservations. The bridge calculation must be refreshed if the quote changes. A zero result means skip; never increase volume to satisfy the broker minimum. Broker stops and planned loss cannot protect against gaps, rejected stop placement, disconnection or slippage.

## Order-lifecycle requirements (not implemented)

1. Receive the live quote and symbol/account rules from the same MT5 terminal that will execute the trade. Reject stale, future-dated or mismatched data.
2. Verify account-specific risk budget, exact symbol, volume step, stop/freeze constraints, margin, sessions and trading mode. Call the broker's order-check function before submission.
3. Persist an account-bound intent and full risk reservation **before** calling the broker. Give each intent a stable idempotency/correlation ID.
4. Submit once. A timeout or lost acknowledgment is an **unknown order**, not a rejection: query positions/deals and reconcile it before any retry or new entry.
5. Manage exits against broker-confirmed positions and fills, not local paper P/L. Record partial closes, fees, swaps, stop changes and realized deal P/L from the broker.
6. On startup, disconnection or storage failure, reconcile every intent/position/deal against the exact account before allowing entries. Storage rollback, account change or missing terminal state must halt new entries.
7. Exercise rejected orders, requotes, disconnects, uncertain acknowledgments, partial fills/closes, stop modification failure, process restart and backup restore on a demo account. Keep the real-order gate disabled until the complete evidence and an independent review pass.

See [LIVE-TRADING-PLAN.md](LIVE-TRADING-PLAN.md) for the next route/hosting decision and [RISK-MANAGEMENT.md](RISK-MANAGEMENT.md) for current paper-only cash guardrails.
