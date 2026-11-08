# R.H Pilot — Code Wiki

> Structured documentation of this repository: architecture, module responsibilities,
> key classes/functions, dependency relationships and run instructions.
>
> **Status: paper research plus a separate MT5 demo adapter.** New real-money broker orders are
> disabled in the backend and UI. No strategy in this repository guarantees profit,
> a win rate, zero losses, or preservation/growth of any balance. See
> [README.md](README.md), [AUDIT.md](AUDIT.md),
> [RISK-MANAGEMENT.md](RISK-MANAGEMENT.md) and
> [REPORT-engine.md](REPORT-engine.md).

---

## 1. What the project is

R.H Pilot is a **single-process Node.js application** that combines:

- An HTTP + static web server (`server.js`).
- A server-side **paper-trading bot engine** that runs while the browser is closed.
- A **market-data client** for Deriv's public WebSocket feed (plus REST/OAuth for account linking).
- A **strategy research engine** with a deterministic, reproducible synthetic backtest.
- Accounts, sessions, licences, an admin console, backups and diagnostics.
- A warm "Savanna Bronze" single-page dashboard (`public/`).
- An outbound Windows MT5 demo agent, account-bound broker-receipt ledger and optional direct/session PostgreSQL state. See [MT5-FREE-SETUP.md](MT5-FREE-SETUP.md); real orders remain disabled.

It listens on one port, serves the SPA, and exposes a JSON API under `/api/*`.

---

## 2. High-level architecture

```
                          ┌──────────────────────────────────────────┐
   Browser (public/)      │                 server.js                 │
   ┌────────────────┐     │                                          │
   │ index.html/app │◄───►│  HTTP server ── /api/* JSON ── static     │
   │  (SPA, views)  │ SSE │        │                                 │
   └───────┬────────┘     │        ├── auth / sessions / licences     │
           │              │        ├── bot engine (evaluate loop)    │
           │              │        ├── risk rails  ── engine/risk.js │
           │              │        ├── paper fills ── engine/exec_  │
           │              │        ├── strategies  ── engine/strat_  │
           │              │        ├── Deriv market feed (WS)        │
           │              │        ├── Deriv REST / OAuth (account)  │
           │              │        └── storage: PostgreSQL or local atomic JSON│
           │              └──────────────────────────────────────────┘
           │                              ▲
           │                              │ engine/* (pure modules)
           │                              │
   Deriv public WS (market ticks) ────────┘
   Deriv REST + OAuth (PAT / PKCE) ───────┘
```

**Engine loop** (`engineLoop`, `pricePump`, `evaluateSymbol`): a timer samples the
market feed; each subscribed user's bot is advanced only on a genuinely fresh tick.

**Dependency direction** (no cycles): `server.js` → `engine/strategies.js` →
`engine/execution.js`; `server.js` → `engine/risk.js`. The engine modules are pure
(no I/O) except `strategies.js` reading its own source for a fingerprint.

---

## 3. Repository layout

