# Deriv client connection — implementation and release checklist

**Status: client-authentication code implemented and locally tested; not a completed real-trading release.** New real-money orders remain disabled. The selected MT5/CFD demo adapter is separate; see [MT5-FREE-SETUP.md](MT5-FREE-SETUP.md). Account access, public live prices and actual trading are three separate capabilities.

## Implemented

- **Direct token sign-in:** the sign-in page has a password-masked PAT form. `POST /api/auth/deriv/pat` validates account access with Deriv before creating a workspace/session. No separate workspace email/password is needed for a client. Existing licence requirements still apply; a returning client can use its already-bound valid licence.
- **Deriv account sign-in:** OAuth authorization code + S256 PKCE, with a canonical callback, bounded exchange timeout, browser-bound state, server-held verifier and one-time transaction consumption. A restart expires outstanding OAuth transactions; start again rather than replaying a code.
- **Authenticated linking:** Wallet linking is tied to the initiating workspace. OAuth linking also requires the exact initiating session, rechecked after asynchronous provider verification. Expired sessions cannot turn a link into an unintended login.
- **Ownership:** broker-confirmed account IDs identify a client, never an unverified email, requested role or client-supplied demo flag. Conflicting workspace ownership is rejected, not merged. A broker credential alone cannot open an administrator workspace: use the admin password or Google sign-in first, then link from Wallet.
- **Credential handling:** tokens are not returned by the public/user API or placed in browser storage. Both PAT fields clear on success and failure. Known, controlled errors replace reflected provider messages and OTP/socket descriptions. Auth/API responses are not cacheable; OAuth responses use `no-referrer`.
- **Encrypted token storage:** with the server encryption key configured, Deriv tokens in the PostgreSQL payload (or local research `db.json`), downloaded/local backups and hub snapshots use AES-256-GCM with random nonces and user-bound authenticated data. The environment key is never included in those files. Production token connection is disabled without a valid key. Other snapshot contents, including sessions/configuration, still require private storage.
- **Real quote ingestion:** the actual WebSocket producer's `live` source is accepted. Received live packets evaluate synchronously instead of waiting for the 80 ms safety loop. Malformed, stale, future and out-of-order observations are rejected; equal-price new observations are retained. Timer passes do not recount a tick.
- **Causal warm-up:** newer `main` practice/history warm-up and sizing-precision work is preserved. Broker history bootstraps indicators only: it cannot create a fresh live quote, rewind a current price/tick sequence, introduce overlapping later data, or execute an exit. Superseded sockets cannot overwrite a newer feed. Provider timestamps do not gain another freshness window at receipt.
- **Measured scope:** `/api/health.marketTickProcessing` keeps at most 256 local tick-ingestion/evaluation latency samples. These include synchronous paper-risk persistence where it occurs; they exclude network and broker order/fill latency.

## Production configuration

Canonical repository: `ricardohaindaka2006-ai/R.H-Pilot`.
Declared Render service: `r-h-pilot-3`.
Canonical origin: `https://r-h-pilot-3.onrender.com`.

| Setting | Operator action |
|---|---|
| `DERIV_PAT_APP_ID` | Register a PAT application and set its public App ID. It is sent in the PAT REST header, not used as an OAuth client. Never put a token here. |
| `DERIV_OAUTH_CLIENT_ID` | Register the OAuth application separately and set its public client ID. OAuth bearer REST/OTP calls omit the PAT-only App ID header. |
| `DERIV_APP_ID` | Legacy compatibility fallback only; prefer the separate registrations above. Never use sample `1089` for private production access. |
| `PUBLIC_URL` | Set the canonical HTTPS origin above, or a deliberately chosen custom origin. Production OAuth does not infer its callback from forwarded hosts. |
| Registered OAuth redirect | Must exactly match `https://r-h-pilot-3.onrender.com/api/auth/deriv/callback` for this origin. |
| `DERIV_TOKEN_ENCRYPTION_KEY` | Set once in the hosting secret environment: a random 32-byte key encoded as 64 hex characters or canonical base64/base64url. New Blueprint services use `generateValue: true`. Existing services need this environment setting added securely. Keep the same key across deploys. Never put it in chat, Platform settings, source, or a backup file. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Keep `ricardohaindaka2006@gmail.com`; configure a rotated unique password privately. No plaintext credentials file ships; changing env credentials revokes previous admin sessions. |
| `DATABASE_URL` / durable state | Supply an operator-owned direct/session PostgreSQL connection with stable namespace/key; migration is explicit and auth success awaits durable commit. No database/disk is provisioned by the Free blueprint. Local Free files are ephemeral; expiring Free Render PostgreSQL is not permanent durability. |

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

## Historical PR #18 evidence (before MT5/storage changes)

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

These historical results are not the latest build acceptance; see [MT5-VERIFICATION.md](MT5-VERIFICATION.md) for current checks. Raw historical local evidence is ignored under `test-results/deriv-connection-2026-11-08/`. No real account was linked, no order was placed and no exposed credential was used.

## Current release boundaries

1. **Product already chosen: MT5/CFDs.** The implemented terminal/demo adapter is separate from these Options-wallet endpoints. No repeat product decision or paid hosting approval is needed.
2. Supply actual registered PAT/OAuth IDs only if using Options wallet access, replacement private secrets and suitable durable PostgreSQL configuration. Migrate current identities/licences/risk before redeploying ephemeral files; prove restart recovery.
3. Complete the actual Windows/broker demo lifecycle and fault acceptance in [MT5-FREE-SETUP.md](MT5-FREE-SETUP.md), then validate frozen settings against representative costs/forward observations. Offline green tests do not establish a live edge or 90–95% wins.
4. Keep one canonical Free service and one state writer. No paid upgrade/provisioning or deletion of unidentified resources is authorized. Real execution stays disabled pending separate operational/security review and explicit authorization.

There is still no daily trade-count ceiling or default profit ceiling. Protective limits can legitimately stop trading. Fast local decisions cannot guarantee winning trades, zero losses, continuous profits or broker fills in milliseconds/microseconds.

## Current boundaries

PAT/OAuth token expiry, private persistence failures and App ID setup failures are reported with controlled reconnect/setup errors. MT5-only clients use workspace email/Google plus terminal pairing; they do not need an Options PAT. Actual registered production App IDs, private secrets and provider/browser acceptance remain operator steps. A working public quote or fixture sign-in does not prove actual private broker acceptance.

The chosen product/Free plan is recorded in [LIVE-TRADING-PLAN.md](LIVE-TRADING-PLAN.md); no paid upgrade or real activation is approved. Production MT5 setup, storage scope and native demo acceptance are in [MT5-FREE-SETUP.md](MT5-FREE-SETUP.md).
