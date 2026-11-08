'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { StateStore } = require('../engine/state-store.js');
class FakeClient extends EventEmitter {
  static row = null; static owner = null; static gate = null; static failWrite = false;
  async connect() { this.live = true; }
  async end() { if (FakeClient.owner === this) FakeClient.owner = null; this.live = false; this.emit('end'); }
  async query(sql, params = []) {
    if (sql.includes('pg_try_advisory_lock')) {
      const locked = !FakeClient.owner; if (locked) FakeClient.owner = this;
      return { rows: [{ locked }] };
    }
    if (sql.includes('SELECT revision, CASE')) return { rows: FakeClient.row ? [structuredClone(FakeClient.row)] : [] };
    if (sql.includes('INSERT INTO') || sql.includes('UPDATE rh_pilot_state')) {
      if (FakeClient.gate) await FakeClient.gate;
      if (FakeClient.failWrite) throw new Error('must-never-reflect-a-private-database-url');
      const revision = FakeClient.row?.revision || 0;
      const expected = sql.includes('INSERT INTO') ? 0 : params[2];
      if (revision !== expected || (expected > 0 && !FakeClient.row)) return { rows: [] };
      FakeClient.row = { revision: revision + 1, payload: JSON.parse(params[1]) };
      return { rows: [{ revision: revision + 1 }] };
    }
    return { rows: [] };
  }
}
const create = () => new StateStore({ connectionString: 'postgres://fixture-only-not-a-credential', Client: FakeClient });
test.beforeEach(() => { FakeClient.row = null; FakeClient.owner = null; FakeClient.gate = null; FakeClient.failWrite = false; });

test('PostgreSQL preserves encrypted snapshots and revision across restart without local fallback', async () => {
  const store = create(); assert.equal(await store.open(), null);
  store.enqueue(JSON.stringify({ users: [{ id: 'fixture', token: { format: 'aes-256-gcm' } }] }));
  await store.flush(); assert.equal(store.status().revision, 1); await store.close();
  const next = create(); assert.deepEqual(await next.open(), FakeClient.row.payload);
  assert.equal(next.status().revision, 1); assert.equal(next.status().durable, true); await next.close();
});

test('single-writer locking refuses another process rather than duplicating an execution leader', async () => {
  const first = create(), second = create(); await first.open();
  await assert.rejects(second.open(), /state-writer-already-active/);
  assert.equal(first.status().durable, true); await first.close();
  const replacement = create(); await replacement.open(); await replacement.close();
});

test('a slow database retains only one in-flight and one coalesced snapshot', async () => {
  let release; FakeClient.gate = new Promise(resolve => { release = resolve; });
  const store = create(); await store.open(); store.enqueue('{"n":0}');
  for (let n = 1; n <= 100; n++) store.enqueue(JSON.stringify({ n }));
  assert.equal(store.next, '{"n":100}'); release();
  await store.flush(); assert.deepEqual(FakeClient.row.payload, { n: 100 });
  assert.equal(store.revision, 2); await store.close();
});

test('database failure latches unhealthy, sanitizes errors and cannot grant a queued durable commit', async () => {
  const store = create(); await store.open(); let failure;
  store.on('failure', error => { failure = error; }); FakeClient.failWrite = true;
  store.enqueue('{}'); await assert.rejects(store.flush(), /^Error: durable-state-unavailable$/);
  assert.equal(failure.message, 'durable-state-unavailable'); assert.equal(store.status().healthy, false);
  FakeClient.failWrite = false; assert.throws(() => store.enqueue('{}'), /durable-state-unavailable/);
  assert.equal(FakeClient.row, null); await store.close();
});

test('revision conflicts and disconnected sessions halt instead of silently overwriting newer risk', async () => {
  const store = create(); await store.open(); FakeClient.row = { revision: 5, payload: { newer: true } };
  store.enqueue('{}'); await assert.rejects(store.flush(), /durable-state-unavailable/);
  assert.deepEqual(FakeClient.row.payload, { newer: true }); await store.close();
  const next = create(); await next.open(); next.client.emit('error', new Error('private error'));
  assert.equal(next.status().durable, false); await assert.rejects(next.flush(), /durable-state-unavailable/); await next.close();
});

test('invalid namespaces and oversized snapshots are refused before sending SQL', async () => {
  assert.throws(() => new StateStore({ connectionString: 'fixture', namespace: 'unsafe namespace' }), /configuration/);
  const store = create(); await store.open();
  assert.throws(() => store.enqueue('x'.repeat(8 * 1024 * 1024 + 1)), /state-size-limit/);
  assert.equal(FakeClient.row, null); await store.close();
});


test('remote state connections force verified TLS; local CI PostgreSQL needs no paid provider', () => {
  const remote = new StateStore({ connectionString: 'postgresql://fixture.example/db?sslmode=no-verify', Client: FakeClient });
  assert.equal(new URL(remote.connectionString).searchParams.get('sslmode'), 'verify-full');
  const local = new StateStore({ connectionString: 'postgres://127.0.0.1/testdb', Client: FakeClient });
  assert.equal(new URL(local.connectionString).searchParams.has('sslmode'), false);
  assert.throws(() => new StateStore({ connectionString: 'https://fixture.example/db' }), /configuration/);
});
