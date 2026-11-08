'use strict';
// Optional browser fixture: npm run test:ui with RHP_CHROMIUM_PATH pointing at
// a local Chrome/Chromium. No Windows terminal, private credentials or broker.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright-core');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhp-ui-'));
process.env.DATA_DIR = dir; process.env.NODE_ENV = 'test'; process.env.RENDER = 'false';
delete process.env.DATABASE_URL;
process.env.DERIV_WS_URL = 'ws://127.0.0.1:1';
process.env.ADMIN_EMAIL = 'owner@browser-fixture.test'; process.env.ADMIN_PASSWORD = 'Browser-owner-fixture-only';
process.env.DERIV_TOKEN_ENCRYPTION_KEY = '77'.repeat(32); process.env.DERIV_PAT_APP_ID = '42001';
const realFetch = global.fetch;
global.fetch = (url, options) => String(url).startsWith('https://api.derivws.com/')
  ? Promise.resolve(new Response(JSON.stringify({ error: { code: 'InvalidToken' } }), { status: 401 })) : realFetch(url, options);
const app = require('../server.js'), bridge = app._internals.mt5Bridge;
let browser;
const errors = [], viewports = [];
(async () => {
  assert.ok(process.env.RHP_CHROMIUM_PATH, 'Set RHP_CHROMIUM_PATH to a local Chrome/Chromium executable');
  const server = await app.start({ port: 0, host: '0.0.0.0' }), base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ executablePath: process.env.RHP_CHROMIUM_PATH, headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', ...(process.env.RHP_CHROMIUM_SINGLE_PROCESS === '1' ? ['--single-process', '--no-zygote'] : [])] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  assert.match(await page.locator('.deriv-pat-notice').first().textContent(), /MT5.*workspace email/);
  await page.locator('#deriv-pat-login summary').click();
  await page.locator('#auth-deriv-token').fill('fixture-token-not-a-real-credential');
  await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/auth/deriv/pat')), page.locator('#deriv-pat-signin').click()]);
  await page.waitForFunction(() => document.querySelector('#auth-deriv-token').value === '');
  assert.equal(await page.locator('#deriv-pat-login-error').isVisible(), true);
  await page.locator('#auth-email').fill(process.env.ADMIN_EMAIL); await page.locator('#auth-password').fill(process.env.ADMIN_PASSWORD);
  await page.locator('#auth-submit').click(); await page.locator('#app').waitFor({ state: 'visible' });
  await page.locator('#manual-ok').click();
  await page.locator('.nav-item[data-view="wallet"]').click();
  await page.locator('#mt5-pair-form [name="login"]').fill('1234567');
  await page.locator('#mt5-pair-form [name="server"]').fill('Deriv-Demo');
  await page.locator('#mt5-pair-form [name="symbol"]').fill('XAUUSD');
  const [paired] = await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/mt5/pair')), page.locator('#mt5-pair-button').click()]);
  const pairing = await paired.json(); const token = pairing.token; assert.ok(token);
  assert.equal(await page.locator('#mt5-pair-token').inputValue(), token);
  assert.equal(await page.locator('#mt5-pair-token').getAttribute('type'), 'password');
  await page.locator('#mt5-copy-token').click(); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), token);
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.locator('#mt5-hide-token').click(); assert.equal(await page.locator('#mt5-pair-token').inputValue(), '');
  assert.equal(await page.locator('#mt5-start').isDisabled(), true);
  await page.locator('.mt5-risk-settings summary').click();
  await page.locator('#mt5-settings-form [name="riskPerTrade"]').fill('0.7');
  const [saved] = await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/mt5/settings')), page.locator('#mt5-settings-form button[type="submit"]').click()]);
  assert.equal((await saved.json()).mt5.settings.riskPerTrade, 0.7);
  const instanceId = crypto.randomUUID(), sessionId = crypto.randomUUID(); let sequence = 0;
  const report = async () => {
    const body = { protocol: 1, instanceId, sessionId, sequence: ++sequence,
      account: { login: '1234567', server: 'Deriv-Demo', company: 'Deriv browser fixture', currency: 'USD', balance: 100, equity: 100,
        freeMargin: 100, tradeMode: 0, marginMode: 2, tradeAllowed: true, expertAllowed: true },
      quote: { symbol: 'XAUUSD', bid: 100, ask: 100.02, timeMsc: Date.now(), point: 0.01, digits: 2, tickSize: 0.01,
        tickValueLoss: 1, volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01, stopsLevel: 0, freezeLevel: 0, tradeMode: 4 },
      positions: [], pendingOrders: 0, results: [] };
    const response = await fetch(base + '/api/mt5/agent/poll', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
    assert.equal(response.status, 200); return response.json();
  };
  await report(); await page.locator('#mt5-refresh').click();
  await page.waitForFunction(() => !document.querySelector('#mt5-start').disabled);
  page.once('dialog', dialog => dialog.accept()); await page.locator('#mt5-start').click();
  await page.waitForFunction(() => !document.querySelector('#mt5-pause').disabled);
  await page.locator('#mt5-pause').click(); await page.waitForFunction(() => document.querySelector('#mt5-pause').disabled);
  const u = app._internals.db.users[0], rt = bridge.runtime.get(u.id);
  rt.history = Array.from({ length: 120 }, (_, n) => 99 + n * 0.01); rt.timeMsc = Date.now() - 10;
  bridge.chooseSignal = () => ({ dir: 1, slDist: 0.2, tpDist: 0.5, hold: 30, strategy: 'breakout-momentum' });
  page.once('dialog', dialog => dialog.accept()); await page.locator('#mt5-start').click();
  await page.waitForFunction(() => !document.querySelector('#mt5-pause').disabled);
  const intent = (await report()).command; assert.ok(intent);
  await page.locator('#mt5-refresh').click(); await page.locator('#mt5-orders tr').filter({ hasText: 'delivered' }).waitFor();
  assert.equal(await page.locator('#mt5-unlink').isDisabled(), true);
  assert.equal(u.bot.profit, 0); assert.equal(u.bot.positions.length, 0);
  for (const width of [320, 375, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const view of ['overview', 'wallet']) {
      await page.evaluate(view => navigate(view), view);
      const size = await page.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth }));
      assert.ok(size.content <= size.width + 1, view + ' overflows at ' + width + ': ' + JSON.stringify(size));
    }
    viewports.push(width);
  }
  await page.evaluate(() => navigate('settings'));
  await page.locator('#integration-form [name="derivPatAppId"]').waitFor();
  assert.equal(await page.locator('#integration-form [name="derivOauthClientId"]').count(), 1);
  await page.evaluate(() => navigate('wallet'));
  // Accelerate only the secret's two-minute timer; no application dates/risk
  // clocks or broker ticks are changed by this browser test.
  await page.evaluate(() => {
    const original = window.setTimeout;
    window.setTimeout = (fn, ms, ...args) => original(fn, ms === 120000 ? 30 : ms, ...args);
  });
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#mt5-rotate').click();
  await page.waitForFunction(() => document.querySelector('#mt5-pair-token').value === '' && document.querySelector('#mt5-secret').classList.contains('hidden'));
  assert.equal(u.mt5.orders[0].id, intent.id); assert.equal(u.mt5.mode, 'monitor');
  const stores = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  assert.equal(stores.includes(token), false);
  assert.equal(errors.length, 0, errors.join('\n'));
  if (process.env.RHP_UI_SCREENSHOT) await page.screenshot({ path: process.env.RHP_UI_SCREENSHOT, fullPage: true });
  await page.evaluate(() => document.querySelector('#logout-btn').click());
  await page.locator('#auth-screen').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#mt5-pair-token').inputValue(), '');
  const result = { ok: true, browser: browser.version(), viewports, checks: ['PAT failure/clearing', 'workspace sign-in', 'pair/masked one-time token/copy/clear',
    'independent MT5 settings', 'demo consent/start/pause', 'receipt and unresolved-exposure guard', 'separate PAT/OAuth controls', 'rotation/automatic secret clearing/logout',
    'no browser secret storage', 'no viewport overflow', 'no uncaught browser errors'], fakeBroker: true, realOrders: 0, checkedAt: new Date().toISOString() };
  console.log(JSON.stringify(result, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close(); global.fetch = realFetch; await app.stop(); fs.rmSync(dir, { recursive: true, force: true });
});
