'use strict';
const crypto = require('node:crypto');

// The key lives ONLY in the hosting secret environment, never in the database,
// snapshots, public API, source control or browser. Back it up separately.
function keyFromEnvironment() {
  const text = String(process.env.DERIV_TOKEN_ENCRYPTION_KEY || '').trim();
  if (!text) return null;
  if (/^[a-f0-9]{64}$/i.test(text)) return Buffer.from(text, 'hex');
  const normalised = text.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  if (/^[A-Za-z0-9_-]{43}$/.test(normalised)) {
    const key = Buffer.from(normalised, 'base64url');
    if (key.length === 32 && key.toString('base64url') === normalised) return key;
  }
  throw new Error('deriv-token-encryption-key-invalid');
}
function ready() {
  try { return !!keyFromEnvironment() || process.env.NODE_ENV !== 'production'; }
  catch (error) { return false; }
}
function mode() {
  try { return keyFromEnvironment() ? 'aes-256-gcm' : process.env.NODE_ENV === 'production' ? 'unconfigured' : 'development-plaintext'; }
  catch (error) { return 'invalid-key'; }
}
const aad = userId => Buffer.from('R.H-Pilot:deriv-token:v1:' + userId);
function encodeDb(data) {
  const key = keyFromEnvironment(), out = structuredClone(data);
  for (const user of out.users || []) {
    if (!user.deriv?.token) continue;
    if (!key) {
      if (process.env.NODE_ENV === 'production') throw new Error('deriv-token-storage-key-required');
      continue; // local development only: never advertise this as encryption
    }
    if (typeof user.deriv.token !== 'string') throw new Error('deriv-token-serialization-invalid');
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad(user.id));
    const ciphertext = Buffer.concat([cipher.update(user.deriv.token, 'utf8'), cipher.final()]);
    user.deriv.token = { format: 'aes-256-gcm', version: 1, iv: iv.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') };
  }
  return out;
}
function decodeDb(data) {
  const key = keyFromEnvironment(), out = structuredClone(data);
  for (const user of out.users || []) {
    const sealed = user.deriv?.token;
    if (!sealed || typeof sealed === 'string') continue; // legacy migration: next save seals it
    if (!key) throw new Error('deriv-token-storage-key-required');
    try {
      if (sealed.format !== 'aes-256-gcm' || sealed.version !== 1 ||
          typeof sealed.iv !== 'string' || typeof sealed.tag !== 'string' || typeof sealed.ciphertext !== 'string') throw new Error('invalid');
      const iv = Buffer.from(sealed.iv, 'base64url'), tag = Buffer.from(sealed.tag, 'base64url');
      if (iv.length !== 12 || tag.length !== 16) throw new Error('invalid');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(aad(user.id)); decipher.setAuthTag(tag);
      user.deriv.token = Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64url')), decipher.final()]).toString('utf8');
    } catch (error) { throw new Error('deriv-token-decryption-failed'); }
  }
  return out;
}
module.exports = { ready, mode, encodeDb, decodeDb };
