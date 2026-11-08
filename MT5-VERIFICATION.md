# MT5 / Free build — verification record

Date: **8 November 2026**. Scope: this checkout's code and disposable local fixtures. **Not a production deployment or native-broker certification.** No real broker orders or private user credentials were used.

## Reproducible commands

```bash
npm ci
# Optional disposable test PostgreSQL; NEVER use your customer database here:
TEST_DATABASE_URL=postgresql://pilot_test@127.0.0.1:15432/postgres npm run verify:local
npm audit --omit=dev
# With a locally installed Chrome/Chromium:
RHP_CHROMIUM_PATH=/path/to/chrome npm run test:ui
```

`npm test` without `TEST_DATABASE_URL` deliberately skips the actual PostgreSQL fixture, not the adapter unit tests. Both CI workflows provide a disposable PostgreSQL 17 service, Python 3.11 and the runner's Chrome; the Windows-only SDK is not installed in CI or on Render.

## Local results

| Check | Result / scope |
|---|---|
| JavaScript syntax | 28 source/test/tool files checked. |
| Integrated Node tests with actual PostgreSQL configured | 227 passed, zero failed/skipped in the recorded full run. Covers existing paper/risk/auth tests plus storage, state adapter and MT5 routes/protocol. |
| Python agent unit tests | 28 passed with FakeMT5; no native SDK or broker. Includes journal retention, actual-ticket close, market execution's omitted request price, missing-protection emergency close and no real-account modification. |
| Actual PostgreSQL | Disposable PostgreSQL 18.6 binary locally: session/token/pairing persistence, encrypted token payload, no ephemeral credential cache, exclusive writer, restart recovery and revision-conflict fail-closed login. This is database durability testing, not a provider availability/capacity test. |
| Node ↔ Python HTTP protocol | Actual loopback HTTP between server and agent code; one fake-terminal buy, duplicate-delivery protection, complete broker-deal costs and MT5-only ledger settlement. No real orders. |
| Browser | Chromium 153.0.8010.0; 320/375/768/1440 widths. PAT failure/clearing, workspace login, pairing/token mask/copy/clear, independent settings, demo consent/start/pause, exposure guard/receipt, separate PAT/OAuth controls, rotation, timed clearing and logout. No page overflow or uncaught browser errors. External provider calls are fixtures. |
| Frozen strategies | `validate:strategies -- --check` reproduces the shipped diagnostic exactly; no strategy retuning. `liveEligible` remains false. |
| Local engine benchmark | 12,000 ticks × four strategies: mean 0.0054 ms, p95 0.0113 ms. Signal calculation only; not HTTP/native/broker latency or a performance SLA. |
| Render/CI manifests | YAML parsed; one `plan: free` service, no disk/database provisioning; CI includes disposable PostgreSQL, offline agent and browser checks. |
| Runtime dependency audit | `npm audit --omit=dev`: zero reported vulnerabilities in the recorded audit. This is not a comprehensive security audit. |

Ignored local run evidence is under `test-results/mt5-free/` (full verifier, focused API tests, agent tests, actual PostgreSQL and browser logs/screenshot). Generated binaries, database clusters and browser tooling are outside Git. This document intentionally records scope and commands instead of committing a database, secret, screenshot bundle or large test artifact.

## Safety properties exercised

- Exact login/server/symbol ownership, account archive isolation, real/zero-balance monitoring and explicit demo consent.
- Production durable-storage/HTTPS/JSON/same-origin checks; scoped one-time bridge secret is hashed and not returned by status APIs.
- Intent committed before delivery; actual native journal committed before a non-idempotent send. Duplicate IDs, stale/replayed reports, two agent sessions and uncertain results do not cause a second buy.
- A reconciliation-only query can prove that the pinned journal never submitted an intent; an ambiguous native send cannot be converted to a rejection by empty history or a late receipt.
- Full realized profit, commission, swap and fee; partial closes do not fake full settlement; stale/conflicting receipts cannot book profit twice.
- Tight lot/cost/risk budgets skip orders instead of rounding up; compounding cannot bypass $1; tighter optional daily/profit stops do not introduce a default daily trade-count/profit ceiling.
- Risk and unresolved exposure survive restart, rotation, unlink/re-pair and bounded display retention; backup and disk limits never delete live financial authority to make room.
- Failed durable commits grant no new auth session/command and degrade health; no database reset or silent fallback.
- Confirmed missing protection/over-budget demo exposure gets at most one close attempt, and a changed/real terminal cannot be modified by that path.

## Not established / still required

- An actual registered production PAT/OAuth app, private replacement secrets, selected external database, Render deployment SHA/configuration and customer credential acceptance.
- Native Windows MetaTrader5 package/terminal execution against the intended Deriv demo account and its exact symbol/filling/margin/cost rules.
- Broker-side SL/TP reliability, partial fills/fee types, delayed history, native request/close behavior, real forward returns or unattended fault acceptance.
- Physical PostgreSQL/WAL/provider-backup size, customer-scale load, Free-service uptime or a disaster-recovery SLA.
- A profitable live edge, 90–95% live wins, no losses, capital safety, continuous 24/7 Free execution, or microsecond order fills.
- A Docker image build in this environment (Docker was unavailable). The file copies the downloadable agent and omits dev tooling from runtime; native Render and source tests are the verified paths here.

The implementation is **demo-first with real orders disabled**. Complete the operator checklist in [MT5-FREE-SETUP.md](MT5-FREE-SETUP.md) before relying on native demo operation; do not treat green tests as permission for real-money activation.
