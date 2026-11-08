# R.H Pilot

A lightweight Node.js market-data and **paper-trading research** workspace with the Springboks strategy engine, accounts, server-side sessions, licences and an admin console.

## Trading-safety status

**This build is paper-only. New real-money orders are disabled in the backend and UI.** The selected future execution direction is **MT5 / CFDs**, but no MT5 terminal bridge, CFD broker account connection, or broker-order lifecycle is implemented. The current Deriv integration is for Options account access and public market data; it is not an MT5 trading connection. The previous LIVE path bought five-minute Deriv CALL/PUT options, whose payoff and settlement differ from price-based TP/SL. No local paper result or mocked broker response establishes actual broker P/L.

`engine/cfd-risk.js` is an isolated sizing primitive—not an order adapter. It requires a fresh, exact-account/symbol/side/price-bound one-lot MT5 `order_calc_profit` loss in the account currency and floors volume to the broker step. It is not connected to the bot's entry path. See [MT5-CFD-IMPLEMENTATION.md](MT5-CFD-IMPLEMENTATION.md) and [LIVE-TRADING-PLAN.md](LIVE-TRADING-PLAN.md) for the selected direction and remaining bridge, storage, demo and hosting decisions.

- No strategy guarantees profit, a 90–97% win rate, zero losses, or preservation/growth of a $2 balance.
- The strategy report contains **synthetic diagnostics**, not verified historical/live returns. High trending-generator win rates must not be used as a live forecast.
- Risk limits constrain **planned stop risk before entry**. Gaps and slippage can exceed it. The paper engine now records full losses instead of artificially capping them.
- Legacy broker contract identifiers and uncertain buys are preserved for reconciliation. They are not converted into synthetic closed trades. Check actual status and P/L in the Deriv statement; this build does not automatically settle or liquidate those records.
- Deploying these changes does not prove that an existing production installation or linked account is healthy. Review [RISK-MANAGEMENT.md](RISK-MANAGEMENT.md), [AUDIT.md](AUDIT.md) and [REPORT-engine.md](REPORT-engine.md).

## What works, and what remains unverified

- Public Deriv WebSocket market-data integration, symbol discovery and reconnection; an explicitly labelled practice feed when no fresh live feed is available.
- Direct client PAT sign-in and authenticated linking for **Deriv Options** through REST, balance reads, account-scoped quote checks, hosted cashier links and one-use OAuth 2.0 with S256 PKCE. This does not connect an MT5 terminal or CFD account. Production Deriv credentials require a separate server encryption key. See [DERIV-CONNECTION.md](DERIV-CONNECTION.md) for setup and limits.
- After one explicit **Start** action, the server automatically evaluates signals and manages paper entries/exits; no per-trade click or open browser is required. With durable storage, an opted-in paper bot can resume after a server restart; live flags never resume. Paper positions, P/L, history, risk sizing, daily stops and profit targets remain server-side.
- Salted scrypt passwords, HttpOnly sessions, user administration, licences, subscriptions, backups and diagnostics.
- Demo transport helpers are tested with mocks; the normal bot does **not** buy contracts on a linked demo or real account. The low-level demo helper independently confirms that the selected broker account is virtual before it can buy.

A live market-data badge means **market data**, not real-money execution. The dashboard paper balance and P/L are not the linked Deriv wallet balance. Broker connectivity, order lifecycle and production deployment must be verified separately from a permitted network.

## Savanna Bronze dashboard

The dashboard follows the supplied warm savanna reference: an acacia/springbok backdrop, embossed bronze springbok emblem, cream/gold type, red-ochre **Start engine** and bronze **Tune engine** controls. Balance, paper P/L, win rate and engine status use four desktop columns and a two-by-two tablet/phone layout. Sign-in, forms, tables and dialogs share the warm palette.

