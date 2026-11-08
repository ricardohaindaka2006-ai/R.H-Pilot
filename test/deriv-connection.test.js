'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhpilot-deriv-connection-'));
process.env.DATA_DIR = dir;
process.env.DERIV_WS_URL = 'ws://127.0.0.1:1';
process.env.DERIV_NATIVE_WS = '1';
process.env.DERIV_APP_ID = 'fixture-registered-app';
process.env.NODE_ENV = 'test';
const app = require('../server.js'), I = app._internals;
const A = I.DERIV_AUTH, C = I.CREDENTIALS, P = I.ENGINE.EXECUTION;
const wireFetch = global.fetch, originalSocket = global.WebSocket;
const key = '11'.repeat(32); // deliberately public, non-production fixture key
const TOKEN = 'fixture-not-a-real-broker-token';
const dbPath = path.join(dir, 'db.json');
const demo = { account_id: 'VRTC-fixture', account_type: 'demo', status: 'active', currency: 'USD', balance: 10000 };
const real = { account_id: 'CR-fixture', account_type: 'real', status: 'active', currency: 'USD', balance: 120 };
let server, base, calls, accounts;
function response(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }
function mockBroker() {
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url) === 'https://auth.deriv.com/oauth2/token') return response({ access_token: TOKEN, expires_in: 3600 });
    assert.equal(String(url), 'https://api.derivws.com/trading/v1/options/accounts', 'sign-in must only verify account access, not request an OTP/proposal/buy');
    return response({ data: accounts });
  };
}
function reset() {
  process.env.NODE_ENV = 'test'; process.env.DERIV_TOKEN_ENCRYPTION_KEY = key; delete process.env.PUBLIC_URL;
  delete process.env.TRUST_PROXY; delete process.env.ARENA_PREVIEW; process.env.RENDER = 'false';
  calls = []; accounts = [structuredClone(demo), structuredClone(real)]; mockBroker();
  I.db = { users: [], sessions: {}, config: I.DEFAULT_CONFIG(), createdAt: Date.now() };
  I.db.config.licenseRequired = false;
  I.oauthFlows.pending.clear(); I.connectionAttempts.clear();
  I.tickTelemetry.count = 0; I.tickTelemetry.samples.length = 0; I.tickTelemetry.lastAt = null;
  fs.rmSync(dbPath + '.tmp', { force: true });
  assert.equal(app.saveDb(), true);
}
function user(id = 'workspace', role = 'user') {
  const u = app.makeUser(id + '@example.test', 'fixture-password-never-used', role);
  I.db.users.push(u); return u;
}
function owned(u, loginid = demo.account_id, token = 'fixture-previous-token') {
  u.deriv = { loginid, token, currency: 'USD', isVirtual: loginid.startsWith('VRTC'),
    balance: 100, accounts: [{ loginid, currency: 'USD', isVirtual: loginid.startsWith('VRTC') }] };
  return u;
}
function sid(u) { return 'sid=' + I.createSession(u.id); }
async function request(route, { method = 'GET', body, cookie, headers = {} } = {}) {
  const r = await wireFetch(base + route, { method, redirect: 'manual',
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000) });
  const text = await r.text();
  return { status: r.status, headers: r.headers, text, data: text ? JSON.parse(text) : null };
}
const pat = (body = { token: TOKEN }, options = {}) => request('/api/auth/deriv/pat', { ...options, method: 'POST', body });
function cookieFrom(result, name) {
  const cookie = result.headers.getSetCookie().find(c => c.startsWith(name + '='));
  return cookie ? cookie.split(';')[0] : null;
}
async function begin(cookie, link = false) {
  const result = await request('/api/auth/deriv/start' + (link ? '?link=1' : ''), { cookie });
  assert.equal(result.status, 302);
  const url = new URL(result.headers.get('location'));
  assert.equal(url.origin, 'https://auth.deriv.com');
  return { result, url, state: url.searchParams.get('state'), cookie: cookieFrom(result, 'derivstate') };
}
async function callback(flow, cookie = flow.cookie, suffix = '') {
  return request('/api/auth/deriv/callback?code=fixture-authorization-code&state=' + flow.state + suffix, { cookie });
}
test.before(async () => {
  server = app.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});
