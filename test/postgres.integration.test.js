'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StateStore } = require('../engine/state-store.js');
// CI supplies a disposable, job-local PostgreSQL service. Never use production.
const url = process.env.TEST_DATABASE_URL;
const namespace = 'test_' + crypto.randomBytes(8).toString('hex');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhp-real-postgres-'));
let app, I, sql, base;
const request = async (route, options = {}) => {
  const response = await fetch(base + route, { ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  return { status: response.status, headers: response.headers, data: await response.json() };
};

test('actual PostgreSQL: session durability, process restart and exclusive writer', { skip: !url }, async () => {
  process.env.DATA_DIR = dir; process.env.DATABASE_URL = url; process.env.STATE_NAMESPACE = namespace;
  process.env.INITIALIZE_EMPTY_DATABASE = '1'; process.env.NODE_ENV = 'test';
  process.env.ADMIN_EMAIL = 'owner@fixture.test'; process.env.ADMIN_PASSWORD = 'Fixture-owner-only-password';
  process.env.DERIV_TOKEN_ENCRYPTION_KEY = '44'.repeat(32); process.env.DERIV_WS_URL = 'ws://127.0.0.1:1';
  const { Client } = require('pg'); sql = new Client({ connectionString: url }); await sql.connect();
  app = require('../server.js'); I = app._internals;
  const server = await app.start({ port: 0, host: '127.0.0.1' }); base = 'http://127.0.0.1:' + server.address().port;
  const login = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'owner@fixture.test', password: 'Fixture-owner-only-password' }) });
  assert.equal(login.status, 200); const id = login.data.user.id;
  const cookie = login.headers.getSetCookie().find(s => s.startsWith('sid=')).split(';')[0];
  const paired = await request('/api/mt5/pair', { method: 'POST', headers: { Cookie: cookie },
    body: JSON.stringify({ login: '1234567', server: 'Deriv-Demo', symbol: 'XAUUSD' }) });
  assert.equal(paired.status, 200);
  I.db.users[0].deriv = { token: 'fixture-private-pat-not-real', loginid: 'VRTC-fixture' };
  await I.persistDb();
  let row = (await sql.query('SELECT payload, revision FROM rh_pilot_state WHERE id=$1', [namespace])).rows[0];
  assert.equal(JSON.stringify(row.payload).includes('fixture-private-pat-not-real'), false);
  assert.equal(row.payload.users[0].deriv.token.format, 'aes-256-gcm');
  assert.ok(row.payload.sessions[cookie.slice(4)]);
  assert.equal(fs.existsSync(path.join(dir, 'db.json')), false, 'Postgres mode creates no ephemeral credential cache');
  const competitor = new StateStore({ connectionString: url, namespace });
  await assert.rejects(competitor.open(), /state-writer-already-active/);
  await app.stop(); fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.INITIALIZE_EMPTY_DATABASE;
  const restarted = await app.start({ port: 0, host: '127.0.0.1' }); base = 'http://127.0.0.1:' + restarted.address().port;
  const me = await request('/api/auth/me', { headers: { Cookie: cookie } });
  assert.equal(me.status, 200); assert.equal(me.data.user.id, id);
  assert.equal(me.data.user.mt5.login, '1234567'); assert.equal(me.data.user.mt5.mode, 'monitor');
  assert.equal(I.db.users[0].deriv.token, 'fixture-private-pat-not-real');
  assert.equal((await request('/api/health')).data.storage.durable, true);
  // Simulate a competing/admin revision change: no overwrite and no new login.
  await sql.query('UPDATE rh_pilot_state SET revision=revision+1 WHERE id=$1', [namespace]);
  const failed = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'owner@fixture.test', password: 'Fixture-owner-only-password' }) });
  assert.equal(failed.status, 503); assert.equal(failed.data.error, 'risk-state-unavailable');
  assert.ok(failed.headers.getSetCookie().every(s => !/^sid=[a-f0-9]{64}/.test(s)));
  assert.equal((await request('/api/health')).status, 503);
});

test.after(async () => {
  if (app) await app.stop();
  if (sql) { await sql.query('DELETE FROM rh_pilot_state WHERE id=$1', [namespace]); await sql.end(); }
  fs.rmSync(dir, { recursive: true, force: true });
});