- Static, locally served scenery replaces competing light/blue skins and continuously animated decorations. Reduced-motion preferences are respected.
- The mobile drawer manages keyboard focus, close-button/Escape/scrim dismissal and background interactivity; dialogs/manuals also contain and restore focus. Wide trade tables are named keyboard-scrollable regions.
- Feed status, paper balances and disabled real-money execution remain explicit; the theme does not imply live execution or guaranteed results.
- Local Chromium browser checks covered 320–1440px layouts, all client views, paper start/cancel/stop, editable risk, and automated accessibility checks. These are local smoke checks, not an exhaustive accessibility certification or broker validation; see [AUDIT.md](AUDIT.md).

## Requirements and local run

Node.js **22 or newer**. The only runtime dependency is `ws`.

```bash
npm ci
npm start
# open http://localhost:3000
```

On first run an administrator is created; its credentials are written with owner-only permissions to `data/admin-credentials.txt`. Supply a unique address and strong password in production:

```bash
ADMIN_EMAIL="you@example.com" \
ADMIN_PASSWORD="use-a-long-unique-password" \
PORT=3000 \
npm start
```

Use `npm run dev` for watch mode. Never commit credentials, PATs, recovery codes or runtime databases. The admin account is synced from `ADMIN_EMAIL` / `ADMIN_PASSWORD` on boot. If you change its password through the UI, update the host secret too, otherwise the next boot reinstates the environment password.

## Verification

```bash
npm run verify:local
# equivalently:
npm run check
npm test
npm run benchmark:engine
npm run validate:strategies -- --check
npm audit --omit=dev
```

- Syntax checking covers server, engine, browser code, scripts and tests.
- Tests cover direct PAT/OAuth client sessions, account-ownership/admin step-up checks, one-use session-bound PKCE, encrypted credential/backup recovery, actual WebSocket tick ingestion, causal history warm-up, stale/superseded feeds, hard $1/$2 cash rails, mandatory daily protection, cash-watermark drawdown, loss-streak holds, restart/resync/backup bypass attempts, storage faults, authentication/licences, HTTP workflows, $2 budgets and losing sequences, optional compounding, fractional sizing boundaries, client form logic, editable entry-frozen protection, next-tick entries, adverse costs, full gap losses, terminal mark-to-market, stateful profit locks, real tick accounting, stopped-position management, risk reservations, daily-stop latches, exact account selection and fail-closed real-order gates.
- The benchmark measures **local signal computation only**, across varying indices and three synthetic families. It excludes broker/network latency, full multi-user load and execution quality. It cannot prove “best performance”.
- `--check` regenerates deterministic diagnostic metrics in memory and requires them to match the shipped report; it does not assert that strategies must be profitable. CI runs this check so stale evidence cannot quietly ship.

From a host allowed to contact Deriv, `node scripts/verify-deriv.js` performs a public time/symbol/tick probe without an account token or a buy. Scheduled gold closures are recorded and a supported alternative instrument is checked. A successful handshake is connectivity evidence only, not strategy validation. The existing deployment verifier runs on `main`; it is separate from local tests.

## Springboks paper engine

Five research strategies are available: Breakout Momentum, MACD Momentum, Springbok Fusion, Apex Trend Confluence and Scalper Pro. All are labelled **research only**, including those with positive synthetic results. Apex is a tick-data adaptation of selected ideas from the supplied ApexAI example; it is not the source code copied verbatim and does not detect OHLC wick/reclaim liquidity sweeps.

- Base indicators require 90 observations; Apex's 20/50/200 trend context waits for 205 ticks. Context construction uses bounded windows, and the server caches context per symbol/tick across users.
- See [APEXAI-STRATEGY-REVIEW.md](APEXAI-STRATEGY-REVIEW.md) for the source-code critique, frozen candidate settings and synthetic results. These diagnostics do not establish an edge or live readiness.
- Public live ticks trigger evaluation immediately. A safety loop checks state; it cannot count an unchanged quote again as another tick. Equal prices on **distinct** ticks are retained.
- The practice feed emits ticks every 250 ms. It deliberately contains persistent directional runs to exercise the engine; easy practice profits are not independent evidence of an edge.
- A decision on tick `i` fills at tick `i+1`, with adverse spread and slippage. The default cost assumptions are 0.02 ATR spread plus 0.01 ATR slippage **per side**, not a measured broker fee schedule.
- Backtest and paper server share the same fill and stateful TP/SL, break-even, trailing and time-stop code in `engine/execution.js`.
- Exit rules are captured at entry. Switching strategies does not rewrite open positions. Stopping entries or hitting a target does not abandon remaining paper exposure.
- Live/simulator transitions reset indicator history. Paper exposure is marked at its last same-source observation, with a stale-mark flag, rather than inventing a gain from a source jump.
- Auto follows **one reference chosen on synthetic training families**; it no longer mixes unrelated strategies using incomparable confidence scores. The current report selects Scalper Pro as that paper reference; **none** clears the broader training research floor. This is not a recommendation to trade it.
- Regime exclusions apply to both pinned and auto paths. They are conservative heuristics, not proof that the market belongs to a profitable regime.
- Learning weights remain available as diagnostics, but practice outcomes from one account do not change other accounts' fixed-weight decisions.