| Path | Purpose |
|---|---|
| [server.js](server.js) | Entire backend: HTTP/API, auth, licences, Deriv, engine loop, risk, storage, SSE, SEO |
| [engine/strategies.js](engine/strategies.js) | Indicators, 4 research strategies, context builder, backtest, synthetic data |
| [engine/execution.js](engine/execution.js) | Paper fill model, entry/exit, break-even/trailing/time-stop |
| [engine/risk.js](engine/risk.js) | Mandatory risk policy: caps, drawdown latch, loss-streak pause |
| [engine/strategy-report.json](engine/strategy-report.json) | Frozen synthetic diagnostic metrics (version-fingerprinted) |
| [public/index.html](public/index.html) | SPA shell, SVG icon sprite, all views |
| [public/app.js](public/app.js) | Client logic: auth, forms, polling, SSE, charts, admin |
| [public/styles.css](public/styles.css) | Savanna Bronze theme |
| [scripts/](scripts) | Verification, benchmark, strategy validation |
| [test/](test) | Node engine/auth/risk/storage/MT5 tests and an actual PostgreSQL fixture |
| [engine/mt5.js](engine/mt5.js) | Account-bound demo bridge, protocol/fencing, risk/settings and receipts |
| [engine/state-store.js](engine/state-store.js) | Optional direct/session PostgreSQL, advisory lock, bounded queue, revision CAS |
| [engine/storage-budget.js](engine/storage-budget.js) | State/data byte caps and recognized backup pruning |
| [mt5-agent/](mt5-agent) | Outbound Windows terminal adapter, SQLite journal, independent rails and offline FakeMT5 tests |
| [Dockerfile](Dockerfile) | Unprivileged container, volume at `/app/data` |
| [render.yaml](render.yaml) | Render blueprint (free, ephemeral) |
| [.github/workflows/](.github/workflows) | CI + Deriv/deployment verification |

---

## 4. Module responsibilities

### 4.1 `server.js` (backend)

Organised top-to-bottom into these concerns:

| Concern | Key functions |
|---|---|
| Config & DB | `DEFAULT_CONFIG`, `defaultDb`, `merge`, `normaliseDb`, `loadDb`, `saveDb`, `markDirty`, `slimDb`, `memoryGuard` |
| Passwords | `hashPassword`, `verifyPassword` (scrypt + timing-safe compare) |
| Bot defaults/presets | `defaultBot`, `PRESETS`, `scaledLimits`, `applyPreset`, `publicRiskPresets` |
| Users & sessions | `makeUser`, `createSession`, `getSessionUser`, `revokeSession`, `parseCookies`, `setSessionCookie` |
| Licences | `genLicenseKey`, `findLicense`, `licenseCheck`, `bindLicense`, `planOf`, `planExpiry` |
| Deriv REST/WS/OAuth | `derivRequest`, `derivRequestAt`, `derivSocket`, `derivFetchAccount`, `derivVerifyAccounts`, `derivOAuthStartUrl`, `derivOAuthExchange`, `derivPlaceTrade`, `derivSellContract` |
| Market data | `initMarket`, `connectDeriv`, `notePrice`, `currentPrice`, `peekPrice`, `tickIdentity`, `sourceOf`, `simulationStatus`, `pushToSubscribers` |
| Engine loop | `engineLoop`, `pricePump`, `evaluateSymbol`, `evaluate` |
| Positions/exits | `closePos`, `flattenBot`, `checkProfitGuard`, `placeLive`, `closeLive` |
| Risk sizing/rails | `openRiskCash`, `riskBudgetFor`, `sizeFor`, `accountRisk`, `enforceAccountRisk`, `rollDay`, `liveCap`, `liveDailyLimit`, `dailyLossBudget`, `noteDayLoss`, `dailyLimitHit`, `resyncBot` |
| Strategy glue | `strategyFor`, `strategyCatalogue`, `loadStrategyReport`, `marketContext`, `chooseSignal`, `signalAllowed` |
| Backups | `snapshot`, `writeBackup`, `listBackups`, `pushToHub` |
| API router | `api(req, res, url, body)` |
| Serving | `createServer`, `serveStatic`, `injectSeo`, `publicOrigin` |
| Lifecycle | `start(options)`, `stop()`, `seedAdmin`, `syncAdminCredentials` |

**Startup sequence** (`start`): load DB (fail-closed on corruption) → seed/sync admin
→ await authoritative persistence (PostgreSQL when configured) → load the version-matched strategy report → init market + connect Deriv →
start timers (`engineLoop`, `pricePump`, maintenance) → listen.

