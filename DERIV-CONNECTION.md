# Deriv client connection — implementation and release checklist

**Status: client-authentication code implemented and locally tested; not a completed real-trading release.** This branch does not enable new broker orders. Account access, public live prices and actual trading are three separate capabilities.

## Implemented

- **Direct token sign-in:** the sign-in page has a password-masked PAT form. `POST /api/auth/deriv/pat` validates account access with Deriv before creating a workspace/session. No separate workspace email/password is needed for a client. Existing licence requirements still apply; a returning client can use its already-bound valid licence. Broker-confirmed demo and real account types can be selected, but real account access does not enable orders.
- **Deriv account sign-in:** OAuth authorization code + S256 PKCE, with a canonical callback, bounded exchange timeout, browser-bound state, server-held verifier and one-time transaction consumption. A restart expires outstanding OAuth transactions; start again rather than replaying a code.
- **Authenticated linking:** Wallet linking is tied to the initiating workspace. OAuth linking also requires the exact initiating session, rechecked after asynchronous provider verification. Expired sessions cannot turn a link into an unintended login.
- **Ownership:** broker-confirmed account IDs identify a client, never an unverified email, requested role or client-supplied demo flag. Conflicting workspace ownership is rejected, not merged. A broker credential alone cannot open an administrator workspace: use the admin password or Google sign-in first, then link from Wallet.
- **Credential handling:** tokens are not returned by the public/user API or placed in browser storage. Both PAT fields clear on success and failure. Known, controlled errors replace reflected provider messages and OTP/socket descriptions. Auth/API responses are not cacheable; OAuth responses use `no-referrer`.
- **Encrypted token storage:** with the server encryption key configured, Deriv tokens in `db.json`, downloaded/local backups and hub snapshots use AES-256-GCM with random nonces and user-bound authenticated data. The environment key is never included in those files. Production token connection is disabled without a valid key. Other snapshot contents, including sessions/configuration, still require private storage.
- **Real quote ingestion:** the actual WebSocket producer's `live` source is accepted. Received live packets evaluate synchronously instead of waiting for the 80 ms safety loop. Malformed, stale, future and out-of-order observations are rejected; equal-price new observations are retained. Timer passes do not recount a tick.
- **Causal warm-up:** newer `main` practice/history warm-up and sizing-precision work is preserved. Broker history bootstraps indicators only: it cannot create a fresh live quote, rewind a current price/tick sequence, introduce overlapping later data, or execute an exit. Superseded sockets cannot overwrite a newer feed. Provider timestamps do not gain another freshness window at receipt.
- **Measured scope:** `/api/health.marketTickProcessing` keeps at most 256 local tick-ingestion/evaluation latency samples. These include synchronous paper-risk persistence where it occurs; they exclude network and broker order/fill latency.

## Selected modes and current order-lifecycle status

The user selected **two separate execution modes**: (1) Deriv Options with both **Rise/Fall** and **Digit Matches/Differs**, and (2) **MT5/CFDs**. The selected hosting target is Render. Neither selection enables real trading or approves hosting spend.

| Capability | Current status |
|---|---|
| Deriv demo/real account authentication and exact account selection | Implemented as account-access functionality; it is not an order permission. |
| Deriv Rise/Fall bot lifecycle | Not implemented end to end. Account verification currently makes a quote-only CALL proposal; a low-level demo CALL/PUT helper is not integrated into bot entries/settlement. |
| Deriv Digit Matches/Differs | Not implemented: no bot strategy/proposal/buy/contract/settlement lifecycle. |
| MT5/CFD | Separate product mode; no MT5 account bridge or bot-order lifecycle exists. Deriv credentials/quotes cannot be routed to it. |
| Real orders | Disabled by the backend fail-closed gate. `deriv/ready` remains false; do not flip a flag to enable orders. |

Options contracts must use broker-confirmed proposals, stakes, contract IDs, permitted sales and settlement. They cannot inherit the paper engine's price-based CFD stop/target behavior. Demo and real accounts must have exact account-bound, mode-specific order records and reconciliation before any broker lifecycle can be treated as operational.

## Production configuration

Canonical repository: `ricardohaindaka2006-ai/R.H-Pilot`.
Declared Render service: `r-h-pilot-3`.
Canonical origin: `https://r-h-pilot-3.onrender.com`.

| Setting | Operator action |
|---|---|
| `DERIV_APP_ID` | Register the correct PAT/OAuth application in the Deriv developer dashboard. Set its **public App ID**, not a token or sample ID `1089`. PAT and OAuth must use the correct application registration. |
| `PUBLIC_URL` | Set the canonical HTTPS origin above, or a deliberately chosen custom origin. Production OAuth does not infer its callback from forwarded hosts. |
| Registered OAuth redirect | Must exactly match `https://r-h-pilot-3.onrender.com/api/auth/deriv/callback` for this origin. |
| `DERIV_TOKEN_ENCRYPTION_KEY` | Set once in the hosting secret environment: a random 32-byte key encoded as 64 hex characters or canonical base64/base64url. New Blueprint services use `generateValue: true`. Existing services need this environment setting added securely. Keep the same key across deploys. Never put it in chat, Platform settings, source, or a backup file. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Configure unique administrator credentials in hosting secrets. |
| Durable state | Provision an approved persistent volume or database, back it up, and prove recovery. The current Free blueprint has **no persistent disk**. Encryption does not make ephemeral storage durable. |

