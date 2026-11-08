# MT5 / CFDs on Render Free — setup, acceptance and recovery

## Release boundary

Selected product: **MT5 / CFDs**. Selected hosting: **Render Free only**. Keep the canonical repository `ricardohaindaka2006-ai/R.H-Pilot` and service `r-h-pilot-3` (`https://r-h-pilot-3.onrender.com`). This change provisions no database, disk, paid bridge, VPS or additional public bot, and deletes no existing service.

Implemented: a separate MT5 demo adapter, outbound Windows agent, broker-receipt ledger, independent risk settings, bounded application storage and an optional PostgreSQL state adapter. **Real-money execution is disabled. Native Windows/broker demo acceptance and production configuration are still required.** Offline fixtures do not establish profitable trading, live account access, continuous availability or broker fill latency.

The paper dashboard's balances, charts and win rates remain **PAPER**. Wallet's MT5 reports and receipts are separate. Deriv PAT/OAuth verifies **Options wallet access**, not an MT5 terminal password. MT5-only clients can use workspace email/Google sign-in, then pair their terminal.

## 1. Free architecture and limits

```text
Browser ──HTTPS──► one Render Free Node dashboard/API
                         │
                         ├── operator-owned PostgreSQL: private durable state
                         │
Windows MT5 agent ──outbound HTTPS reports/receipts──► API
       │                  ◄── persisted demo intent / reconciliation query
       └── local MetaTrader5 SDK ──► already logged-in MT5 terminal
```

No incoming Windows port or browser-to-localhost connection is used. The terminal password stays in the user's terminal; the agent does not accept or upload it. The local computer, terminal and agent must remain running for local monitoring and dynamic exits. Broker-confirmed SL/TP remain broker orders; they are **not insured execution prices**.

