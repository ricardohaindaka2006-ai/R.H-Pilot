'use strict';
const { EventEmitter } = require('node:events');
// Optional, operator-supplied PostgreSQL. This module provisions nothing and
// changes no hosting plan. A dedicated session owns a single-writer advisory
// lock; transaction-pooled URLs (e.g. PgBouncer transaction mode) are NOT safe.
class StateStore extends EventEmitter {
  constructor({ connectionString, namespace = 'r-h-pilot', Client, maxBytes = 8 * 1024 * 1024 } = {}) {
    super();
    if (!connectionString || !/^[A-Za-z0-9_-]{1,64}$/.test(namespace)) throw new Error('state-store-configuration-invalid');
    let parsed;
    try { parsed = new URL(connectionString); } catch (error) { throw new Error('state-store-configuration-invalid'); }
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('state-store-configuration-invalid');
    // Remote customer state always uses verified TLS. Local disposable tests
    // may use cleartext loopback; no production password or URL is logged.
    if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) parsed.searchParams.set('sslmode', 'verify-full');
    this.connectionString = parsed.toString(); this.namespace = namespace;
    this.Client = Client || require('pg').Client; this.maxBytes = maxBytes;
    this.client = null; this.revision = 0; this.connected = false; this.failed = false;
    this.next = null; this.active = null; this.lastCommitAt = null; this.closing = false;
  }
  fail() {
    if (this.failed || this.closing) return;
    this.failed = true; this.connected = false; this.next = null;
    // Intentionally omit connection strings, database errors and credentials.
    this.emit('failure', new Error('durable-state-unavailable'));
  }
  async open() {
    this.client = new this.Client({ connectionString: this.connectionString,
      connectionTimeoutMillis: 8000, query_timeout: 10000, application_name: 'r-h-pilot-state' });
    this.client.on('error', () => this.fail());
    this.client.on('end', () => this.fail());
    try {
      await this.client.connect();
      await this.client.query("SET statement_timeout = '8s'");
      const lock = await this.client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', ['R.H-Pilot:' + this.namespace]);
      if (lock.rows[0]?.locked !== true) throw new Error('state-writer-already-active');
      await this.client.query(`CREATE TABLE IF NOT EXISTS rh_pilot_state (
        id text PRIMARY KEY, revision bigint NOT NULL CHECK (revision > 0),
        payload jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
      )`);
      const result = await this.client.query('SELECT revision, CASE WHEN octet_length(payload::text) <= $2 THEN payload END AS payload FROM rh_pilot_state WHERE id = $1', [this.namespace, this.maxBytes]);
      const row = result.rows[0];
      if (row && (!row.payload || !Number.isSafeInteger(Number(row.revision)) || Number(row.revision) < 1 ||
          Buffer.byteLength(JSON.stringify(row.payload)) > this.maxBytes)) throw new Error('invalid-durable-state');
      this.revision = row ? Number(row.revision) : 0; this.connected = true;
      return row ? row.payload : null;
    } catch (error) {
      this.fail(); await this.close();
      throw new Error(error.message === 'state-writer-already-active' ? error.message : 'durable-state-unavailable');
    }
  }
  enqueue(text) {
    if (!this.connected || this.failed) throw new Error('durable-state-unavailable');
    if (typeof text !== 'string' || Buffer.byteLength(text) > this.maxBytes) throw new Error('state-size-limit');
    // At most one in-flight and one coalesced snapshot. Slow databases cannot
    // create an unbounded queue of complete customer databases in RAM.
    this.next = text;
    if (!this.active) {
      this.active = this.drain().finally(() => { this.active = null; });
      this.active.catch(() => {}); // callers use flush(); no unhandled rejection
    }
  }
  async drain() {
    try {
      while (this.next !== null) {
        const text = this.next; this.next = null;
        const expected = this.revision;
        const result = expected === 0
          ? await this.client.query(`INSERT INTO rh_pilot_state(id, revision, payload)
              VALUES ($1, 1, $2::jsonb) ON CONFLICT (id) DO NOTHING RETURNING revision`, [this.namespace, text])
          : await this.client.query(`UPDATE rh_pilot_state
              SET revision = revision + 1, payload = $2::jsonb, updated_at = now()
              WHERE id = $1 AND revision = $3 RETURNING revision`, [this.namespace, text, expected]);
        if (result.rows.length !== 1 || Number(result.rows[0].revision) !== expected + 1) throw new Error('state-revision-conflict');
        this.revision++; this.lastCommitAt = Date.now();
      }
    } catch (error) { this.fail(); throw new Error('durable-state-unavailable'); }
  }
  async flush() {
    if (this.active) await this.active;
    if (!this.connected || this.failed) throw new Error('durable-state-unavailable');
  }
  status() { return { mode: 'postgres', durable: this.connected && !this.failed,
    healthy: this.connected && !this.failed, revision: this.revision, lastCommitAt: this.lastCommitAt }; }
  async close() {
    this.closing = true;
    if (this.active) try { await this.active; } catch (error) { /* failed writes remain failed */ }
    if (this.client) try { await this.client.end(); } catch (error) { /* never log private URL */ }
    this.connected = false;
  }
}
module.exports = { StateStore };
