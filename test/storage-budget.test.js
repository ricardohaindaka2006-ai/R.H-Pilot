'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StorageBudget, MB } = require('../engine/storage-budget.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhp-budget-'));
const make = (limits = {}) => new StorageBudget(dir, { freeReserveBytes: 0, ...limits });
function backup(index, size = 10, age = 0) {
  const file = path.join(dir, 'backups', 'backup-2026-11-08T17-00-00-000Z-' + String(index).padStart(8, '0') + '.json');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'x'.repeat(size));
  fs.utimesSync(file, new Date(Date.now() - age - index), new Date(Date.now() - age - index));
  return file;
}
test.beforeEach(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir); });
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('byte policy reserves an atomic-write copy and does not confuse memory with disk', () => {
  const b = make();
  assert.equal(b.limits.stateBytes, 8 * MB); assert.equal(b.limits.dataBytes, 48 * MB);
  assert.equal(b.limits.backupCount, 3); assert.equal(b.limits.backupBytes, 24 * MB);
  assert.throws(() => make({ dataBytes: MB }), /invalid-storage-budget/);
  assert.throws(() => b.assertState('é'.repeat(4 * MB + 1)), /state-size-limit/);
  assert.doesNotThrow(() => b.assertState('é'.repeat(4 * MB)));
});

test('retention actually deletes excess generated snapshots, not merely list entries', () => {
  for (let i = 0; i < 12; i++) backup(i);
  const b = make(); b.pruneBackups();
  assert.equal(b.backupFiles().length, 3); assert.equal(fs.readdirSync(path.join(dir, 'backups')).length, 3);
  assert.deepEqual(b.report().backupCount, 3);
});

test('byte/count reservations and seven-day age expire only recognized backups', () => {
  backup(0, 10); backup(1, 10); backup(2, 10, 8 * 86400000);
  const privateFile = path.join(dir, 'backups', 'operator-archive.json'); fs.writeFileSync(privateFile, 'do not delete');
  const b = make({ backupBytes: 25 });
  b.pruneBackups({ reserveBytes: 16, reserveCount: 1 });
  assert.equal(b.backupFiles().length, 0); assert.equal(fs.readFileSync(privateFile, 'utf8'), 'do not delete');
});

test('storage saturation fails closed without truncating identities or live risk', () => {
  const b = make({ stateBytes: 16, dataBytes: 64, backupBytes: 32 });
  const ledger = path.join(dir, 'db.json'); fs.writeFileSync(ledger, 'risk-state');
  fs.writeFileSync(path.join(dir, 'unknown-private-data'), 'x'.repeat(50));
  assert.throws(() => b.prepareState('new-risk-state'), /application-storage-limit/);
  assert.equal(fs.readFileSync(ledger, 'utf8'), 'risk-state');
  assert.equal(fs.statSync(path.join(dir, 'unknown-private-data')).size, 50);
});

test('backup pruning does not follow symlinks or touch an abandoned database write', () => {
  backup(1, 20);
  fs.writeFileSync(path.join(dir, 'db.json.tmp'), 'uncertain-state');
  const link = path.join(dir, 'backups', 'backup-2026-11-08T17-00-00-000Z-aaaaaaaa.json');
  fs.symlinkSync(path.join(dir, 'db.json.tmp'), link);
  make({ backupCount: 0 }).pruneBackups();
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(dir, 'db.json.tmp'), 'utf8'), 'uncertain-state');
});

test('a symlinked backup directory is refused, including when an external file would fit', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rhp-outside-'));
  try {
    fs.symlinkSync(outside, path.join(dir, 'backups'));
    assert.throws(() => make().prepareBackup('{}'), /unsafe-backup-directory/);
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
});