`GET /api/config/public` exposes `derivConnection`: configuration flags, required setup codes, callback URL, credential-storage mode and `liveExecutionEnabled: false`. Configuration flags are not evidence that a particular client's token has been accepted.

Never use real credentials in development's explicitly labelled `development-plaintext` mode. Production requires HTTPS and the encryption key. Connection attempts are rate-limited (12 per minute per address), not daily trades. On Render or an explicitly trusted proxy, the nearest appended forwarded client address is used; do not enable `TRUST_PROXY=1` on an untrusted direct deployment.

### Connection acceptance procedure — no orders

1. Revoke every credential previously exposed in chat. Generate a replacement privately; **do not send it to an agent**.
2. Deploy this branch's reviewed changes to the canonical service and set the configuration above through the appropriate secure interfaces.
3. Confirm `/api/health.build.commit` matches the intended deployment. The main-branch CI verifier checks `EXPECTED_DEPLOY_SHA`, not merely an older healthy process. It also reports client configuration separately from real execution.
4. Use a demo credential first. Test both **Continue with Deriv** and **Sign in with a Deriv token** in a browser. Check account ID, broker-confirmed demo/real type and currency. Demo is preferred; multiple real accounts require an exact choice. Unknown balances remain unknown, not invented available funds.
5. Sign out/reload/sign in again. Check ownership rejection, licence enforcement and token revocation. Neither a successful sign-in nor a quote-only account check is authority to claim working order settlement.
6. With a separately retained encryption key, test recovery of a private encrypted backup and a service restart on durable storage. Wrong/missing keys and tampering must fail closed. Do not rotate the key blindly: old encrypted records require their original key or a verified migration/relinking procedure.

Legacy plaintext broker credentials are sealed on the next successful save when a key is configured. Old backup files are not retroactively encrypted or deleted; keep them private, revoke old tokens and retire named obsolete copies through a reviewed procedure.

## Verification evidence

Latest full local verification of the current working tree: **2026-11-08**; Node **22.22.3**, npm **10.9.8**.

| Check | Result / limitation |
|---|---|
| JavaScript syntax | **22 files passed.** |
| Entire automated suite | **193/193 passed**, 0 failed/skipped/cancelled, 3,875 ms. Includes session-entry-cap validation, durable counter reload, durable-fill rollback, cap enforcement and continued open-position exits. |
| Frozen strategy report | Reproduced exactly. No strategy parameters were tuned for a target win rate; synthetic results do not establish live performance. |
| Production dependency audit | **0 vulnerabilities** (`npm audit --omit=dev`). |
| Real browser smoke | The previously recorded Headless Chromium 138 smoke covered 320, 375, 768 and 1440 px plus fixture-based sign-in; it predates the session-cap UI edit and was **not rerun** here. The current automated dashboard/form tests are not a real-browser or broker test. **Deriv REST responses in the older smoke were fixtures; no real broker credential was used.** |
| Signal-only benchmark | 12,000 contexts × five strategies: mean **0.0088 ms**, p50 **0.0077 ms**, p95 **0.0102 ms**, max **0.406 ms**. Local signal computation only; excludes broker/network order latency and fills. |
| Existing public deployment evidence | GitHub run `42481188227` recorded a successful public-tick/health smoke check on the canonical origin at 2026-11-08T12:38:27.767Z, before these authentication changes. It did not validate private login, orders, persistence or this branch's deployment. |
| Repository inventory | Native GitHub CLI returned **one visible repository**, `R.H-Pilot`, for this owner. No repositories were deleted or created. |
| Render inventory / cleanup | Not verified; no services were deleted, upgraded or newly provisioned. One YAML service declaration is not proof that no other Render services exist. |

Raw local evidence is ignored under `test-results/deriv-connection-2026-11-08/`. No real account was linked, no order was placed and no exposed credential was used.

## Remaining real-trading release blockers

1. Implement **Deriv Options Rise/Fall and Digit Matches/Differs separately**, including authenticated proposal terms, durable stake reservations, buy/contract IDs, broker-confirmed sale where supported, expiry settlement and authoritative P/L. The current quote-only CALL check and isolated demo helper do not satisfy this lifecycle.
2. Implement an **independent MT5/CFD adapter** with a confirmed broker/terminal or supported gateway, same-account quotes, exact symbol rules, orders/positions/deals, authoritative P/L and recovery. The pure sizing primitive in `engine/cfd-risk.js` is not connected to bot entries; minimum-lot costs that exceed budget must result in no trade.
3. Implement durable mode/account-bound order intents and reconciliation for rejection, delayed/lost acknowledgments, disconnect, partial execution, stop/sale failures, expiry and restart. Enforce the user's per-start session cap with a durable slot reservation before every broker submission; the present cap only counts paper fills.
4. Demo-test each mode with actual broker responses, verify exact demo/real account identity and cross-mode isolation, then validate frozen settings out of sample. Synthetic results do not establish a live edge or a 90–95% win rate.
5. Render is the selected hosting target, but approve an itemized deployment/storage plan and prove backup/restart recovery before relying on customer or trading state. The declared Free service is ephemeral; no paid plan was silently selected. Do not delete unidentified services.
6. Complete independent product, security and operational review, customer consent, monitoring and rollback/recovery; only then consider a separately tested real-execution gate. Simply flipping a flag is not a release.

There is no daily trade-count ceiling or default profit ceiling in the current paper engine; its optional per-session limit is separate. Protective limits can still stop trading. Fast local decisions cannot guarantee winning trades, zero losses, continuous profits or broker fills in milliseconds/microseconds.
