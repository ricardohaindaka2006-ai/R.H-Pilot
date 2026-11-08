# Deriv client connection — implementation and release checklist

**Status: client-authentication code implemented and locally tested; not a completed real-trading release.** This branch does not enable new broker orders. Account access, public live prices and actual trading are three separate capabilities.

## Implemented

- **Direct token sign-in:** the sign-in page has a password-masked PAT form. `POST /api/auth/deriv/pat` validates account access with Deriv before creating a workspace/session. No separate workspace email/password is needed for a client. Existing licence requirements still apply; a returning client can use its already-bound valid licence.
- **Deriv account sign-in:** OAuth authorization code + S256 PKCE, with a canonical callback, bounded exchange timeout, browser-bound state, server-held verifier and one-time transaction consumption. A restart expires outstanding OAuth transactions; start again rather than replaying a code.
- **Authenticated linking:** Wallet linking is tied to the initiating workspace. OAuth linking also requires the exact initiating session, rechecked after asynchronous provider verification. Expired sessions cannot turn a link into an unintended login.
- **Ownership:** broker-confirmed account IDs identify a client, never an unverified email, requested role or client-supplied demo flag. Conflicting workspace ownership is rejected, not merged. A broker credential alone cannot open an administrator workspace: use the admin password or Google sign-in first, then link from Wallet.
- **Credential handling:** tokens are not returned by the public/user API or placed in browser storage. Both PAT fields clear on success and failure. Known, controlled errors replace reflected provider messages and OTP/socket descriptions. Auth/API responses are not cacheable; OAuth responses use `no-referrer`.
- **Encrypted token storage:** with the server encryption key configured, Deriv tokens in `db.json`, downloaded/local backups and hub snapshots use AES-256-GCM with random nonces and user-bound authenticated data. The environment key is never included in those files. Production token connection is disabled without a valid key. Other snapshot contents, including sessions/configuration, still require private storage.
- **Real quote ingestion:** the actual WebSocket producer's `live` source is accepted. Received live packets evaluate synchronously instead of waiting for the 80 ms safety loop. Malformed, stale, future and out-of-order observations are rejected; equal-price new observations are retained. Timer passes do not recount a tick.
- **Causal warm-up:** newer `main` practice/history warm-up and sizing-precision work is preserved. Broker history bootstraps indicators only: it cannot create a fresh live quote, rewind a current price/tick sequence, introduce overlapping later data, or execute an exit. Superseded sockets cannot overwrite a newer feed. Provider timestamps do not gain another freshness window at receipt.
- **Measured scope:** `/api/health.marketTickProcessing` keeps at most 256 local tick-ingestion/evaluation latency samples. These include synchronous paper-risk persistence where it occurs; they exclude network and broker order/fill latency.

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

Latest locked-dependency local verification: **2026-11-08T16:17:52.673Z**, Node **22.22.3**, npm **10.9.8**.

| Check | Result / limitation |
|---|---|
| JavaScript syntax | 20 files passed. |
| Entire automated suite | **180/180 passed**, 0 failed, 4,245.295676 ms. Includes 49 new connection/feed/security regressions. |
| Frozen strategy report | Reproduced exactly; engine/risk/model/report files and package manifests unchanged from newer `main`. No new trading edge is established. |
| Production dependency audit | **0 vulnerabilities**. Temporary browser tools were removed; they were not added to package manifests. |
| Real browser smoke | Headless Chromium 138: 320, 375, 768 and 1440 px; no horizontal overflow or page errors. Real application HTTP sign-in rejected/accepted fixture credentials, cleared fields, issued an HttpOnly session that survived reload, kept credentials out of browser storage and encrypted them on disk. **Deriv REST responses were fixtures; no real broker credential was used.** |
| Signal-only benchmark | 12,000 iterations × 4 strategies: mean **0.006 ms**, p50 **0.0038 ms**, p95 **0.0127 ms**, max **1.0781 ms**. Not order latency, a trading SLA or a guaranteed microsecond fill. |
| Existing public deployment evidence | GitHub run `42481188227` recorded a successful public-tick/health smoke check on the canonical origin at 2026-11-08T12:38:27.767Z, before these authentication changes. It did not validate private login, orders, persistence or this branch's deployment. |
| Repository inventory | Native GitHub CLI returned **one visible repository**, `R.H-Pilot`, for this owner. No repositories were deleted or created. |
| Render inventory / cleanup | Not verified; no services were deleted, upgraded or newly provisioned. One YAML service declaration is not proof that no other Render services exist. |

Raw local evidence is ignored under `test-results/deriv-connection-2026-11-08/`. No real account was linked, no order was placed and no exposed credential was used.

## Remaining real-trading release blockers

1. **Choose the broker product.** Current integration is **Deriv Options**, not MT5/CFDs. Five-minute CALL/PUT payoffs cannot use the paper engine's price TP/SL as actual option settlement. MT5/CFD scalping requires a different authenticated execution adapter and its own contract specifications.
2. Implement durable, account-bound broker orders/contracts, stake/exposure reservations and broker-authoritative P/L, sell/expiry/settlement, uncertain-buy recovery, rejected-sell handling and restart reconciliation. A risk budget below the broker's minimum admissible stake/position must result in no trade, not increased risk.
3. Demonstrate the entire lifecycle and failure recovery on demo with actual broker responses, then validate frozen settings out of sample. Existing synthetic evidence does not establish a live profitable edge or a 90–95% win rate.
4. Obtain approval for a durable, suitable hosting design and prove restart/recovery. No paid plan was silently selected. Do not delete unidentified services; confirm exact obsolete service IDs/names and the canonical target first.
5. Complete a final security/operational review, review the demo evidence and only then implement a separately tested, account-specific real-execution consent gate. Simply flipping the present disabled flag is not a release.

There is still no daily trade-count ceiling or default profit ceiling. Protective limits can legitimately stop trading. Fast local decisions cannot guarantee winning trades, zero losses, continuous profits or broker fills in milliseconds/microseconds.