Render Free can spin down, cold-start, restart and lose local files. An active terminal sends functional reports, not artificial keep-alive pings; that does not create an uptime guarantee. Render Free PostgreSQL expires after 30 days and is not permanent customer storage. See the official Free limits [1](https://render.com/docs/free).

If you cannot supply an appropriate durable database within your own free arrangement, keep the service in research/monitoring use. Do not sell it as durable, always-on client execution. Nothing automatically upgrades a plan.

## 2. Private server configuration

Use the hosting provider's **secret environment interface**, never chat, source, screenshots or URL parameters.

| Variable | Required action |
|---|---|
| `ADMIN_EMAIL` | Keep `ricardohaindaka2006@gmail.com`. |
| `ADMIN_PASSWORD` | Set a new, unique, strong replacement privately. A password previously posted in chat must not be reused. No password ships in source or `admin-credentials.txt`. |
| `DATABASE_URL` | Operator-supplied **direct/session** PostgreSQL URL. A dedicated connection and advisory lock must survive for the process lifetime. Transaction-pooled URLs are incompatible. Remote connections enforce certificate-verified TLS. |
| `STATE_NAMESPACE` | Stable application identifier; default `r-h-pilot`. Changing it selects a different state row, not a migration. |
| `DERIV_TOKEN_ENCRYPTION_KEY` | Stable random 32-byte AES key, encoded as 64 hex characters or canonical base64/base64url. Keep a private independent recovery copy. Changing/losing it makes saved Options tokens unreadable. |
| `PUBLIC_URL` | `https://r-h-pilot-3.onrender.com`, or the deliberately selected canonical HTTPS origin. |
| `DERIV_PAT_APP_ID` | Optional for MT5-only use. Registered **PAT** application's public App ID; not a token. |
| `DERIV_OAUTH_CLIENT_ID` | Optional for MT5-only use. Registered **OAuth** client ID; register the exact callback `/api/auth/deriv/callback`. |
| `DERIV_APP_ID` | Compatibility fallback only. Prefer separate PAT/OAuth registrations above. |
| `GOOGLE_CLIENT_ID` | Only if using verified Google workspace sign-in/recovery. |

The blueprint remains `plan: free`, uses `npm ci --omit=dev` and a 320 MiB Node heap limit, and attaches no disk or database. `DATA_DIR` on this Free service is ephemeral. The 512 MB service allowance is **memory**, not a disk quota. `/api/health` reports RSS separately from heap, storage readiness, execution product and `realOrdersEnabled: false`.

### Initialize once; never silently reset an empty database

1. Use a private, non-expiring database arrangement you control; check its quotas, backups and connection behavior. No provider or free entitlement is assumed or provisioned here.
2. **Existing installation:** before redeploying, pause new entries and download a private current backup. Preserve the existing token-encryption key and all identities/licences/risk/uncertain orders. Never replace them with fresh paper accounts.
3. On a trusted local Node 22 machine, install this checkout. For an existing installation, put the backup's `data` object (the database payload, not the wrapper) in a private `DATA_DIR/db.json`. Do not edit financial/identity fields. Keep a separate untouched backup.
4. Configure the same private admin/encryption settings, the target `DATABASE_URL` and stable namespace. For the **confirmed first migration only**, set `INITIALIZE_EMPTY_DATABASE=1` and start the server. It imports validated local state, or explicitly initializes a genuinely new installation. Check `storage.mode === "postgres"` and `storage.durable === true` in health.
5. Stop the local migration process gracefully so it releases the database writer lock. Remove `INITIALIZE_EMPTY_DATABASE`. Set the same URL/key/namespace privately on the canonical Render service, then deploy the reviewed revision.
6. Verify the intended `/api/health.build.commit`, owner sign-in, identities/licences, paired accounts and risk history before resuming. Remove the private migration directory from the temporary machine when your recovery policy permits; never commit it.

An empty/missing state row without the one-time flag, corrupt data, missing encryption key, broken connection or revision conflict fails closed. There is no automatic local fallback or bankroll reset. Existing local JSON is not magically retained by a Render redeploy; **export before changing the service**.

Only one writer can run for a namespace. A second writer is refused, not elected concurrently. Pause entries for maintenance and arrange a controlled old-process shutdown before starting its replacement. If a blue/green deployment reports `state-writer-already-active`, stop/drain the old process; **do not remove the lock or create a fresh namespace** to bypass it. Native journal and broker positions must remain intact.

## 3. Windows terminal preparation

Use your own supported **64-bit Windows computer**, Python 3.11 x64 and a locally installed MT5 terminal. The optional SDK has Windows wheels; it is never installed on Render/Linux. MetaQuotes documents the local-terminal integration [2](https://www.mql5.com/en/docs/python_metatrader5).

1. Start a **dedicated demo terminal** and sign in inside MT5. Verify the exact account number and complete server string. Do not switch accounts while the agent runs. No MT5 password belongs in the website.
2. Copy the instrument's exact **Market Watch name**, including spaces/suffixes. Paper aliases such as `VOL75` are not assumed to be MT5 symbol names.
3. For demo order acceptance, use a **USD, hedging, demo account**. Other account types can be monitored; real accounts cannot be armed. Enable Algo Trading and permit external Python trading only in this dedicated demo terminal. Broker symbol specifications, margin and costs must fit the risk budget.
4. Download `agent.py` from Wallet (authenticated), or use `mt5-agent/agent.py` from the reviewed checkout. Install the pinned optional SDK on Windows:

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --only-binary=:all: MetaTrader5==5.0.6231
```

Set these **local** variables using your actual terminal values. The sample account below is fictional:

```powershell
$env:RHP_URL = "https://r-h-pilot-3.onrender.com"
$env:MT5_LOGIN = "1234567"            # replace with the exact terminal login
$env:MT5_SERVER = "Deriv-Demo"       # replace with the complete exact server
$env:MT5_SYMBOL = "XAUUSD"           # replace with the actual Market Watch name
$env:RHP_AGENT_DATA = "$env:LOCALAPPDATA\RHPilot\MT5-1234567"
# Optional: set MT5_TERMINAL_PATH to the actual terminal64.exe path.
.\.venv\Scripts\python.exe agent.py --check
```

`--check` performs a local read-only diagnostic and no HTTP exchange. It is not an order/settlement acceptance test. Keep one private data directory per origin/account/symbol and one process per journal.

## 4. Pair, monitor, then explicitly opt into demo

1. Sign in to the correct R.H Pilot workspace. Existing licence/access restrictions still apply; a token alone never grants platform-admin authority.
2. In **Wallet → Connect your MT5 terminal**, enter the exact login, server and instrument, then pair. The returned bridge token is masked and shown once, cleared after two minutes/logout, and never put in browser storage. The server stores its hash, not its raw value.
3. Run the local monitor:

```powershell
.\.venv\Scripts\python.exe agent.py
```

Paste the bridge token **only into the private local prompt**. It is not an MT5 password or Options PAT. Do not put it on a command line, in a URL, chat or source. Clear the clipboard afterward. An optional `RHP_BRIDGE_TOKEN` environment variable exists for a privately managed launcher, not a public config file.

4. Check Wallet's account/server/type, broker balance, quote freshness and pending/open positions against MT5. Wrong account, foreign exposure, stale quote, unknown tick values, unsupported fills or missing permissions hold entries.
5. Review the independent **MT5 strategy and risk settings**. The engine page still configures the separate paper bot. Defaults: 0.5% planned trade risk, compounding on, break-even at 0.5R, trail at 1R by 0.35R, one position at a time. Tighter cash/day/profit settings are optional; **zero profit target means no profit ceiling**. There is no daily trade-count limit.
6. After production storage and the acceptance procedure are ready, stop the monitor and restart the **same journal** with:

```powershell
.\.venv\Scripts\python.exe agent.py --enable-demo
```

Then explicitly click **Start MT5 demo** in Wallet. Both opt-ins are necessary. Startup always defaults to monitoring. A new process may wait for the prior 20-second lease; it must keep the same pinned journal instance and monotonic sequence.

The server needs more than 90 distinct fresh terminal observations and a qualifying frozen-strategy signal; a quiet/closed market is not a reason to fabricate a tick or force an order. Reports are paced around one second; local protection checks run around every 250 ms outside the HTTP worker. These are not microsecond fill claims.

### Risk meaning

- Never more than **$1 and 1.5% planned risk per trade**; the default 0.5%, remaining daily capacity, cash cap, drawdown headroom and broker costs can tighten that budget. Size rounds **down**, never up to satisfy a minimum lot.
- Mandatory 3% UTC-day net-loss budget, 10% cash-high-water drawdown latch and a five-minute pause after three losses are independently checked on server and agent. Account history survives rotation, unlink/re-pair and restart. A drawdown latch has no automatic new-day reset.
- A $0.10 cost reserve is an explicit **demo estimate**, not a measured fee schedule or loss insurance. Tiny accounts will often be skipped because minimum volume plus costs cannot fit. A $2 account is not promised to trade or grow.
- SL/TP are sent in the initial order. Dynamic stops never deliberately loosen. A confirmed own demo position with missing protection or actual stop risk above its reservation triggers a one-shot emergency close attempt. A close rejection/uncertain response needs manual review, not repeated blind close submissions.
- Market execution can slip beyond the sizing reference; gaps, fees and broker liquidation can exceed planned risk. All confirmed realized costs/losses are booked in full. No guaranteed principal safety, win rate or profit is established.

## 5. Order recovery and safe stopping

Before sending a command, Node commits its account-bound intent/reservation. Before `order_send`, the agent commits a SQLite FULL-synchronous intent. Acknowledged submissions are reconciled using actual order/position identifiers, remaining volumes and complete deal history, including profit, commission, swap and fee. The current close ticket is not assumed to be the opening order ticket. See MetaQuotes' request and history contracts [3](https://www.mql5.com/en/docs/python_metatrader5/mt5ordersend_py), [4](https://www.mql5.com/en/docs/python_metatrader5/mt5historydealsget_py).

- **Lost HTTP command:** the server asks for journal evidence using a reconciliation-only envelope. If this same pinned journal never claimed the intent, it durably rejects that unsent intent. If already submitted/uncertain, it stays reserved and reconciles. This path never calls `order_send`.
- **Lost broker acknowledgment / partial fill:** inspect positions/history; never submit a second buy merely because history is empty or a response timed out.
- **Pause:** stops new entries. It does not claim to close existing positions. Keep the terminal/agent running and verify broker exposure.
- **Server restart:** MT5 entries are disarmed. Reconcile first; explicitly resume only after health/account/risk checks.
- **Agent restart:** reuse the original journal. Never delete it, change the data directory or re-pair to erase uncertainty/losses. A journal/origin/account mismatch is a stop, not an automatic reset.
- **Token rotation:** pauses new entries and preserves financial state/instance/orders. Start the same agent/journal with the replacement prompt secret. Old token stops authenticating.
- **Unlink/switch/delete/restore:** blocked when exposure or unresolved orders exist. Retired MT5 account risk is archived and cannot be erased through account deletion. Review a balance discrepancy/deposit/withdrawal with a current broker statement; there is deliberately no reset-risk shortcut.
- **Long missing history:** unknown-send searches use a bounded initial time window; a very delayed/absent/mismatched broker record remains a manual-review hold, not proof of rejection. Native history/currency/netting/SDK behavior must pass acceptance on the intended account.

If the local computer stops, dynamic trailing/time exits stop too; only already accepted broker orders continue. If a stop/close is rejected, check MT5 immediately. Do not describe an unresolved position as closed.

## 6. Storage budgets and privacy

| Scope | Bound / behavior |
|---|---|
| Authoritative serialized application state | 8 MiB; saturation halts new mutations/entries instead of truncating financial state. |
| Generated local backups | At most 3, 24 MiB total, 7 days; only recognized generated files are pruned. |
| Application-owned `DATA_DIR` files | 48 MiB budget, reserving an atomic-write copy and 16 MiB filesystem free space. This is not all Render disk usage. |
| Workspaces/sessions | 100 workspaces; 5 sessions per user / 500 total; expired sessions and bounded rate-limit/history records are retired. |
| MT5 display receipts / account history | Last 100 retired receipts plus every unresolved record; up to 20 archived accounts, without silently dropping risk. |
| Native SQLite journal | 32 MiB database page budget plus journal/lock overhead. Old acknowledged final receipts are pruned to 1,000 retained eligible rows; all unresolved/unacknowledged records and aggregate risk stay. Hard capacity fails closed rather than creating a lifetime trade quota by deleting risk. |

PostgreSQL has a bounded **logical payload**, not a 48 MiB physical database guarantee: indexes, TOAST, MVCC, WAL and provider backups have their own overhead. Monitor your provider's storage, vacuum, retention and free quotas. Quiet terminal heartbeats/quotes do not create a whole-state durable write each second; financial, authority and exposure transitions do.

Only saved Deriv broker tokens are AES-256-GCM sealed with user-bound authenticated data. **The whole database/backup is not encrypted by that feature**: sessions, password hashes and admin configuration still require private storage, TLS, restricted database access and private backups. Free local backups are ephemeral and are not a disaster-recovery service. Keep necessary private exports and the encryption key separately; test recovery without rolling back account risk.

## 7. Acceptance checklist — actual terminal evidence still required

Offline verification is documented in [MT5-VERIFICATION.md](MT5-VERIFICATION.md). Before relying even on unattended demo behavior, record the actual terminal build, SDK version, broker/server, account type/currency, symbol specification, exact fills and statement reconciliation:

- [ ] Intended deployment SHA and healthy durable PostgreSQL; restart retains users, licences, sessions, sealed tokens, risk and reservations.
- [ ] Correct dedicated demo terminal/account/symbol; monitor mode submits no orders; wrong account/server and a real account cannot arm.
- [ ] Both demo opt-ins; minimum lot, tick value, price/volume step, spread, margin, stops/freeze distance and supported FOK/IOC behavior confirmed.
- [ ] Buy and sell, SL/TP, break-even/trail/time exit, exact current-ticket close, partial fill/close and all deal costs match the broker statement.
- [ ] Rejection, lost broker/HTTP response, disconnected terminal, unavailable history and restart with an open/uncertain intent never duplicate an order or clear its reservation early.
- [ ] Server/agent/network stopped independently; broker protection checked; rejected/ambiguous close escalates to a human.
- [ ] Daily/streak/drawdown and small-account skips confirmed; rotate/unlink/re-pair/restore cannot reset losses.
- [ ] Paper and broker P/L remain separate; actual strategy performance is forward-validated with representative costs and frozen settings.

**No real-money activation is included.** Native demo acceptance, a profitable historical/forward evidence base, operational/security review and separate explicit authorization would be needed for any future real-execution release. No 90–95% live wins, zero losses, 24/7 Free uptime or microsecond broker fills are promised.
