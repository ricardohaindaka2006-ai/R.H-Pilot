'use strict';
const fs = require('node:fs');
const path = require('node:path');
const MB = 1024 * 1024;
// Application-owned bytes, NOT a claim about Render's filesystem quota. The
// 512 MB Free allowance is RAM. Never delete customer/risk data to fit a budget.
const DEFAULTS = Object.freeze({ stateBytes: 8 * MB, backupBytes: 24 * MB,
  dataBytes: 48 * MB, backupCount: 3, backupAgeMs: 7 * 86400000, freeReserveBytes: 16 * MB });
const BACKUP_NAME = /^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-[a-f0-9]{8})?\.json$/;
class BudgetError extends Error {
  constructor(code) { super(code); this.code = code; this.httpStatus = 507; }
}
class StorageBudget {
  constructor(dir, limits = {}) {
    this.dir = dir; this.backups = path.join(dir, 'backups');
    this.limits = Object.freeze({ ...DEFAULTS, ...limits });
    for (const value of Object.values(this.limits)) if (!Number.isSafeInteger(value) || value < 0) throw new BudgetError('invalid-storage-budget');
    if (!this.limits.stateBytes || this.limits.dataBytes < this.limits.stateBytes * 2 ||
        this.limits.backupBytes > this.limits.dataBytes - this.limits.stateBytes * 2) throw new BudgetError('invalid-storage-budget');
  }
  inventory(dir = this.dir, depth = 0) {
    let bytes = 0, files = 0;
    if (depth > 12) throw new BudgetError('storage-directory-depth-exceeded');
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name), stat = fs.lstatSync(file);
        // Symlinks are never followed or cleaned. Count the link itself only.
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
          const child = this.inventory(file, depth + 1); bytes += child.bytes; files += child.files;
        } else { bytes += stat.size; files++; }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { bytes, files };
  }
  backupFiles() {
    try {
      const dir = fs.lstatSync(this.backups);
      if (!dir.isDirectory() || dir.isSymbolicLink()) throw new BudgetError('unsafe-backup-directory');
      return fs.readdirSync(this.backups).filter(name => BACKUP_NAME.test(name)).flatMap(name => {
        const stat = fs.lstatSync(path.join(this.backups, name));
        return stat.isFile() && !stat.isSymbolicLink() ? [{ name, bytes: stat.size, at: stat.mtimeMs }] : [];
      }).sort((a, b) => b.at - a.at || b.name.localeCompare(a.name));
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  pruneBackups({ reserveBytes = 0, reserveCount = 0, now = Date.now() } = {}) {
    const kept = []; let bytes = reserveBytes;
    for (const file of this.backupFiles()) {
      if (now - file.at > this.limits.backupAgeMs || kept.length + reserveCount >= this.limits.backupCount ||
          bytes + file.bytes > this.limits.backupBytes) fs.unlinkSync(path.join(this.backups, file.name));
      else { kept.push(file); bytes += file.bytes; }
    }
    return kept;
  }
  assertState(text) {
    if (Buffer.byteLength(text) > this.limits.stateBytes) throw new BudgetError('state-size-limit');
  }
  assertRoom(additionalBytes) {
    const { bytes } = this.inventory();
    if (bytes + additionalBytes > this.limits.dataBytes) throw new BudgetError('application-storage-limit');
    if (fs.existsSync(this.dir) && typeof fs.statfsSync === 'function') {
      const stat = fs.statfsSync(this.dir);
      if (stat.bavail * stat.bsize < additionalBytes + this.limits.freeReserveBytes) throw new BudgetError('filesystem-free-space-low');
    }
  }
  prepareState(text) {
    this.assertState(text); this.pruneBackups(); this.assertRoom(Buffer.byteLength(text));
  }
  prepareBackup(text) {
    const bytes = Buffer.byteLength(text);
    if (!this.limits.backupCount || bytes > this.limits.backupBytes) throw new BudgetError('backup-size-limit');
    this.pruneBackups({ reserveBytes: bytes, reserveCount: 1 }); this.assertRoom(bytes);
  }
  report() {
    const data = this.inventory(), backups = this.backupFiles();
    return { ...data, limitBytes: this.limits.dataBytes, stateLimitBytes: this.limits.stateBytes,
      backupBytes: backups.reduce((n, file) => n + file.bytes, 0), backupCount: backups.length,
      backupCountLimit: this.limits.backupCount, backupByteLimit: this.limits.backupBytes,
      backupRetentionDays: this.limits.backupAgeMs / 86400000,
      pct: Math.round(data.bytes / this.limits.dataBytes * 10000) / 100 };
  }
}
module.exports = { StorageBudget, BudgetError, DEFAULTS, BACKUP_NAME, MB };
