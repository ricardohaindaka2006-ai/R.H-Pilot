'use strict';
const crypto = require('node:crypto');

// Authentication helpers only. Account access is not authority to trade, a
// confirmed contract settlement, or evidence that a strategy is profitable.
const MESSAGES = Object.freeze({
  'deriv-auth-https-required': 'Use the HTTPS website before submitting a broker credential.',
  'account-disabled': 'This workspace is disabled. Contact the administrator.',
  'license-required': 'Enter your workspace license key to continue.',
  'license-invalid': 'That workspace license key is not valid.',
  'license-bound': 'That license key already belongs to another workspace.',
  'license-revoked': 'Your workspace license was revoked.',
  'license-expired': 'Your workspace license expired.',
  'risk-state-unavailable': 'State could not be saved. No sign-in was granted; recover storage and retry.',
  'broker-reconciliation-required': 'Unresolved broker exposure blocks replacing the linked account. Review the broker statement first.',
  'deriv-token-storage-key-required': 'The administrator must configure the private server encryption key before accepting production broker tokens.',
  'deriv-admin-step-up-required': 'Use the administrator password or verified Google sign-in first, then link from Wallet. A broker token alone cannot open the administrator workspace.',
  'missing-token': 'Enter a new Deriv token in the secure form, not in chat.',
  'invalid-token': 'The token must be plain text without spaces or control characters.',
  'deriv-app-id-required': 'The administrator must configure the registered Deriv App ID, not a PAT or a sample ID.',
  'deriv-oauth-origin-required': 'Configure PUBLIC_URL as the canonical HTTPS site origin before using production OAuth.',
  'deriv-auth-invalid-state': 'This Deriv sign-in attempt expired or was already used. Start again from this browser.',
  'deriv-link-session-expired': 'Your workspace session changed or expired. Sign in again before linking Deriv.',
  'deriv-auth-account-conflict': 'These broker accounts are associated with more than one workspace. Contact the administrator; nothing was merged.',
  'deriv-account-already-linked': 'That Deriv account belongs to another workspace. Sign in to the existing workspace instead.',
  'deriv-credentials-rejected': 'Deriv rejected or expired this credential. Revoke exposed tokens and enter a replacement through the secure form.',
  'deriv-permission-denied': 'Deriv denied this application or token access. Check the registered App ID and token permissions.',
  'deriv-provider-unavailable': 'Deriv could not be reached or returned an invalid response. Try again; no trading was enabled.',
  'deriv-account-selection-required': 'Choose the exact account ID; no real account was selected automatically.',
  'deriv-requested-account-unavailable': 'Deriv did not confirm the exact requested account. Nothing was switched.',
  'deriv-no-options-accounts': 'Deriv returned no supported active Options accounts for this credential.',
  'deriv-invalid-account-response': 'Deriv returned an account list that cannot be safely validated.',
  'deriv-auth-origin-denied': 'Start the connection from this website, not another origin.',
  'deriv-auth-invalid-request': 'Use a JSON object with a token in the secure form; do not put credentials in a URL.',
  'deriv-oauth-failed': 'Deriv did not complete authorization. Restart sign-in and check the registered callback URL.'
});
class AuthError extends Error {
  constructor(code, httpStatus = 400) {
    super(MESSAGES[code] || 'Deriv connection could not be completed.');
    this.code = code; this.httpStatus = httpStatus;
  }
}
function validAppId(value) {
  return typeof value === 'string' && value !== '1089' &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) && !/^pat_/i.test(value);
}
function tokenValue(value) {
  if (typeof value !== 'string') throw new AuthError('deriv-auth-invalid-request');
  const token = value.trim();
  if (!token) throw new AuthError('missing-token');
  if (token.length > 4096 || /[^\x21-\x7e]/.test(token)) throw new AuthError('invalid-token');
  return token;
}
function accountIds(account) {
  return new Set([account?.loginid, ...(account?.accounts || []).map(a => a.loginid)]
    .filter(id => typeof id === 'string' && id));
}
function owners(users, account) {
  const verified = accountIds(account);
  return users.filter(u => u.deriv && [...accountIds(u.deriv)].some(id => verified.has(id)));
}
function safeFailure(error) {
  // Never propagate provider descriptions, request URLs, bearer tokens or OTPs
  // to clients/public feed status/logs. Only our own known codes are public.
  return error instanceof AuthError ? error : new AuthError('deriv-provider-unavailable', 502);
}
class OAuthFlows {
  constructor({ ttlMs = 15 * 60000, maxPending = 2000 } = {}) {
    this.ttlMs = ttlMs; this.maxPending = maxPending; this.pending = new Map();
  }
  prune(now = Date.now()) {
    for (const [state, flow] of this.pending) if (flow.expiresAt <= now) this.pending.delete(state);
  }
  begin({ clientId, redirectUri, linkUserId = null, linkSessionHash = null }, now = Date.now()) {
    this.prune(now);
    if (this.pending.size >= this.maxPending) throw new AuthError('deriv-provider-unavailable', 503);
    const state = crypto.randomBytes(24).toString('hex');
    const verifier = crypto.randomBytes(48).toString('base64url');
    const flow = { state, verifier, clientId, redirectUri, linkUserId, linkSessionHash, expiresAt: now + this.ttlMs };
    this.pending.set(state, flow);
    return { state, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
  }
  take(returned, browserState, now = Date.now()) {
    this.prune(now);
    if (typeof returned !== 'string' || typeof browserState !== 'string' ||
        !/^[a-f0-9]{48}$/.test(returned) || !/^[a-f0-9]{48}$/.test(browserState) ||
        !crypto.timingSafeEqual(Buffer.from(returned), Buffer.from(browserState))) throw new AuthError('deriv-auth-invalid-state', 401);
    const flow = this.pending.get(returned);
    if (!flow) throw new AuthError('deriv-auth-invalid-state', 401);
    this.pending.delete(returned); // consume BEFORE any async exchange/replay
    return flow;
  }
}
module.exports = { AuthError, MESSAGES, validAppId, tokenValue, accountIds, owners, safeFailure, OAuthFlows };
