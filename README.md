# R.H Pilot

A complete, lightweight Node.js trading workspace with a liquid-glass dashboard, real accounts, server-side sessions, license keys, an admin console, and the **Springboks** scalping engine.

## What is real

- Deriv public WebSocket market ticks, with automatic reconnection.
- Current Deriv Options public WebSocket market ticks, with automatic reconnection and product discovery.
- PAT account linking through Deriv REST, balance reads, short-lived OTP trading sockets, hosted cashier links, and OAuth 2.0 with PKCE.
- Explicitly confirmed LIVE five-minute CALL/PUT contract placement and early-sell requests on an account-scoped OTP socket.
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

The test suite covers password hashing, license normalization and one-account binding, signal generation, clean entries, TP/SL execution, profit-target auto-stop, adaptive-weight bounds, a mocked current Deriv REST-accounts/OTP/proposal/buy sequence, and the full HTTP login/admin/bot workflow.

GitHub Actions also runs `scripts/verify-deriv.js` on a GitHub-hosted runner. This performs a real, unauthenticated Deriv API handshake and retrieves a real XAUUSD tick without requiring any account token. During XAUUSD's scheduled market closure, it records that closure and verifies a real VOL10 tick instead, so weekend verification still proves connectivity without inventing a gold quote. On updates to `main`, `scripts/verify-deployment.js` additionally waits for the Render service, checks its public SEO and license gate, and requires a real Deriv tick from the deployed application before the workflow passes.

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

1. Public market data uses `wss://api.derivws.com/trading/v1/options/ws/public` and needs no token. Deriv's retired `ws.derivws.com` / `ws.binaryws.com` legacy hosts are not used.
2. For private account access, register a **PAT** or **OAuth** application at `developers.deriv.com` and set its App ID in **Platform settings**. Do not rely on the old public sample App ID `1089` for private production access.
3. For OAuth, configure the exact callback URL on Deriv: `https://your-domain/api/auth/deriv/callback`. The app uses the current authorization-code + PKCE flow.
4. Alternatively, create a PAT with the **trade** scope and paste it into **Deriv wallet**. R.H Pilot reads accounts through REST and requests a fresh single-use, 120-second OTP URL for each authenticated trading socket.
5. Use **Deriv wallet → Test connection** to verify the server can reach the current public Deriv API. The result reports latency or the actual socket/REST error.
6. Test on a Deriv demo account before considering real-money execution. When multiple accounts exist, initial linking deliberately selects the demo account rather than silently selecting real funds.

For a managed host, run `node server.js`, bind to `0.0.0.0`, and provide `PORT`. Persist the `data/` directory on a private volume. Put the app behind HTTPS; forwarded HTTPS requests receive Secure session/OAuth cookies. GitHub Pages is not suitable because it cannot run this persistent Node.js backend.

A production Dockerfile is included for Render, Railway, Fly.io, a VPS, or another Docker host:

```bash
docker build -t r-h-pilot .
docker run -p 3000:10000 \
  -e ADMIN_EMAIL="you@example.com" \
  -e ADMIN_PASSWORD="use-a-long-unique-password" \
  -v rhpilot-data:/app/data \
  r-h-pilot
```

The container runs as an unprivileged user and exposes `/api/health` for platform health checks. The production container and `render.yaml` use Render's documented web-service port `10000`; the server also selects that port automatically when `RENDER=true` and no explicit `PORT` is supplied. Local development remains on port `3000`. A `render.yaml` blueprint is also included: create a Render Blueprint from this repository, enter a unique admin email and strong admin password when prompted, and Render will build the Docker service with a private persistent data disk. The host must allow outbound HTTPS and WebSocket access to `api.derivws.com`. Set `DERIV_ORIGIN` to the public application URL only if the deployment requires an explicit WebSocket Origin header.

## Search discovery and sharing

The public sign-in page includes a crawlable product description, canonical URL, Open Graph/Twitter cards, a 1200×630 branded sharing image, Schema.org `SoftwareApplication` data, a web manifest, `robots.txt`, and `sitemap.xml`. API responses are marked `noindex`; the design and authenticated workspace are unchanged.

Set `PUBLIC_URL=https://your-real-domain` in production so canonical and sitemap URLs are stable. Without it, the app uses the forwarded request host. After deploying the public domain:

1. Verify the domain in Google Search Console and Bing Webmaster Tools.
2. If using meta-tag verification, set `GOOGLE_SITE_VERIFICATION` and/or `BING_SITE_VERIFICATION` to the supplied token values.
3. Submit `https://your-real-domain/sitemap.xml` in both webmaster dashboards.
4. Keep the public profile, support details and risk disclosures accurate.

These features make the site eligible for crawling and rich sharing previews; indexing timing and search ranking are controlled by the search engines and cannot be guaranteed.

## Data safety

`data/db.json`, backups, admin credentials, and recovery codes are intentionally ignored by Git. Backups contain password hashes, sessions, and Deriv tokens. Keep them private and restrict hosting-volume access. Configure the backup hub only with a private HTTPS endpoint you control.

## License

Apache-2.0. See [LICENSE](LICENSE).