### Editable conservative defaults

These are **cautious paper defaults, not proven optimal trading parameters**. New accounts start with risk-based sizing, compounding, break-even protection and trailing enabled. Requested settings remain editable in the engine form and `/api/bot/settings`, subject to the non-disableable backend risk rails below.

| Preset | Planned risk per trade | Daily net-loss budget | Open positions | Break-even / trail start / distance |
|---|---:|---:|---:|---|
| Conservative (`safe`, default) | 0.5% | 3% | 1 | 0.5R / 1R / 0.35R |
| Balanced | 1% | 3% | 2 | 0.5R / 1.3R / 0.4R |
| Aggressive | 1.5% | 3% | 3 | 0.6R / 1.6R / 0.5R |

**1R is the initial planned stop distance**, not a win probability. The conservative trail starts sooner to retain more of an orderly favourable move, but tighter stops can also shorten winners and reduce returns. Break-even/trailing stop prices only tighten; the next actual executable quote determines the result. Settings changes discard pending entries; existing positions retain their entry-time exit snapshot. Saved custom settings are not silently replaced with a preset. Selecting a preset restores its profile; selecting or editing one is not evidence of a profitable strategy.

### Small balances and proportional growth

At the default 0.5% planned risk, before any tighter portfolio/daily constraint:

| Paper balance | Planned risk per trade | 3% daily budget at that day's opening balance |
|---:|---:|---:|
| $2 | $0.01 | $0.06 |
| $10 | $0.05 | $0.30 |
| $100 | $0.50 | $3.00 |
| $1,000 | $1.00 | $30.00 |
| $100,000 | $1.00 | $3,000.00 |

There is no fixed $0.05 per-trade or $0.25 daily floor. **A mandatory $1 planned trade-risk ceiling now limits growth**, with a $2 / 3% shared open-risk ceiling. Requested dollar budgets can scale, but actual new exposure cannot exceed these rails. The cash amounts in the form are anchored to the starting paper balance; the active daily budget scales from **UTC day-start equity**, not intraday balance swings. Today's realised profits/losses and reserved open risk determine the remaining daily capacity.

- Compounding changes **position size, not the risk percentage or win probability**. Given the same R outcome, larger positions change both gains and losses in dollars. Growth itself is not guaranteed.
- Turning compounding off caps the sizing base at the lesser of starting and current equity: gains do not increase the base, but losses still reduce it. Fixed lots remain a ceiling, not a way around risk budgets. There is no automatic loss-recovery bet doubling.
- Fractional paper lots can be as small as `0.00000001`; affordable sizing rounds down, including floating-point boundary cases. If the minimum paper clip is unaffordable, the engine waits instead of rounding up or inventing capital.
- **Paper fractions are not broker lot/stake rules.** A $2 real account may be unsuitable because of minimum stakes, costs and price gaps. No real order is sent by this build; never enlarge a trade merely to meet a broker minimum.

### Planned risk, not guaranteed loss limits