**Engine decision flow** (`evaluate`, [server.js#L1448](server.js#L1448)):
1. Refuse if a live/broker position is present (live path fails closed).
2. `entryBlockReason` / `enforceAccountRisk` → flatten + stop if a rail is latched.
3. Ignore stale or unchanged ticks (`tickIdentity`, `freshMarketQuote`).
4. Advance each open position with `PAPER.advancePosition` (same code as the backtest).
5. Gate new entries: daily stop, storage health, entry pacing (`minGap`), `maxTrades`.
6. A signal on tick *i* becomes a `pendingEntry`; it fills on tick *i+1* at the
   observed quote with adverse spread + slippage.

### 4.2 `engine/strategies.js` (pure engine)

- **Indicators**: `sma`, `emaLast`, `emaSeries`, `rsiLast`, `stdevLast`, `macdLast`,
  `tickAtr`, `efficiencyRatio`, `zScoreLast`.
- **`STRATEGIES`** — four frozen research strategies, each with `exit` geometry,
  `regimes` and a `fn(ctx, params)` detector:
  - `breakout-momentum` — 40-tick range expansion + EMA alignment.
  - `macd-momentum` — MACD/EMA trend filter.
  - `springbok-fusion` — fixed-weight 4-detector ensemble (trend/momentum/breakout/reversal).
  - `scalper-pro` — micro mean-reversion at stretched z-score bands.
- **`buildContext(series, i, opts)`** — bounded-window context (`WARMUP = 89`);
  computes ATR, EMAs, range extremes, RSI, MACD, z-score, regime and fusion `votes`.
- **`signalFor` / `scan` / `paramsFor` / `levelsFor`** — produce a trade signal
  (direction + ATR-based exit distances) or `null`; `scan` ranks by confidence.
- **`backtest` / `backtestMany` / `summarise` / `makeSeries`** — deterministic
  synthetic walk-forward backtest across `trend` / `walk` / `revert` families.
- **`modelFingerprint()`** — SHA-256 over `strategies.js` + `execution.js`; the
  stored report is rejected if the fingerprint no longer matches.

### 4.3 `engine/execution.js` (paper fill model)

- `MODEL_VERSION = 'paper-tick-v2'`; `DEFAULT_EXECUTION` (spread 0.02 ATR,
  slippage 0.01 ATR per side; break-even 0.5R; trail 1R @ 0.35R).
- `executionOptions(overrides)` — validate/normalise exit options.
- `paperPosition(signal, mid, options)` — build an entry at the adverse quote.
- `advancePosition(position, mid)` — the single per-tick exit routine used by **both**
  the paper bot and the backtest; checks stop → target → time-stop, then tightens
  break-even/trailing stops. Gaps fill at the observed quote; losses are never clipped.
- `exitPrice(position, mid)` — apply adverse cost on the way out.

### 4.4 `engine/risk.js` (mandatory rails)

- `POLICY` — `$1 / 1.5%` per trade, `$2 / 3%` open, `3%` daily, `10%` drawdown,
  3-loss / 5-minute pause, no daily trade-count limit.
- `newState` / `validState` / `migrateState` — persist and validate the risk ledger
  (migrates legacy losing streaks rather than resetting them).
- `seedFreshAccount(bot, balance)` — only a **never-traded** paper account accepts a
  new bankroll.
- `inspect(bot, equity, now)` — compute peak balance, drawdown floor, headroom and
  the latched/blocked reason.
- `recordOutcome(bot, pnl, now)` — loss-streak bookkeeping.

### 4.5 `public/` (frontend SPA)

- Views (`data-view`): `overview`, `trading`, `markets`, `wallet`, `engine`,
  `support`, plus admin-only `users` and `settings`.
- `app.js`: `api()` fetch wrapper, `pollBot`/`connectStream` (SSE), `renderStrategySelect`,
  `PRESETS`, `estimatePaperRisk`, `updateRiskUI`, `startEngine`, `stopBot`,
  `checkDerivHealth`, `renderAccountMode`, admin loaders (`loadAdminUsers`,
  `loadLicenses`, `loadSettings`, `renderEngine`), modal/focus-trap helpers.
- Polls `/api/bot/state` periodically and subscribes to `/api/market/stream` for ticks.

### 4.6 `scripts/`

| Script | Role |
|---|---|
| `check-syntax.js` | `node --check` every JS file (server, engine, public, scripts, tests) |
| `benchmark-engine.js` | Local signal-computation micro-benchmark (not execution speed) |
| `validate-strategies.js` | Regenerate / `--check` the frozen synthetic report |
| `verify-deriv.js` | Public Deriv time/symbol/tick probe (no token, no buy) |
| `verify-deployment.js` | Probe a deployed `/api/health` (runs on `main` in CI) |

### 4.7 `test/` (180 tests)

`engine`, `execution`, `risk-rails`, `risk-settings`, `runtime-safety`, `server`,
`dashboard`, `deriv-connection`. The 49 connection regressions cover direct PAT sign-in, one-use/session-bound OAuth, account ownership/admin step-up, encrypted storage/backups and causal live/history ingestion. Coverage also includes the $1/$2 cash rails, daily/drawdown latches, restart
and backup bypass attempts, storage fault injection, adverse-gap full losses, next-tick
entries, source-transition handling, account selection and fail-closed live gates.

---

### 4.8 `engine/deriv-auth.js` and `engine/credential-store.js`

- Registered App ID/token validation, controlled provider errors, broker-ID ownership checks and bounded, one-use server-held PKCE transactions.
- AES-256-GCM sealing of Deriv tokens in databases and every snapshot path; authenticated user binding, random nonces and a separate environment key. Production connection fails closed without a valid key.
- The key is never included in the database or backups. See [DERIV-CONNECTION.md](DERIV-CONNECTION.md) for deployment, migration and verification limits.

---

## 5. Data model (PostgreSQL snapshot or local research JSON)

```
{
  users: [ { id, email, pass (scrypt), role, active, paid, provider,
             deriv: { loginid, token (sealed on disk; string in memory), isVirtual, ... } | null,
             mt5: <account-bound demo ledger/settings/orders> | null, mt5Archive: [],
             bot: <separate paper ledger below> } ],
  sessions: { <token>: { userId, exp, createdAt, seenAt } },
  config: { derivAppId, derivPatAppId, derivOauthClientId, engine{...}, hub{...}, profile{...}, licenses[], logins[],
            mail{...}, mailOutbox[], calendar[], news[], plans{...}, ratings[] },
  createdAt
}
```

**Bot ledger** (`defaultBot`): running flags, `symbol`, preset, sizing
(`autoRisk`, `riskPerTrade`, `maxLossPerTrade`, `dailyLossLimit`), exit settings
(`lockAfterR`, `trailAfterR`, `trailByR`), `risk` (the risk ledger), daily ledger
(`dayPnl`, `dayLoss`, `lossDay`, `dayStartBalance`, `dayLimitLatched`), balances
(`startBalance`, `balance`, `profit`, `peakProfit`), `positions[]`, `trades[]`.

With `DATABASE_URL`, a dedicated PostgreSQL connection owns the namespace advisory lock and writes a bounded JSONB snapshot with revision compare-and-swap. At most one active and one coalesced snapshot are held; auth/financial mutations await a durable barrier. Remote TLS is verified; transaction poolers are incompatible. Otherwise local writes use temp file → `fsync` → rename → parent-dir fsync. A failed write halts entries and degrades health; no silent reset/fallback. See [MT5-FREE-SETUP.md](MT5-FREE-SETUP.md) for the explicit initial migration and 8/24/48 MiB limits.

---

## 6. HTTP API reference (subset)

**Public / auth**
`GET /api/health` · `GET /api/config/public` · `GET /api/public/profile` ·
`GET|POST /api/public/ratings` · `GET /api/calendar` · `GET /api/market/desk` ·
`POST /api/auth/login|register|logout|google` · `GET /api/auth/me` ·
`POST /api/auth/deriv/pat` · `GET /api/auth/deriv/start` · `GET /api/auth/deriv/callback` ·
`POST /api/auth/recover/{start,verify,google,reset}` · `GET|POST /api/license/*`

**Bot**
`GET /api/bot/state` · `POST /api/bot/start|settings|target|stop|closeall|refresh` ·
`POST /api/bot/live` (blocked while live safety is off) · `GET|POST /api/bot/resync`

**Deriv**
`POST /api/deriv/link|unlink|refresh|test|verify-accounts|account` ·
`GET /api/deriv/cashier` · `GET /api/deriv/ready`

**Market**
`GET /api/market/symbols|best-pair` · `GET /api/market/stream` (SSE)

**Admin** (`/api/admin/*`)
`users`, `config`, `licenses`, `license-required`, `license-lockdown`, `logins`,
`calendar`, `news`, `mail`, `broadcast`, `backup[/download|/restore]`, `backups`,
`hub[/push]`, `profile`, `plans`, `maintenance`, `manual`, `engine[/default|/retune|/resync]`.

---

## 7. Deriv integration

- **Market data**: public WebSocket `wss://api.derivws.com/trading/v1/options/ws/public`
  (env `DERIV_WS_URL`), 16 subscribed instruments, automatic simulator fallback when
  no fresh live feed is available.
- **Client sign-in/linking**: direct PAT sign-in (REST) or OAuth 2.0 + one-use S256 PKCE. Wallet OAuth linking requires the initiating workspace and session before and after provider verification. Broker IDs, not an email, establish ownership; broker tokens alone cannot enter admin workspaces.
- **Secrets/configuration**: callback `/api/auth/deriv/callback`; configure separate `DERIV_PAT_APP_ID` / `DERIV_OAUTH_CLIENT_ID` (legacy `DERIV_APP_ID` fallback), canonical HTTPS `PUBLIC_URL` and a separate `DERIV_TOKEN_ENCRYPTION_KEY`. `DERIV_ORIGIN` is only an optional WebSocket Origin override. Production broker credentials require encryption; local development without a key is explicitly plaintext.
- **Freshness/warm-up**: the actual producer uses `source: live`. Provider time and receipt time are checked; broker history can warm indicators but never create a live quote, rewind an observation or execute a position. `/api/health.marketTickProcessing` is bounded local latency telemetry, not broker fill speed.
- **Test vs verify**: `Test connection` probes public network access; `Verify accounts`
  checks account access and quote permission. Neither arms trading.
- **Execution**: `derivPlaceTrade` / `derivSellContract` exist but new real orders are
  gated off by `LIVE_SAFETY`.

---

## 8. Running the project

**Requirements:** Node.js **22+**. Runtime dependencies: `ws` and pinned `pg`; browser tooling is dev-only. The Windows MT5 SDK is installed only on the client computer.

```bash
npm ci
node --env-file=.env.local server.js  # private replacement settings; localhost:3000
npm run dev               # watch mode; requires private environment settings
```

**Admin account** (env-driven, not hard-coded in DB):

```bash
ADMIN_EMAIL="you@example.com" \
ADMIN_PASSWORD="use-a-long-unique-password" \
PORT=3000 \
npm start
```

On first boot the admin is created from `ADMIN_EMAIL` / `ADMIN_PASSWORD` and re-synced
on every boot (`syncAdminCredentials`). The admin email defaults to the owner address
in `server.js`; the password must come from the `ADMIN_PASSWORD` env var in production.

**Environment variables**

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `10000` on Render else `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `DATA_DIR` | `./data` | Application-owned local data; ephemeral on Render Free |
| `DATABASE_URL` / `STATE_NAMESPACE` | — / `r-h-pilot` | Operator-owned direct/session PostgreSQL; no automatic provisioning |
| `DERIV_PAT_APP_ID` / `DERIV_OAUTH_CLIENT_ID` | — | Separate optional Options PAT/OAuth registrations |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | owner / — | Admin credentials |
| `DERIV_APP_ID` | `''` | Deriv app id (not sample `1089`) |
| `DERIV_WS_URL` / `DERIV_API_URL` | Deriv public hosts | Endpoint override |
| `PUBLIC_URL` | — | Canonical/OAuth URL |
| `GOOGLE_CLIENT_ID` | `''` | Google sign-in |
| `MEM_LIMIT_MB` | `512` | Memory watchdog limit |

**Docker**

```bash
docker build -t r-h-pilot .
docker run -p 3000:10000 -e ADMIN_EMAIL=... -e ADMIN_PASSWORD=... \
  -v rhpilot-data:/app/data r-h-pilot
```

**Verification**

```bash
npm run verify:local      # syntax + Node + offline Python + benchmark + frozen report
node scripts/verify-deriv.js   # public Deriv probe (from a permitted host)
```

---

## 9. Design invariants (enforced in code)

1. Signals fill on the **next** tick, never on the same quote.
2. Backtest and paper bot share one fill/exit implementation.
3. Exit rules are **frozen at entry**; switching strategies cannot move a live exit.
4. Real-money orders **fail closed**; a live position forces reconciliation and stops the bot.
5. Planned risk is no greater than the lesser of `$1 / 1.5%` per trade and `$2 / 3%` across open positions.
6. The `3%` daily stop and `10%` drawdown latch **cannot be disabled** by presets,
   custom limits, resync or restart.
7. Storage faults and corrupt state halt trading rather than inventing balances.
8. The strategy report loads only if its code fingerprint matches the current model.

---

## 10. Honest limitations

- This is a **paper / research** system. It does **not** prove a live edge.
- The synthetic diagnostic's high trend-generator win rates (e.g. Breakout 96.8%) fall
  to ~45% on random-walk and mean-reversion families — win rate alone is not profit.
- Deriv five-minute CALL/PUT payouts, early-sale availability, settlement and network
  delays are **not** modelled.
- The included Render Free config provisions no paid resources and local files are ephemeral. Use an operator-supplied suitable direct/session PostgreSQL arrangement for durable customer state; physical database/backup size and uptime remain operator/provider concerns.
- No code change here enables guaranteed profit, a target win rate or zero losses —
  those are not achievable guarantees for any real trading system.

## 11. MT5-specific protocol and tests

The paper engine and synthetic payoff model are unchanged. `engine/mt5.js` plans from fresh terminal symbol metadata; `mt5-agent/agent.py` independently confirms demo/account/lot/margin/SLTP/risk with the native SDK. It sends to a local terminal, not to the Options API or browser localhost.

Workspace routes: `/api/mt5/{status,pair,settings,start,pause,rotate-token,unlink}`; agent routes: `/api/mt5/agent/{poll,download}`. Agent poll uses a hashed scoped pairing credential, instance identity, process lease, monotonic sequence and idempotent result acknowledgments. Immutable original commands support reconciliation-only journal proof of an unsent command; this is not an ambiguous-buy retry. Real orders stay disabled.

Durable intents and full original reservations survive partial fills, uncertain sends, account archiving and restart. Finalized display receipts can be retired while aggregate risk remains. The agent independently manages confirmed demo stops/time/emergency closes outside its HTTP worker, using the current position ticket; unknown/failed closes remain reserved for manual review. Both systems default/disarm to monitoring after relevant restarts.

`npm run test:agent` needs only Python's standard library. `test/postgres.integration.test.js` needs a disposable `TEST_DATABASE_URL`; both CI workflows supply one. `npm run test:ui` uses dev-only Playwright and a local `RHP_CHROMIUM_PATH`; it tests desktop/mobile Wallet and never uses a real broker. [MT5-VERIFICATION.md](MT5-VERIFICATION.md) records evidence and native-demo/production gaps.
