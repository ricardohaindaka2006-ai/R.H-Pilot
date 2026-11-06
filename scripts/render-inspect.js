'use strict';

// Credential-free output: secrets stay in the GitHub Actions environment and
// are never printed. Only redacted service/deploy/event metadata is published.
const fs = require('node:fs');
const key = process.env.RENDER_API_KEY;
const serviceId = process.env.RENDER_SERVICE_ID || 'srv-dbn00rm417fc739us4a0';
const output = { ok: false, serviceId, checkedAt: new Date().toISOString() };
function save() {
  fs.writeFileSync('render-diagnostic.json', JSON.stringify(output, null, 2));
}
function redact(value, property = '') {
  if (/password|secret|token|credential|api.?key|value/i.test(property)) return '[redacted]';
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
  }
  return value;
}
async function api(path) {
  const response = await fetch('https://api.render.com/v1' + path, {
    headers: { Accept: 'application/json', Authorization: 'Bearer ' + key },
    signal: AbortSignal.timeout(20000)
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { message: text.slice(0, 500) }; }
  if (!response.ok) throw new Error('Render API ' + path + ' returned ' + response.status + ': ' + (body.message || JSON.stringify(body)).slice(0, 700));
  return body;
}
(async () => {
  if (!key) throw new Error('RENDER_API_KEY is not available to this workflow. Add it as a repository Actions secret.');
  const [service, deployPage, eventPage] = await Promise.all([
    api('/services/' + serviceId),
    api('/services/' + serviceId + '/deploys?limit=12'),
    api('/services/' + serviceId + '/events?limit=40')
  ]);
  const deploys = (Array.isArray(deployPage) ? deployPage : []).map(entry => entry.deploy || entry);
  const events = (Array.isArray(eventPage) ? eventPage : []).map(entry => entry.event || entry);
  Object.assign(output, {
    ok: true,
    service: redact(service),
    deploys: redact(deploys),
    events: redact(events)
  });
  save();
  console.log('Render inspection complete:', service.name, 'suspended=' + service.suspended, 'latestDeploy=' + (deploys[0]?.status || 'none'), 'events=' + events.length);
})().catch(error => {
  output.error = error.message;
  save();
  console.error(error.message);
  process.exitCode = 1;
});