- Maximum planned stop risk: the lesser of **$1 / 1.5% per trade**, and **$2 / 3% across open paper positions**. A remaining drawdown-headroom reservation can tighten these further.
- The requested risk percentage, cash budget and remaining daily budget can make a trade smaller or prevent it entirely. Fixed lots cannot bypass these controls; lot sizes are rounded down.
- The percentage applies once to the selected current/start-capped sizing base—there is no second balance-growth multiplier. Micro lots use their exact notional.
- The daily guard uses the current UTC day's **net realised** P/L and day-start equity, independent of lifetime profits. Zero or oversized numeric inputs cannot disable the mandatory 3% ceiling. Once hit, the daily latch survives restarts, presets and resync until the UTC date changes. A new day clears the latch but does not automatically restart a stopped bot.
- A **10% cash-high-water-mark drawdown rail** latches an account stop, including adverse same-source open marks. It has no automatic new-day/UI reset. **Three consecutive losses pause entries for five minutes**; existing exits stay managed.
- There is **no daily trade-count cap** and the default profit target is zero. `maxTrades` limits concurrent positions, not trades per day; safety holds, entry pacing and market hours remain. This does not promise daily profit or 24/7 trading availability.
- Risk-critical changes use file-sync/atomic-rename saves. Storage failures halt entries and degrade health; corrupt/uncertain state fails startup closed rather than creating fresh balances. Backup restore cannot roll back existing account risk history. Use one writer and persistent `DATA_DIR`; this is not a distributed/broker-authoritative ledger. See [RISK-MANAGEMENT.md](RISK-MANAGEMENT.md) for policy, tests and recovery.
- Restarting does not overwrite realised cash or reset the daily ledger. The starting-balance input seeds a fresh paper account only.
- Stops and profit locks are triggers, not insured prices. Full observed fill losses are booked, even beyond planned budgets or below zero paper equity. Invalid/empty equity cannot invent a fallback bankroll to continue trading.

The preset ID `safe` is retained for compatibility; it means the smallest paper budget, not guaranteed safety or profitability. The report evaluates default exit rules with one position at a time; custom/preset exit variations, wall-clock cooldowns and the full cash-account risk system are not performance-validated by those R-multiple tables.

## Strategy evidence

Regenerate both diagnostic files with:

```bash
npm run validate:strategies
# optional one-strategy investigation; does not overwrite the report:
npm run validate:strategies -- --strategy breakout-momentum
```

The script freezes the shipped parameters and chooses a paper reference on training families **before** evaluating separate diagnostic seeds. It reports trending, random-walk and mean-reverting families, higher-cost scenarios and price gaps. The script does not tune candidates on the diagnostic panel or assume that synthetic validation proves a real edge. These seeds are reused during development and are not an untouched final test. Unfinished exposure is marked once at the final quote; gaps are not clipped to a fixed R outcome.

Reports carry a code fingerprint. Old schema/model reports are rejected instead of being displayed as current evidence. See `engine/strategy-report.json` for all parameters, per-seed metrics, stress cases and limitations; `REPORT-engine.md` is generated from the same metrics.

## Deriv configuration

1. The configured public market-data endpoint is `wss://api.derivws.com/trading/v1/options/ws/public`; no token is used for public ticks.
2. Register your own PAT or OAuth application at `developers.deriv.com` and set its App ID in **Platform settings**. Do not use sample App ID `1089` for private production access.
3. For OAuth, set `PUBLIC_URL` to the canonical HTTPS origin and register its exact callback: `https://r-h-pilot-3.onrender.com/api/auth/deriv/callback` for the declared service. Production OAuth never derives this callback from a forwarded host. The integration uses authorization code + one-use S256 PKCE; Wallet linking is bound to the initiating workspace/session.
4. Configure `DERIV_TOKEN_ENCRYPTION_KEY` in hosting secrets (a random 32-byte key, 64 hex characters or canonical base64/base64url). Keep it stable across deploys and back it up separately. Production PAT/OAuth connection is disabled without a valid key. New Blueprint services generate one; existing services need the secret added securely. Never put this key or a PAT in chat, source or Platform settings.
5. Clients can use **Sign in with a Deriv token** without a separate workspace password, or **Continue with Deriv**. Already signed-in clients can link through **Deriv wallet**. Licence requirements still apply. Administrator access requires password/Google sign-in first; a broker token alone is not platform-admin authority.
6. **Test connection** and **Verify accounts** check different things: public network access, account access and quote permission. Neither arms trading nor establishes profitable execution.
7. Linking prefers demo initially. Explicitly selecting an account must find that **exact ID**; a missing requested account never silently falls back to another one. Every switch disarms live flags. Unresolved broker records block account replacement, unlinking and destructive state changes.

