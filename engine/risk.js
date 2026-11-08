'use strict';

// Mandatory PAPER-account guardrails, not a broker loss guarantee or proof of
// an edge. They constrain new exposure; actual gap fills are never clipped.
const POLICY = Object.freeze({
  version: 1,
  maxTradeRiskUsd: 1,
  maxTradeRiskPct: 1.5,
  maxOpenRiskUsd: 2,
  maxOpenRiskPct: 3,
  maxDailyLossPct: 3,
  maxDrawdownPct: 10,
  lossStreakThreshold: 3,
  lossPauseMs: 5 * 60 * 1000,
  dailyTradeCountLimit: null
});

function newState() {
  return { version: 1, peakBalance: null, drawdownLatched: false,
    haltedAt: null, consecutiveLosses: 0, pauseUntil: 0 };
}
function validState(r) {
  return !!r && typeof r === 'object' && !Array.isArray(r) && r.version === 1 &&
    (r.peakBalance === null || (Number.isFinite(r.peakBalance) && r.peakBalance > 0)) &&
    typeof r.drawdownLatched === 'boolean' &&
    (r.haltedAt === null || (Number.isFinite(r.haltedAt) && r.haltedAt >= 0)) &&
    Number.isSafeInteger(r.consecutiveLosses) && r.consecutiveLosses >= 0 &&
    Number.isFinite(r.pauseUntil) && r.pauseUntil >= 0 &&
    (r.drawdownLatched === (r.haltedAt !== null)) &&
    (r.consecutiveLosses < POLICY.lossStreakThreshold || r.pauseUntil > 0) &&
    (r.peakBalance !== null || (!r.drawdownLatched && r.consecutiveLosses === 0 && r.pauseUntil === 0));
}
function pristine(bot) {
  return !bot.startedAt && !bot.closedTrades && !(bot.trades || []).length &&
    !(bot.positions || []).length && bot.profit === 0 && validState(bot.risk) &&
    !bot.risk.drawdownLatched && bot.risk.consecutiveLosses === 0 && bot.risk.pauseUntil === 0;
}
function seedFreshAccount(bot, balance) {
  if (!pristine(bot) || !Number.isFinite(balance) || balance <= 0) return false;
  // Only a never-traded paper account can accept a new starting bankroll.
  // Preset/settings/restart/resync calls must never reset an active risk ledger.
  bot.risk = { ...newState(), peakBalance: balance };
  return true;
}
function migrateState(bot, now) {
  const r = newState();
  const peak = bot.startBalance + Math.max(0, bot.peakProfit);
  if (Number.isFinite(peak) && peak > 0) r.peakBalance = Math.max(peak, bot.balance);
  let latestLossAt = null;
  for (const trade of bot.trades || []) {
    if (!trade || !Number.isFinite(trade.pnl)) break;
    if (trade.pnl > 1e-9) break;
    if (trade.pnl < -1e-9) {
      r.consecutiveLosses++;
      if (latestLossAt === null) latestLossAt = Number.isFinite(trade.at) && trade.at > 0 ? trade.at : now;
    }
  }
  if (r.consecutiveLosses >= POLICY.lossStreakThreshold) r.pauseUntil = latestLossAt + POLICY.lossPauseMs;
  return r;
}
function inspect(bot, equity = bot.balance, now = Date.now()) {
  if (bot.risk === undefined) bot.risk = migrateState(bot, now); // preserve known legacy losing streaks
  const r = bot.risk;
  const invalid = reason => ({ valid: false, blocked: true, reason, headroom: 0, policy: POLICY });
  if (!validState(r)) return invalid('invalid-risk-ledger');
  if (!Number.isFinite(bot.balance) || !Number.isFinite(bot.startBalance) || bot.startBalance <= 0 ||
      !Number.isFinite(bot.peakProfit) || !Number.isFinite(bot.startBalance + Math.max(0, bot.peakProfit))) return invalid('invalid-paper-equity');
  if (!Number.isFinite(equity)) return invalid('unpriced-paper-exposure');
  // Migration reconstructs the best known realised cash watermark, not just
  // today's (possibly depleted) balance. Unrealised gains never raise it.
  const historicalPeak = bot.startBalance + Math.max(0, bot.peakProfit);
  r.peakBalance = Math.max(r.peakBalance || historicalPeak, historicalPeak, bot.balance);
  const floorEquity = r.peakBalance * (1 - POLICY.maxDrawdownPct / 100);
  if (equity <= floorEquity + 1e-9) {
    r.drawdownLatched = true;
    if (r.haltedAt === null) r.haltedAt = now;
  }
  const reason = r.drawdownLatched ? 'account-drawdown-limit'
    : r.pauseUntil > now ? 'loss-streak-cooldown' : null;
  return { valid: true, blocked: !!reason, reason, policy: POLICY,
    peakBalance: r.peakBalance, equity, floorEquity,
    drawdownPct: Math.max(0, (r.peakBalance - equity) / r.peakBalance * 100),
    headroom: Math.max(0, Math.min(bot.balance, equity) - floorEquity),
    drawdownLatched: r.drawdownLatched, consecutiveLosses: r.consecutiveLosses,
    pauseUntil: r.pauseUntil, pauseRemainingMs: Math.max(0, r.pauseUntil - now) };
}
function recordOutcome(bot, pnl, now = Date.now()) {
  if (!validState(bot.risk) || !Number.isFinite(pnl)) return false;
  const r = bot.risk;
  if (pnl < -1e-9) {
    r.consecutiveLosses++;
    if (r.consecutiveLosses >= POLICY.lossStreakThreshold) r.pauseUntil = Math.max(r.pauseUntil, now + POLICY.lossPauseMs);
  } else if (pnl > 1e-9) r.consecutiveLosses = 0;
  // A winner or scratch does not retrospectively cancel a running pause.
  return true;
}
module.exports = { POLICY, newState, validState, pristine, seedFreshAccount, inspect, recordOutcome };