test.beforeEach(reset);
test.after(async () => {
  global.fetch = wireFetch;
  await app.stop(); global.WebSocket = originalSocket;
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('registered App ID and token parsers reject samples, PAT-as-App-ID and malformed input', () => {
  for (const value of ['', '1089', 'pat_fixture-never-a-real-pat', 'PAT_FIXTURE', 'id with spaces', {}, null, 123]) assert.equal(A.validAppId(value), false);
  for (const value of ['12345', 'fixture-registered-app', 'oauth_fixture']) assert.equal(A.validAppId(value), true);
  assert.equal(A.tokenValue('  ' + TOKEN + '  '), TOKEN);
  for (const value of [null, {}, 123]) assert.throws(() => A.tokenValue(value), { code: 'deriv-auth-invalid-request' });
  for (const value of ['has spaces', 'line\nbreak', 'x'.repeat(4097), 'not-ascii-\u2028-middle']) assert.throws(() => A.tokenValue(value), { code: 'invalid-token' });
});

test('PKCE transactions are server-held, browser-bound, expiring and consumed once', () => {
  const flows = new A.OAuthFlows({ ttlMs: 100, maxPending: 1 });
  const start = flows.begin({ clientId: 'fixture', redirectUri: base + '/callback', linkUserId: 'bound-user' }, 1000);
  assert.match(start.state, /^[a-f0-9]{48}$/); assert.match(start.challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(start.verifier, undefined);
  assert.throws(() => flows.begin({}, 1001), { httpStatus: 503 });
  assert.throws(() => flows.take(start.state, '00'.repeat(24), 1001), { code: 'deriv-auth-invalid-state' });
  const consumed = flows.take(start.state, start.state, 1002);
  assert.equal(consumed.linkUserId, 'bound-user');
  assert.equal(crypto.createHash('sha256').update(consumed.verifier).digest('base64url'), start.challenge);
  assert.throws(() => flows.take(start.state, start.state, 1003), { code: 'deriv-auth-invalid-state' });
  const next = flows.begin({}, 1100);
  assert.throws(() => flows.take(next.state, next.state, 1200), { code: 'deriv-auth-invalid-state' });
});

test('tokens are AES-GCM encrypted with random nonces without mutating runtime credentials', () => {
  const u = owned(user()); u.deriv.token = TOKEN;
  const first = C.encodeDb(I.db), second = C.encodeDb(I.db);
  assert.equal(I.db.users[0].deriv.token, TOKEN);
  assert.equal(JSON.stringify(first).includes(TOKEN), false);
  assert.equal(first.users[0].deriv.token.format, 'aes-256-gcm');
  assert.notEqual(first.users[0].deriv.token.iv, second.users[0].deriv.token.iv);
  assert.equal(C.decodeDb(first).users[0].deriv.token, TOKEN);
  const rebound = structuredClone(first); rebound.users[0].id = 'different-owner';
  assert.throws(() => C.decodeDb(rebound), /deriv-token-decryption-failed/);
  first.users[0].deriv.token.tag = 'AA'.repeat(16);
  assert.throws(() => C.decodeDb(first), /deriv-token-decryption-failed/);
});

test('wrong or missing storage keys fail closed; both hexadecimal and base64 keys work', () => {
  owned(user()).deriv.token = TOKEN;
  const sealed = C.encodeDb(I.db);
  process.env.DERIV_TOKEN_ENCRYPTION_KEY = '22'.repeat(32);
  assert.throws(() => C.decodeDb(sealed), /deriv-token-decryption-failed/);
  delete process.env.DERIV_TOKEN_ENCRYPTION_KEY;
  assert.throws(() => C.decodeDb(sealed), /deriv-token-storage-key-required/);
  process.env.NODE_ENV = 'production';
  assert.equal(C.ready(), false);
  assert.throws(() => C.encodeDb(I.db), /deriv-token-storage-key-required/);
  process.env.DERIV_TOKEN_ENCRYPTION_KEY = Buffer.from(key, 'hex').toString('base64');
  assert.equal(C.decodeDb(sealed).users[0].deriv.token, TOKEN);
  process.env.DERIV_TOKEN_ENCRYPTION_KEY = 'not-a-key';
  assert.equal(C.ready(), false); assert.equal(C.mode(), 'invalid-key');
});

test('PAT sign-in creates a client session without an email/password or any order calls', async () => {
  const result = await pat();
  assert.equal(result.status, 200); assert.equal(result.data.user.role, 'user');
  assert.equal(result.data.user.deriv.loginid, demo.account_id);
  assert.equal(result.data.user.deriv.isVirtual, true);
  assert.equal(result.data.user.deriv.balance, 10000);
  assert.equal(result.data.bot.live, false); assert.equal(result.data.bot.running, false);
  assert.ok(cookieFrom(result, 'sid')); assert.match(result.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(result.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(result.text.includes(TOKEN), false);
  assert.equal(calls.length, 1); assert.equal(calls[0].options.headers['Deriv-App-ID'], 'fixture-registered-app');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer ' + TOKEN);
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  const stored = fs.readFileSync(dbPath, 'utf8'); assert.equal(stored.includes(TOKEN), false);
  assert.equal(JSON.parse(stored).users[0].deriv.token.format, 'aes-256-gcm');
  if (process.platform !== 'win32') assert.equal(fs.statSync(dbPath).mode & 0o777, 0o600);
  const session = cookieFrom(result, 'sid');
  app.loadDb(); assert.equal(I.db.users[0].deriv.token, TOKEN);
  assert.equal((await request('/api/auth/me', { cookie: session })).data.user.id, result.data.user.id);
});

test('production auth cookies are Secure and a replacement PAT returns to the same workspace', async () => {
  process.env.NODE_ENV = 'production'; process.env.PUBLIC_URL = 'https://r-h-pilot-3.onrender.com';
  const first = await pat(undefined, { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.equal(first.status, 200); assert.match(first.headers.get('set-cookie'), /; Secure/);
  const second = await pat({ token: 'fixture-replacement-token' }, { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.equal(second.status, 200); assert.equal(second.data.user.id, first.data.user.id);
  assert.equal(I.db.users.length, 1); assert.equal(I.db.users[0].deriv.token, 'fixture-replacement-token');
});

test('PAT identity matches all broker-confirmed account IDs, not just the default demo', async () => {
  const existing = owned(user('existing'), real.account_id);
  const result = await pat();
  assert.equal(result.status, 200); assert.equal(result.data.user.id, existing.id);
  assert.equal(I.db.users.length, 1); assert.equal(result.data.user.deriv.loginid, demo.account_id);
});

test('unverified email input can never attach a broker token to an admin workspace', async () => {
  const admin = user('owner', 'admin');
  accounts[0].email = admin.email;
  const result = await pat({ token: TOKEN, email: admin.email, role: 'admin', isVirtual: false });
  assert.equal(result.status, 200); assert.notEqual(result.data.user.id, admin.id);
  assert.equal(result.data.user.role, 'user'); assert.equal(admin.deriv, null);
  assert.equal(result.data.user.deriv.isVirtual, true);
});

test('multi-workspace broker ownership conflicts cannot merge accounts or change credentials', async () => {
  const first = owned(user('first')), second = owned(user('second'), real.account_id);
  const result = await pat();
  assert.equal(result.status, 409); assert.equal(result.data.error, 'deriv-auth-account-conflict');
  assert.equal(first.deriv.token, 'fixture-previous-token'); assert.equal(second.deriv.token, 'fixture-previous-token');
  assert.equal(Object.keys(I.db.sessions).length, 0);
});

test('wallet token linking cannot steal an account already owned by another client', async () => {
  const owner = owned(user('owner')), claimant = user('claimant');
  const result = await request('/api/deriv/link', { method: 'POST', body: { token: TOKEN }, cookie: sid(claimant) });
  assert.equal(result.status, 409); assert.equal(result.data.error, 'deriv-account-already-linked');
  assert.equal(claimant.deriv, null); assert.equal(owner.deriv.token, 'fixture-previous-token');
});

test('disabled identities and unresolved broker records block PAT account replacement', async () => {
  const u = owned(user()); u.active = false;
  assert.equal((await pat()).data.error, 'account-disabled');
  u.active = true; u.bot.positions = [{ id: 'uncertain', contractId: 'fixture-contract', reconciliationRequired: true }];
  const result = await pat();
  assert.equal(result.status, 409); assert.equal(result.data.error, 'broker-reconciliation-required');
  assert.equal(u.deriv.token, 'fixture-previous-token'); assert.equal(u.bot.positions[0].contractId, 'fixture-contract');
  assert.equal(Object.keys(I.db.sessions).length, 0);
});

test('PAT sign-in honours licensing without creating orphan users on rejected keys', async () => {
  I.db.config.licenseRequired = true;
  const missing = await pat(); assert.equal(missing.status, 403); assert.equal(missing.data.error, 'license-required');
  assert.equal(I.db.users.length, 0);
  I.db.config.licenses.push({ key: 'RHP-FIXTURE-ONLY', status: 'unused', plan: 'days30', boundUserId: null });
  const accepted = await pat(undefined, { cookie: 'lic=RHP-FIXTURE-ONLY' });
  assert.equal(accepted.status, 200); assert.equal(accepted.data.user.paid, true);
  assert.equal(I.db.config.licenses[0].boundUserId, accepted.data.user.id);
  accounts = [{ ...demo, account_id: 'VRTC-other-fixture' }];
  const different = await pat(undefined, { cookie: 'lic=RHP-FIXTURE-ONLY' });
  assert.equal(different.status, 409); assert.equal(different.data.error, 'license-bound');
  assert.equal(I.db.users.length, 1);
});

test('broker rejection, timeout and reflected secrets are never exposed through auth or public config', async () => {
  for (const status of [401, 403, 500]) {
    global.fetch = async () => response({ error: { message: TOKEN + ' https://invalid.test/?otp=fixture-secret' } }, status);
    const result = await pat(); assert.equal(result.status, status === 500 ? 502 : status);
    assert.equal(result.text.includes(TOKEN), false); assert.equal(result.text.includes('fixture-secret'), false);
    const pub = await request('/api/config/public'); assert.equal(pub.text.includes(TOKEN), false);
  }
  global.fetch = async () => { throw new Error('timeout-with-' + TOKEN); };
  const timed = await pat(); assert.equal(timed.status, 502); assert.equal(timed.text.includes(TOKEN), false);
  assert.equal(I.db.users.length, 0); assert.equal(Object.keys(I.db.sessions).length, 0);
});

test('malformed, query-string, cross-origin and non-JSON PAT attempts never reach Deriv', async () => {
  const invalid = [await pat({ token: { nested: TOKEN } }), await pat({ token: 'bad token' }),
    await pat({ token: TOKEN }, { headers: { Origin: 'https://untrusted.example.test' } }),
    await pat({ token: TOKEN }, { headers: { 'Content-Type': 'text/plain' } }),
    await request('/api/auth/deriv/pat?token=fixture-not-real', { method: 'POST', body: { token: TOKEN } })];
  assert.deepEqual(invalid.map(x => x.status), [400, 400, 403, 400, 400]);
  assert.equal(calls.length, 0); assert.equal(I.db.users.length, 0);
});

test('production PAT sign-in refuses insecure transport or missing encryption configuration', async () => {
  process.env.NODE_ENV = 'production'; process.env.PUBLIC_URL = 'https://r-h-pilot-3.onrender.com';
  assert.equal((await pat()).data.error, 'deriv-auth-https-required');
  delete process.env.DERIV_TOKEN_ENCRYPTION_KEY;
  const result = await pat(undefined, { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.equal(result.status, 503); assert.equal(result.data.error, 'deriv-token-storage-key-required');
  const pub = (await request('/api/config/public')).data.derivConnection;
  assert.equal(pub.patEnabled, false); assert.equal(pub.oauthEnabled, false); assert.equal(pub.credentialStorage, 'unconfigured');
  assert.equal(calls.length, 0);
});

test('only exact active account IDs and broker-confirmed demo/real types are accepted', async () => {
  accounts = [{ ...real, account_id: 'CR-first' }, { ...real, account_id: 'CR-second' }];
  assert.equal((await pat()).data.error, 'deriv-account-selection-required');
  assert.equal((await pat({ token: TOKEN, accountId: 'CR-missing' })).data.error, 'deriv-requested-account-unavailable');
  const selected = await pat({ token: TOKEN, accountId: 'CR-second', isVirtual: true });
  assert.equal(selected.status, 200); assert.equal(selected.data.user.deriv.loginid, 'CR-second');
  assert.equal(selected.data.user.deriv.isVirtual, false); assert.equal(selected.data.bot.live, false);
  accounts = [{ ...demo, account_type: 'unknown' }];
  assert.equal((await pat()).data.error, 'deriv-invalid-account-response');
});

test('unknown broker balances remain unknown rather than turning into fabricated zero balances', async () => {
  accounts = [{ ...demo, balance: null }];
  const result = await pat(); assert.equal(result.status, 200);
  assert.equal(result.data.user.deriv.balance, null); assert.equal(result.data.user.deriv.accounts[0].balance, null);
});

test('a failed durable auth commit issues no session and rolls back account/license mutations', async () => {
  const u = owned(user()); const previous = u.deriv.token;
  I.db.config.licenseRequired = true;
  I.db.config.licenses.push({ key: 'RHP-FIXTURE-ONLY', status: 'unused', plan: 'days30' });
  const original = fs.fsyncSync; fs.fsyncSync = () => { throw new Error('fixture-sync-failure'); };
  let result;
  try { result = await pat(undefined, { cookie: 'lic=RHP-FIXTURE-ONLY' }); }
  finally { fs.fsyncSync = original; }
  assert.equal(result.status, 503); assert.equal(result.data.error, 'risk-state-unavailable');
  assert.equal(cookieFrom(result, 'sid'), null); assert.equal(Object.keys(I.db.sessions).length, 0);
  assert.equal(I.db.users[0].deriv.token, previous);
  assert.equal(I.db.config.licenses[0].boundUserId, undefined);
  assert.equal((await request('/api/health')).status, 503);
});

test('database restart refuses a wrong encryption key instead of overwriting the credential store', async () => {
  await pat(); const before = fs.readFileSync(dbPath, 'utf8');
  process.env.DERIV_TOKEN_ENCRYPTION_KEY = '22'.repeat(32);
  assert.throws(() => app.loadDb(), /Refusing to reset.*deriv-token-decryption-failed/);
  assert.equal(fs.readFileSync(dbPath, 'utf8'), before);
  process.env.DERIV_TOKEN_ENCRYPTION_KEY = key;
  app.loadDb(); assert.equal(I.db.users[0].deriv.token, TOKEN);
});

test('all snapshot paths use encrypted broker credentials, including downloaded backups', async () => {
  const u = owned(user('admin', 'admin')); u.deriv.token = TOKEN;
  const snapshot = I.snapshot(); assert.equal(JSON.stringify(snapshot).includes(TOKEN), false);
  assert.equal(C.decodeDb(snapshot.data).users[0].deriv.token, TOKEN);
  const session = sid(u);
  const downloaded = await request('/api/admin/backup/download', { cookie: session });
  assert.equal(downloaded.status, 200); assert.equal(downloaded.text.includes(TOKEN), false);
  const written = await request('/api/admin/backup', { method: 'POST', body: {}, cookie: session });
  assert.equal(written.status, 200);
  const file = fs.readFileSync(path.join(dir, 'backups', written.data.backup.id), 'utf8');
  assert.equal(file.includes(TOKEN), false);
});

test('OAuth uses canonical callback and S256 with no verifier/link-target credential cookies', async () => {
  process.env.PUBLIC_URL = 'https://r-h-pilot-3.onrender.com';
  const flow = await begin();
  assert.equal(flow.url.searchParams.get('redirect_uri'), 'https://r-h-pilot-3.onrender.com/api/auth/deriv/callback');
  assert.equal(flow.url.searchParams.get('client_id'), 'fixture-registered-app');
  assert.equal(flow.url.searchParams.get('code_challenge_method'), 'S256');
  assert.match(flow.url.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(flow.url.searchParams.get('scope'), 'trade');
  const cookies = flow.result.headers.getSetCookie();
  assert.ok(cookies.filter(c => !c.includes('Max-Age=0')).every(c => c.startsWith('derivstate=')));
  assert.equal(flow.result.text.includes(TOKEN), false);
});

test('OAuth callback ignores forged forwarded hosts and succeeds with the original PKCE verifier', async () => {
  process.env.PUBLIC_URL = 'https://r-h-pilot-3.onrender.com';
  const start = await request('/api/auth/deriv/start', { headers: { 'X-Forwarded-Host': 'attacker.example.test', 'X-Forwarded-Proto': 'http' } });
  const url = new URL(start.headers.get('location')), state = url.searchParams.get('state');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://r-h-pilot-3.onrender.com/api/auth/deriv/callback');
  const verifier = I.oauthFlows.pending.get(state).verifier;
  const result = await callback({ state }, cookieFrom(start, 'derivstate'));
  assert.equal(result.headers.get('location'), '/?deriv=linked'); assert.ok(cookieFrom(result, 'sid'));
  const exchange = calls.find(c => c.url.endsWith('/oauth2/token')), params = new URLSearchParams(exchange.options.body);
  assert.equal(params.get('code_verifier'), verifier);
  assert.equal(params.get('redirect_uri'), 'https://r-h-pilot-3.onrender.com/api/auth/deriv/callback');
  assert.equal(exchange.options.redirect, 'error'); assert.ok(exchange.options.signal instanceof AbortSignal);
  assert.equal(I.db.users[0].deriv.via, 'oauth'); assert.ok(I.db.users[0].deriv.expiresAt > Date.now());
  assert.equal(I.db.users[0].bot.live, false);
});

test('OAuth callbacks cannot be replayed and require the initiating browser state cookie', async () => {
  const flow = await begin();
  const missing = await callback(flow, '');
  assert.equal(missing.headers.get('location'), '/?deriv=deriv-auth-invalid-state'); assert.equal(calls.length, 0);
  assert.equal((await callback(flow)).headers.get('location'), '/?deriv=linked');
  const count = calls.length;
  assert.equal((await callback(flow)).headers.get('location'), '/?deriv=deriv-auth-invalid-state');
  assert.equal(calls.length, count); assert.equal(I.db.users.length, 1);
});

test('OAuth state expires and an App ID change invalidates the outstanding flow', async () => {
  const old = await begin(); I.oauthFlows.pending.get(old.state).expiresAt = Date.now() - 1;
  assert.equal((await callback(old)).headers.get('location'), '/?deriv=deriv-auth-invalid-state');
  const changed = await begin(); I.db.config.derivAppId = 'different-fixture-app';
  assert.equal((await callback(changed)).headers.get('location'), '/?deriv=deriv-auth-invalid-state');
  assert.equal(calls.length, 0); assert.equal(I.db.users.length, 0);
});

test('expired or changed workspace session cannot turn OAuth linking into an unintended login', async () => {
  const u = user('link-owner'), session = sid(u), flow = await begin(session, true);
  delete I.db.sessions[session.slice(4)];
  const result = await callback(flow, session + '; ' + flow.cookie);
  assert.equal(result.headers.get('location'), '/?deriv=deriv-link-session-expired');
  assert.equal(cookieFrom(result, 'sid'), null); assert.equal(calls.length, 0); assert.equal(u.deriv, null);
});

test('OAuth rechecks the session after async account verification before committing a link', async () => {
  const owner = user('owner'), other = user('other'), session = sid(owner), flow = await begin(session, true);
  const original = global.fetch;
  global.fetch = async (url, options) => {
    const result = await original(url, options);
    if (String(url).endsWith('/accounts')) I.db.sessions[session.slice(4)].userId = other.id;
    return result;
  };
  const result = await callback(flow, session + '; ' + flow.cookie);
  assert.equal(result.headers.get('location'), '/?deriv=deriv-link-session-expired');
  assert.equal(owner.deriv, null); assert.equal(other.deriv, null);
});

test('denied OAuth consumes state and never reflects provider error descriptions', async () => {
  const flow = await begin();
  const result = await callback(flow, flow.cookie, '&error=access_denied&error_description=fixture-sensitive-description');
  assert.equal(result.headers.get('location'), '/?deriv=deriv-oauth-failed');
  assert.equal(result.headers.get('location').includes('fixture-sensitive-description'), false);
  assert.equal(I.oauthFlows.pending.size, 0); assert.equal(calls.length, 0);
});

test('production OAuth refuses a missing canonical origin or invalid credential storage', async () => {
  process.env.NODE_ENV = 'production';
  const missing = await request('/api/auth/deriv/start');
  assert.equal(missing.headers.get('location'), '/?deriv=deriv-oauth-origin-required');
  process.env.PUBLIC_URL = 'http://insecure.example.test';
  assert.equal((await request('/api/auth/deriv/start')).headers.get('location'), '/?deriv=deriv-oauth-origin-required');
  process.env.PUBLIC_URL = 'https://r-h-pilot-3.onrender.com';
  delete process.env.DERIV_TOKEN_ENCRYPTION_KEY;
  assert.equal((await request('/api/auth/deriv/start')).headers.get('location'), '/?deriv=deriv-token-storage-key-required');
  assert.equal(I.oauthFlows.pending.size, 0);
});

test('unconfigured/sample/PAT-like App IDs are never published as usable credentials', async () => {
  for (const appId of ['', '1089', 'pat_fixture-never-real']) {
    I.db.config.derivAppId = appId;
    const pub = await request('/api/config/public');
    assert.equal(pub.data.derivAppId, ''); assert.equal(pub.data.derivConnection.patEnabled, false);
    const result = await pat(); assert.equal(result.status, 503); assert.equal(calls.length, 0);
  }
});

test('admin App ID validation rejects secrets/objects before mutation and permits explicit disable', async () => {
  const admin = user('admin', 'admin'), cookie = sid(admin), before = I.db.config.derivAppId;
  for (const derivAppId of ['pat_fixture-not-real', '1089', 'bad app id', {}, null]) {
    const result = await request('/api/admin/config', { method: 'PUT', body: { derivAppId }, cookie });
    assert.equal(result.status, 400); assert.equal(I.db.config.derivAppId, before);
  }
  const disabled = await request('/api/admin/config', { method: 'PUT', body: { derivAppId: '' }, cookie });
  assert.equal(disabled.status, 200); assert.equal(I.db.config.derivAppId, '');
});

test('PAT and OAuth attempts are rate-limited without asking the broker thirteen times', async () => {
  for (let i = 0; i < 12; i++) assert.equal((await pat({ token: {} })).status, 400);
  assert.equal((await pat()).status, 429); assert.equal(calls.length, 0);
  assert.equal((await request('/api/auth/deriv/start')).headers.get('location'), '/?deriv=too-many-attempts');
});

test('login and wallet forms clear token inputs on failure without browser storage', async () => {
  const code = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const start = code.indexOf("$('#deriv-pat-login-form').onsubmit ="), end = code.indexOf("$('#deriv-signin').onclick", start);
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', classList: { add() {} } });
    return nodes.get(id);
  };
  node('#auth-deriv-token').value = TOKEN;
  const posted = [], errors = [];
  const context = { $: node, api: async (route, opts) => { posted.push({ route, body: opts.body }); throw new Error('fixture-denial'); },
    showError: (_, message) => errors.push(message), setBusy() {}, showApp() { throw new Error('must-not-login'); }, toast() {} };
  vm.runInNewContext(code.slice(start, end), context);
  await node('#deriv-pat-login-form').onsubmit({ preventDefault() {} });
  assert.equal(node('#auth-deriv-token').value, ''); assert.equal(posted[0].route, '/api/auth/deriv/pat');
  assert.equal(posted[0].body.token, TOKEN); assert.deepEqual(errors, ['fixture-denial']);
  assert.equal(/localStorage|sessionStorage/.test(code.slice(start, end)), false);
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.match(html, /id="auth-deriv-token"[^>]+type="password"[^>]+autocomplete="off"/);
  assert.match(html, /id="deriv-pat-login-error"[^>]+role="alert"/);
});

test('OAuth linking succeeds only for its initiating session and does not replace that session', async () => {
  const u = user('wallet-owner'), session = sid(u), flow = await begin(session, true);
  const result = await callback(flow, session + '; ' + flow.cookie);
  assert.equal(result.headers.get('location'), '/?deriv=linked');
  assert.equal(cookieFrom(result, 'sid'), null); assert.equal(I.db.users.length, 1);
  assert.equal(u.deriv.loginid, demo.account_id); assert.equal(u.deriv.via, 'oauth');
  assert.equal(Object.keys(I.db.sessions).length, 1); assert.equal(u.bot.live, false);
});

test('a new session for the same user cannot redeem an older OAuth linking transaction', async () => {
  const u = user('wallet-owner'), previous = sid(u), flow = await begin(previous, true);
  delete I.db.sessions[previous.slice(4)]; const replacement = sid(u);
  const result = await callback(flow, replacement + '; ' + flow.cookie);
  assert.equal(result.headers.get('location'), '/?deriv=deriv-link-session-expired');
  assert.equal(calls.length, 0); assert.equal(u.deriv, null);
});

test('returning broker clients may use their already-bound valid license without a browser license cookie', async () => {
  I.db.config.licenseRequired = true;
  const u = owned(user('returning'));
  u.paid = true; u.licenseKey = 'RHP-FIXTURE-ONLY';
  I.db.config.licenses.push({ key: u.licenseKey, status: 'active', plan: 'days30',
    boundUserId: u.id, expiresAt: Date.now() + 60000 });
  const result = await pat(); assert.equal(result.status, 200); assert.equal(result.data.user.id, u.id);
  I.db.config.licenses[0].status = 'revoked';
  assert.equal((await pat()).data.error, 'license-revoked');
});

test('encrypted snapshot restore decrypts server-side and keeps newer risk/account safeguards', async () => {
  const u = owned(user('admin', 'admin')); u.deriv.token = TOKEN;
  I.publicBot(u.bot); const cookie = sid(u), snapshot = I.snapshot();
  const result = await request('/api/admin/backup/restore', { method: 'POST', body: { snapshot }, cookie });
  assert.equal(result.status, 200); assert.equal(I.db.users[0].deriv.token, TOKEN);
  assert.equal(fs.readFileSync(dbPath, 'utf8').includes(TOKEN), false);
  const before = I.db.users[0].id; snapshot.data.users[0].id = 'forged-identity';
  const invalid = await request('/api/admin/backup/restore', { method: 'POST', body: { snapshot }, cookie });
  assert.equal(invalid.status, 400); assert.equal(I.db.users[0].id, before);
});

test('trusted-proxy rate limiting uses the nearest appended address, never an untrusted first address', () => {
  const req = value => ({ headers: { 'x-forwarded-for': value }, socket: { remoteAddress: '127.0.0.1' } });
  assert.equal(I.connectionRateLimit(req('198.51.100.1')), true);
  assert.equal(I.connectionRateLimit(req('198.51.100.2')), true);
  assert.deepEqual([...I.connectionAttempts.keys()], ['127.0.0.1']);
  I.connectionAttempts.clear(); process.env.TRUST_PROXY = '1';
  I.connectionRateLimit(req('192.0.2.100, 198.51.100.1'));
  I.connectionRateLimit(req('192.0.2.101, 198.51.100.1'));
  assert.deepEqual([...I.connectionAttempts.keys()], ['198.51.100.1']);
  assert.equal(I.connectionAttempts.get('198.51.100.1').count, 2);
});

test('production keeps clickjacking protection and Secure OAuth cookies even if preview mode is set', async () => {
  process.env.ARENA_PREVIEW = '1'; process.env.NODE_ENV = 'production';
  process.env.PUBLIC_URL = 'https://r-h-pilot-3.onrender.com';
  const health = await request('/api/health'); assert.equal(health.headers.get('x-frame-options'), 'SAMEORIGIN');
  const flow = await request('/api/auth/deriv/start', { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.match(flow.headers.getSetCookie().find(c => c.startsWith('derivstate=')), /; Secure/);
  assert.equal((await request('/api/auth/deriv/start')).headers.get('location'), '/?deriv=deriv-auth-https-required');
});

function history(epoch, overrides = {}) {
  const n = I.ENGINE.WARMUP + 12;
  return { msg_type: 'history', echo_req: { ticks_history: 'R_10' }, history: {
    prices: Array.from({ length: n }, (_, i) => 99 + i * 0.01),
    times: Array.from({ length: n }, (_, i) => epoch - n + i), ...overrides } };
}
test('history received before a live packet only stages indicators and never creates a live quote', () => {
  I.initMarket(); const before = structuredClone(I.market.VOL10), epoch = Math.floor(Date.now() / 1000);
  assert.equal(I.seedDerivHistory(history(epoch)), true);
  assert.deepEqual(I.market.VOL10, before); assert.ok(I.pendingLiveHistory.VOL10);
  assert.equal(I.tickTelemetry.count, 0);
  const sequence = I.ENGINE.WARMUP + 10;
  assert.equal(I.ingestDerivTick({ symbol: 'R_10', quote: 100, epoch }), true);
  assert.equal(I.market.VOL10.source, 'live'); assert.equal(I.market.VOL10.price, 100);
  assert.equal(I.hist.VOL10.at(-1), 100); assert.ok(I.hist.VOL10.length >= I.ENGINE.WARMUP + 1);
  assert.equal(I.market.VOL10.seq, sequence + 1); assert.equal(I.liveObservations.VOL10.length, 1);
  assert.equal(I.tickTelemetry.count, 1); assert.equal(I.pendingLiveHistory.VOL10, undefined);
});

test('late broker history warms indicators without rewinding prices, sequences or executing exits', () => {
  I.initMarket(); const u = user('history-bot', 'admin'), b = u.bot;
  b.symbol = 'VOL10'; b.running = true;
  const epoch = Math.floor(Date.now() / 1000); I.ingestDerivTick({ symbol: 'R_10', quote: 100, epoch });
  b.running = false;
  b.positions = [{ ...P.paperPosition({ dir: 1, atr: 1, tpDist: 6, slDist: 2, hold: 50, be: 0.99 }, 100),
    strategy: 'breakout-momentum', id: 'history-position', marketSource: 'live', lots: 0.00005 }];
  const quote = structuredClone(I.market.VOL10), identity = b.lastProcessedTick;
  const msg = history(epoch + 1); msg.history.prices[msg.history.prices.length - 1] = 500;
  assert.equal(I.seedDerivHistory(msg), true);
  assert.deepEqual(I.market.VOL10, quote); assert.equal(I.hist.VOL10.at(-1), 100);
  assert.equal(I.hist.VOL10.includes(500), false, 'overlapping history cannot introduce a later unobserved quote');
  assert.equal(b.lastProcessedTick, identity); assert.equal(b.positions[0].ticks, 0);
  I.engineLoop(); assert.equal(b.positions[0].ticks, 0);
  I.ingestDerivTick({ symbol: 'R_10', quote: 100, epoch });
  assert.equal(b.positions[0].ticks, 1); assert.equal(I.tickTelemetry.count, 2);
});

test('stale, future, misaligned or malformed broker history cannot be relabelled as fresh data', () => {
  I.initMarket(); const before = structuredClone(I.market.VOL10), epoch = Math.floor(Date.now() / 1000);
  const bad = [history(epoch - 20), history(epoch + 20), history(epoch, { times: [epoch] })];
  const invalidPrice = history(epoch); invalidPrice.history.prices[0] = '100-invalid'; bad.push(invalidPrice);
  const reversed = history(epoch); reversed.history.times[2] = reversed.history.times[0] - 1; bad.push(reversed);
  for (const msg of bad) assert.equal(I.seedDerivHistory(msg), false);
  assert.deepEqual(I.market.VOL10, before); assert.equal(I.pendingLiveHistory.VOL10, undefined);
  assert.equal(I.tickTelemetry.count, 0);
});

test('public-tick latency samples and per-symbol live observations remain bounded', () => {
  I.initMarket(); const epoch = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 300; i++) assert.equal(I.ingestDerivTick({ symbol: 'R_10', quote: 100 + i / 100, epoch }), true);
  assert.equal(I.tickTelemetry.count, 300); assert.equal(I.tickTelemetry.samples.length, 256);
  assert.equal(I.liveObservations.VOL10.length, 180); assert.equal(I.hist.VOL10.length, 180);
  assert.equal(I.marketTickTelemetry().sampleCount, 256);
});

test('actual public-WebSocket live producer evaluates fresh ticks immediately without timers', async () => {
  class PublicSocket {
    static latest;
    constructor() { PublicSocket.latest = this; this.frames = []; }
    send(frame) { this.frames.push(JSON.parse(frame)); }
    close() {}
    emit(data) { this.onmessage({ data: JSON.stringify(data) }); }
  }
  global.WebSocket = PublicSocket; I.initMarket();
  const u = user('tick-bot', 'admin'), b = u.bot;
  b.running = true; b.symbol = 'VOL10'; b.spreadAtr = 0; b.slippageAtr = 0;
  I.hist.VOL10 = [];
  I.connectDeriv(); const socket = PublicSocket.latest;
  assert.ok(socket); socket.onopen();
  socket.emit({ msg_type: 'active_symbols', active_symbols: [{ underlying_symbol: 'R_10' }] });
  assert.ok(socket.frames.some(f => f.ticks === 'R_10' && f.subscribe === 1));
  const epoch = Math.floor(Date.now() / 1000), emit = (quote = 100, time = epoch) => socket.emit({ msg_type: 'tick', tick: { symbol: 'R_10', quote, epoch: time } });
  emit();
  assert.equal(I.market.VOL10.source, 'live'); assert.equal(I.freshMarketQuote(I.market.VOL10), true);
  assert.match(b.lastProcessedTick, /^live:/); assert.equal(I.hist.VOL10.length, 1);
  const sig = { strategy: 'breakout-momentum', dir: 1, confidence: 0.9, atr: 1, tpDist: 6, slDist: 2, hold: 50, be: 0.99 };
  b.positions = [{ ...P.paperPosition(sig, 100, { spreadAtr: 0, slippageAtr: 0 }), id: 'wire-position',
    at: Date.now(), marketSource: 'live', lots: 0.00005 }];
  const seen = b.lastProcessedTick;
  emit(); // unchanged price/second is still a NEW received broker observation
  assert.notEqual(b.lastProcessedTick, seen); assert.equal(b.positions[0].ticks, 1);
  I.engineLoop(); I.pricePump();
  assert.equal(b.positions[0].ticks, 1, 'timer evaluation must not consume the same tick again');
  const current = I.market.VOL10.seq, identity = b.lastProcessedTick;
  emit('100-invalid'); emit(100, epoch - 20); emit(100, epoch + 20); emit(100, epoch - 1);
  assert.equal(I.market.VOL10.seq, current, 'bad, stale, future and out-of-order packets must not advance history');
  const q = I.market.VOL10;
  assert.equal(I.freshMarketQuote(I.market.VOL10, q.providerAt + 8001), false, 'provider time cannot acquire another freshness window at receipt');
  assert.equal(I.freshMarketQuote(I.market.VOL10, q.at - 1), false, 'future receipt timestamps remain invalid');
  assert.equal(b.lastProcessedTick, identity); assert.equal(b.live, false);
  const metrics = (await request('/api/health')).data.marketTickProcessing;
  assert.equal(metrics.acceptedTicks, 2); assert.equal(metrics.sampleCount, 2);
  assert.ok(Number.isFinite(metrics.meanMs)); assert.match(metrics.scope, /excludes network and broker order\/fill/);
  assert.equal(calls.length, 0, 'live market ticks may evaluate paper positions, never buy real contracts');
});


test('superseded public sockets cannot overwrite the current live feed or trigger reconnect state', async () => {
  class Socket {
    static all = [];
    constructor() { Socket.all.push(this); }
    send() {}
    close() { if (this.onclose) this.onclose(); }
    emit(data) { this.onmessage({ data: JSON.stringify(data) }); }
  }
  global.WebSocket = Socket; I.initMarket();
  I.connectDeriv(); const old = Socket.all.at(-1); old.onopen();
  I.connectDeriv(); const active = Socket.all.at(-1); active.onopen();
  const epoch = Math.floor(Date.now() / 1000);
  active.emit({ msg_type: 'tick', tick: { symbol: 'R_10', quote: 100, epoch } });
  old.emit({ msg_type: 'tick', tick: { symbol: 'R_10', quote: 9000, epoch } });
  old.emit({ error: { message: TOKEN } }); old.onclose();
  assert.equal(I.market.VOL10.price, 100); assert.equal(I.tickTelemetry.count, 1);
  const health = await request('/api/health'); assert.equal(health.data.deriv.status, 'live');
  assert.equal(health.text.includes(TOKEN), false);
});