The implemented account connector is **Deriv Options**; the selected future execution product is **MT5/CFDs**, which is not connected yet. [DERIV-CONNECTION.md](DERIV-CONNECTION.md) and [LIVE-TRADING-PLAN.md](LIVE-TRADING-PLAN.md) document the remaining gateway, broker-lifecycle, durable-storage and hosting decisions. The standalone CFD risk helper is not used by bot entries, and no configuration flag can enable real orders.

Before any future real-execution gate: implement an account-isolated MT5 bridge; broker-sourced quotes and contract metadata; durable order intents/reservations; authoritative positions, deals and P/L; ambiguous-submit recovery; restart reconciliation; and failure-tested demo lifecycle. Then use representative historical broker data and frozen-settings forward validation. A profitable synthetic report is not sufficient.

## Hosting and persistence

See [LIVE-TRADING-PLAN.md](LIVE-TRADING-PLAN.md) for the selected MT5/CFD direction and the unresolved terminal-hosting and durable-storage proposal. Any cost estimate is not authorization to upgrade or spend.

Use a persistent Node backend, not GitHub Pages. Bind to `0.0.0.0`, pass the host's `PORT`, serve over HTTPS and permit outbound HTTPS/WebSocket traffic to the broker. Production session/OAuth cookies are Secure; broker-credential submissions require HTTPS. Configure `DERIV_ORIGIN` only when the deployment requires an explicit WebSocket Origin.

**The included `render.yaml` currently specifies a Free native-Node service with ephemeral storage. It does not attach a persistent disk.** Redeploys/restarts can lose accounts, licences, tokens and state. Use an eligible paid persistent volume or a managed database before relying on persistent customer/trading records; do not confuse a health-check success with durable storage.

For Docker hosting with a private persistent volume:

```bash
docker build -t r-h-pilot .
docker run -p 3000:10000 \
  -e ADMIN_EMAIL="you@example.com" \
  -e ADMIN_PASSWORD="use-a-long-unique-password" \
  -e DERIV_APP_ID -e PUBLIC_URL -e DERIV_TOKEN_ENCRYPTION_KEY \
  -v rhpilot-data:/app/data \
  r-h-pilot
```

The container runs unprivileged and checks `/api/health`. Docker uses port `10000`; the native server also selects `10000` under `RENDER=true` without an explicit `PORT`, and otherwise defaults to `3000`. `/api/health` includes live-safety status and whether the strategy report matches this model; `ok: true` means the web process is up, **not** that profitable or live trading is ready. Health exposes the Render commit hash and bounded local tick-processing metrics; the main-branch deployment verifier requires the intended commit and reports public feed/client setup separately from execution readiness.

## Admin, backups and public discovery

Board controls can freeze clients, require licences, revoke keys and restrict access. Google recovery requires a configured client and verified identity. Licence clocks begin on redemption. These application checks are not a comprehensive security certification.

`data/db.json` and backups contain password hashes, sessions and sensitive configuration. Deriv tokens are AES-256-GCM sealed when the environment key is configured (required for production connection); tokens are decrypted only in server memory. A missing/wrong key or tampering fails closed. Legacy plaintext credentials migrate on the next successful keyed save; older backups are not retroactively encrypted. Development without a key is explicitly plaintext and must use test credentials only. Keep the volume and backups private, restrict file access, and use only a private HTTPS backup hub you control. Exposure identifiers must never be trimmed as if they were display logs. A restore is blocked while bots or unresolved broker records are present.

The public sign-in page includes canonical/Open Graph metadata, Schema.org application data, a web manifest, `robots.txt` and `sitemap.xml`. APIs are marked `noindex`. Set `PUBLIC_URL` to the real deployment URL and optionally `GOOGLE_SITE_VERIFICATION` / `BING_SITE_VERIFICATION`. Search indexing and ranking are controlled by search engines, not guaranteed by this application.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
