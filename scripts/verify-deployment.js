'use strict';

/* Public, credential-free production smoke test. Render can take several
   minutes to build or wake, so wait for a real R.H Pilot health response rather
   than accepting Render's "Application loading" interstitial as success. */
const fs = require('node:fs');
const assert = require('node:assert/strict');
const base = String(process.env.DEPLOY_URL || 'https://r-h-pilot-3.onrender.com').replace(/\/+$/, '');
const deadline = Date.now() + 12 * 60 * 1000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let lastProblem = 'No response yet';

async function json(path) {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(path + ' returned HTTP ' + response.status);
  return response.json();
}
function report(result) {
  fs.writeFileSync('production-diagnostic.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
(async () => {
  let health;
  while (Date.now() < deadline) {
    try {
      health = await json('/api/health');
      assert.equal(health.ok, true);
      assert.ok(health.engine && health.engine.symbols >= 16);
      break;
    } catch (error) {
      lastProblem = error.message;
      health = null;
      console.log('Waiting for Render:', lastProblem);
      await sleep(12000);
    }
  }
  assert.ok(health, 'Render did not serve a healthy application: ' + lastProblem);

  const [home, license, robots, sitemap] = await Promise.all([
    fetch(base + '/', { signal: AbortSignal.timeout(15000) }).then(async r => { assert.equal(r.status, 200); return r.text(); }),
    json('/api/license/status'),
    fetch(base + '/robots.txt', { signal: AbortSignal.timeout(15000) }).then(r => r.text()),
    fetch(base + '/sitemap.xml', { signal: AbortSignal.timeout(15000) }).then(r => r.text())
  ]);
  assert.match(home, /R\.H Pilot/);
  assert.ok(home.includes(`<link rel="canonical" href="${base}/">`), 'Production canonical URL is incorrect');
  assert.equal(license.required, true, 'Public registrations must require admin-generated license keys');
  assert.ok(robots.includes(`Sitemap: ${base}/sitemap.xml`));
  assert.ok(sitemap.includes(`<loc>${base}/</loc>`));

  // Wait for actual account-free market ticks, not just an open socket.
  const derivDeadline = Date.now() + 3 * 60 * 1000;
  while (!health.deriv?.live && Date.now() < derivDeadline) {
    console.log('Waiting for a real Deriv tick:', health.deriv?.lastError || health.deriv?.status);
    await sleep(8000);
    health = await json('/api/health');
  }
  assert.equal(health.deriv?.live, true, 'Render did not receive a real Deriv tick: ' + (health.deriv?.lastError || health.deriv?.status));
  assert.ok(health.deriv.lastTickAt, 'Deriv tick timestamp is missing');
  report({ ok: true, url: base, version: health.version, licenseRequired: license.required, canonical: base + '/', derivLive: true, derivLastTickAt: health.deriv.lastTickAt, runningBots: health.engine.runningBots, checkedAt: new Date().toISOString() });
})().catch(error => {
  report({ ok: false, url: base, error: error.message, stack: error.stack, checkedAt: new Date().toISOString() });
  process.exitCode = 1;
});
