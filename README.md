# R.H Pilot

A complete, lightweight Node.js trading workspace with a liquid-glass dashboard, real accounts, server-side sessions, license keys, an admin console, and the **Springboks** scalping engine.

## What is real

- Deriv public WebSocket market ticks, with automatic reconnection.
- Deriv API token linking, account balance reads, hosted cashier links, and OAuth routes.
- Explicitly confirmed LIVE five-minute CALL/PUT contract placement and early-sell requests.
- Server-side simulated positions, P/L, trade history, adaptive detector weights, and risk exits.
- Secure scrypt password hashes, HttpOnly sessions, user administration, subscriptions, backups, market reports, and diagnostics.

## Honest limits

- **No strategy can select only profitable trades or guarantee returns.** Springboks filters aligned setups and manages risk; losses remain possible.
- Simulation is always labelled `SIM`. Its P/L is not a Deriv account balance.
- LIVE contracts are authoritative in the Deriv statement. Early sells depend on Deriv contract rules and market availability.
- A sandbox or offline server displays the simulator fallback instead of pretending Deriv is connected.

## Requirements

Node.js **22 or newer**. The only runtime package is the production-standard `ws` WebSocket client used for Deriv's Node handshake.

## Run

```bash
npm ci
npm start
# open http://localhost:3000
```

On the first run an admin is created. Its credentials are printed to the console and written with owner-only permissions to `data/admin-credentials.txt`. Set them explicitly in production:

```bash
ADMIN_EMAIL="you@example.com" \
ADMIN_PASSWORD="use-a-long-unique-password" \
PORT=3000 \
npm start
```

For local development, `npm run dev` enables Node's watch mode.

## Verify

```bash
npm run check
npm test
```

The test suite covers password hashing, license normalization and one-account binding, signal generation, clean entries, TP/SL execution, profit-target auto-stop, adaptive-weight bounds, a mocked Deriv authorize/balance/proposal/buy sequence, and the full HTTP login/admin/bot workflow.

GitHub Actions also runs `scripts/verify-deriv.js` on a GitHub-hosted runner. This performs a real, unauthenticated Deriv API handshake and retrieves a real XAUUSD tick without requiring any account token.

## Springboks engine

- Deriv tick events trigger evaluation immediately; a 100 ms loop is a safety net.
- The simulator emits ticks every 250 ms and uses the same event-driven evaluation path.
- Four detectors vote: EMA trend, rate-of-change momentum, micro-range breakout, and RSI reversal.
- Entries require an aggression-adjusted weighted threshold plus trend/momentum agreement.
- Exposure is limited by cooldown, maximum positions, and opposite-direction blocking.
- Exits include TP, SL, breakeven lock, trailing protection, rare signal-flip exit, and an optional profit-target auto-stop.
- Closed outcomes adjust detector weights online. Weights are clamped and normalized to prevent runaway dominance.
- All bots continue server-side when the browser closes.

## Deriv configuration

1. Register your own Deriv application and set its App ID in **Platform settings**. The public sample App ID `1089` is suitable for basic public-data testing, not necessarily your production OAuth callback.
2. Select the OAuth generation used when your app was registered. New apps use `auth.deriv.com`; legacy apps use `oauth.deriv.com`.
3. Configure the exact callback URL on Deriv: `https://your-domain/api/auth/deriv/callback`.
4. Alternatively, link a Deriv API token with **Read** scope. Add **Trade** only when intentionally enabling LIVE.
5. Use **Deriv wallet → Test connection** to verify the server can reach Deriv. The result is reported honestly with latency or the actual socket error.
6. Test on a Deriv demo account before considering real-money execution.

For a managed host, run `node server.js`, bind to `0.0.0.0`, and provide `PORT`. Persist the `data/` directory on a private volume. Put the app behind HTTPS; forwarded HTTPS requests receive Secure session/OAuth cookies. GitHub Pages is not suitable because it cannot run this persistent Node.js backend.

A production Dockerfile is included for Render, Railway, Fly.io, a VPS, or another Docker host:

```bash
docker build -t r-h-pilot .
docker run -p 3000:3000 \
  -e ADMIN_EMAIL="you@example.com" \
  -e ADMIN_PASSWORD="use-a-long-unique-password" \
  -v rhpilot-data:/app/data \
  r-h-pilot
```

The container runs as an unprivileged user and exposes `/api/health` for platform health checks. A `render.yaml` blueprint is also included: create a Render Blueprint from this repository, enter a unique admin email and strong admin password when prompted, and Render will build the Docker service with a private persistent data disk. The host must allow outbound WebSocket access to `ws.derivws.com`.

## Data safety

`data/db.json`, backups, admin credentials, and recovery codes are intentionally ignored by Git. Backups contain password hashes, sessions, and Deriv tokens. Keep them private and restrict hosting-volume access. Configure the backup hub only with a private HTTPS endpoint you control.

## License

Apache-2.0. See [LICENSE](LICENSE).
