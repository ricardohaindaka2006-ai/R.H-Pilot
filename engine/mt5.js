'use strict';
const crypto = require('node:crypto');
const RISK = require('./risk.js');
const ENGINE = require('./strategies.js');
const PAPER = require('./execution.js');
const DEFAULT_SETTINGS = Object.freeze({ strategy: 'auto', riskPerTrade: 0.5, compoundProfits: true,
  maxLossPerTrade: 0, dailyLossLimit: 0, profitTarget: 0,
  lockInProfit: true, lockAfterR: 0.5, trailAfterR: 1, trailByR: 0.35, trailing: true });
function settingsFor(body, previous = DEFAULT_SETTINGS) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !Object.hasOwn(DEFAULT_SETTINGS, k))) throw new Mt5Error('mt5-invalid-settings');
  const settings = { ...DEFAULT_SETTINGS, ...previous, ...body };
  if (typeof settings.strategy !== 'string') throw new Mt5Error('mt5-invalid-settings');
  if (settings.strategy !== 'auto' && !Object.hasOwn(ENGINE.STRATEGIES, settings.strategy)) throw new Mt5Error('mt5-invalid-settings');
  if (!finite(settings.riskPerTrade) || settings.riskPerTrade < 0.1 || settings.riskPerTrade > 1.5 ||
      !['compoundProfits', 'lockInProfit', 'trailing'].every(k => typeof settings[k] === 'boolean') ||
      !['maxLossPerTrade', 'dailyLossLimit', 'profitTarget'].every(k => finite(settings[k]) && settings[k] >= 0) ||
      settings.maxLossPerTrade > 1) throw new Mt5Error('mt5-invalid-settings');
  if (settings.lockAfterR < 0.1 || settings.lockAfterR > 1 || settings.trailAfterR < 0.2 || settings.trailAfterR > 3 || settings.trailByR < 0.1 || settings.trailByR > 2) throw new Mt5Error('mt5-invalid-settings');
  try { PAPER.executionOptions(settings); } catch (error) { throw new Mt5Error('mt5-invalid-settings'); }
  return settings;
}
const PROTOCOL = 1, FRESH_MS = 8000, COMMAND_MS = 5000, CLOSED_CAP = 100;
const UNRESOLVED = new Set(['delivered', 'filled', 'uncertain']);
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const finite = n => typeof n === 'number' && Number.isFinite(n);
const positive = n => finite(n) && n > 0;
const ticket = s => typeof s === 'string' && /^[1-9][0-9]{0,19}$/.test(s);
const safeString = (s, max) => typeof s === 'string' && s.length > 0 && s.length <= max && !/[\x00-\x1f\x7f]/.test(s);
class Mt5Error extends Error {
  constructor(code, httpStatus = 400) { super(code); this.code = code; this.httpStatus = httpStatus; }
}
function exposure(m) { return !!m && (m.orders || []).some(order => UNRESOLVED.has(order.status)); }
function validAccount(a) {
  return a && ticket(a.login) && safeString(a.server, 80) && safeString(a.company, 100) &&
    /deriv/i.test(a.company) && [0, 1, 2].includes(a.tradeMode) && [0, 1, 2].includes(a.marginMode) &&
    /^[A-Z]{3}$/.test(a.currency) && ['balance', 'equity', 'freeMargin'].every(k => finite(a[k])) &&
    typeof a.tradeAllowed === 'boolean' && typeof a.expertAllowed === 'boolean';
}
function freshQuote(q, now = Date.now()) {
  return q && positive(q.bid) && positive(q.ask) && q.ask >= q.bid &&
    Number.isSafeInteger(q.timeMsc) && now - q.timeMsc >= -2000 && now - q.timeMsc <= FRESH_MS;
}
function validQuote(q) {
  return q && safeString(q.symbol, 80) && positive(q.bid) && positive(q.ask) && q.ask >= q.bid &&
    Number.isSafeInteger(q.timeMsc) && q.timeMsc > 0 &&
    ['point', 'tickSize', 'tickValueLoss', 'volumeMin', 'volumeMax', 'volumeStep'].every(k => positive(q[k])) &&
    q.volumeMin <= q.volumeMax && q.volumeStep <= q.volumeMax && Number.isInteger(q.digits) && q.digits >= 0 && q.digits <= 10 &&
    ['stopsLevel', 'freezeLevel'].every(k => Number.isSafeInteger(q[k]) && q[k] >= 0) &&
    Number.isInteger(q.tradeMode) && q.tradeMode >= 0 && q.tradeMode <= 4;
}
function restored(m) {
  if (m == null) return null;
  if (m.version !== PROTOCOL || !ticket(m.login) || !safeString(m.server, 80) ||
      !safeString(m.symbol, 80) || !/^[a-f0-9]{64}$/.test(m.tokenHash) || !Array.isArray(m.orders) ||
      !Number.isSafeInteger(m.sequence) || m.sequence < 0 ||
      m.orders.some(o => !o || !/^[a-f0-9]{24}$/.test(o.id) || !['delivered', 'filled', 'uncertain', 'rejected', 'settled', 'cancelled'].includes(o.status) || !positive(o.risk))) throw new Mt5Error('invalid-mt5-ledger');
  if (m.ledger && (!RISK.validState(m.ledger.risk) || !finite(m.ledger.profit) || !positive(m.ledger.startBalance) || !finite(m.ledger.balance))) throw new Mt5Error('invalid-mt5-risk-ledger');
  m.settings = settingsFor({}, m.settings || DEFAULT_SETTINGS);
  m.mode = 'monitor'; m.waitingReason = exposure(m) ? 'mt5-reconciliation-required' : 'mt5-restart-disarmed';
  return m;
}
// Sizing uses MT5's symbol metadata, NOT the paper engine's $100 notional.
// The agent independently recalculates loss/margin with order_calc_profit and
// order_calc_margin immediately before order_check/order_send.
function planOrder(signal, q, account, budget, exitSettings = PAPER.DEFAULT_EXECUTION) {
  if (!signal || ![1, -1].includes(signal.dir) || !positive(signal.slDist) || !positive(signal.tpDist) ||
      !validQuote(q) || !freshQuote(q) || !validAccount(account) || account.currency !== 'USD' ||
      q.tradeMode !== 4 || !positive(budget) || budget > RISK.POLICY.maxTradeRiskUsd + 1e-9) return null;
  const dir = signal.dir, entry = dir === 1 ? q.ask : q.bid;
  const round = (n, up) => +(Math[up ? 'ceil' : 'floor']((n + (up ? -1 : 1) * 1e-12) / q.tickSize) * q.tickSize).toFixed(q.digits);
  const distance = (Math.max(q.stopsLevel, q.freezeLevel) + 2) * q.point;
  const sl = dir === 1 ? round(Math.min(entry - signal.slDist, q.bid - distance), false)
    : round(Math.max(entry + signal.slDist, q.ask + distance), true);
  const tp = dir === 1 ? round(Math.max(entry + signal.tpDist, q.ask + distance), true)
    : round(Math.min(entry - signal.tpDist, q.bid - distance), false);
  if (!positive(sl) || !positive(tp) || (entry - sl) * dir <= 0 || (tp - entry) * dir <= 0) return null;
  const allowance = Math.max(q.ask - q.bid, q.tickSize * 2);
  const worstEntry = entry + dir * allowance;
  const lossPerLot = Math.abs(worstEntry - sl) / q.tickSize * q.tickValueLoss;
  const costBuffer = 0.10; // explicit demo assumption, NOT a broker fee guarantee
  const raw = (budget - costBuffer) / lossPerLot;
  const volume = +(Math.floor(Math.min(q.volumeMax, raw) / q.volumeStep) * q.volumeStep).toFixed(8);
  if (!positive(volume) || volume < q.volumeMin - 1e-10 || volume * lossPerLot + costBuffer > budget + 1e-9) return null;
  return { action: 'open', symbol: q.symbol, side: dir === 1 ? 'BUY' : 'SELL', volume, sl, tp,
    referencePrice: entry, worstEntry, maxRisk: budget, costBuffer,
    deviationPoints: Math.max(0, Math.min(20, Math.floor(allowance / q.point))),
    maxHoldSeconds: Math.max(30, Math.min(600, Math.round((signal.hold || 30) * 2))),
    exitSettings: PAPER.executionOptions(exitSettings), strategy: signal.strategy };
}
function durableFingerprint(m) {
  return JSON.stringify({ login: m.login, server: m.server, instanceId: m.instanceId,
    session: m.agentSessionId, mode: m.mode, settings: m.settings, ledger: m.ledger, orders: m.orders,
    pendingOrders: m.pendingOrders || 0,
    positions: (m.positions || []).map(p => ({ id: p.id, symbol: p.symbol, side: p.side, volume: p.volume })) });
}
class Mt5Bridge {
  constructor({ getDb, persist, storageReady, entryBlock, chooseSignal } = {}) {
    Object.assign(this, { getDb, persist, storageReady, entryBlock, chooseSignal });
    this.runtime = new Map(); this.busy = new Set();
  }
  active(m) { return exposure(m); }
  publicStatus(user) {
    const m = user.mt5;
    if (!m) return { configured: false, protocol: PROTOCOL, mode: 'monitor', liveEnabled: false,
      executionProduct: 'mt5', reason: 'mt5-not-paired', durableStorageReady: this.storageReady() };
    const rt = this.runtime.get(user.id), fresh = !!rt && Date.now() - rt.at <= FRESH_MS;
    return { configured: true, protocol: PROTOCOL, login: m.login, server: m.server, symbol: m.symbol,
      settings: m.settings || DEFAULT_SETTINGS, mode: m.mode, liveEnabled: false, account: m.account || null,
      connected: fresh, brokerPendingOrders: m.pendingOrders || 0, lastSeenAt: m.lastSeenAt || null, quote: fresh ? rt.quote : null,
      samples: rt?.history.length || 0, warmup: ENGINE.WARMUP + 1,
      reason: !fresh ? 'mt5-agent-offline' : !freshQuote(rt.quote) ? 'mt5-stale-quote' : m.waitingReason || null,
      reconciliationRequired: (m.orders || []).some(o => o.status === 'uncertain' || o.status === 'delivered'),
      openPositions: m.positions || [], orders: (m.orders || []).map(o => ({ id: o.id,
        status: o.status, action: o.action, side: o.side, symbol: o.symbol, volume: o.volume,
        risk: o.risk, positionId: o.positionId || null, pnl: o.pnl ?? null, at: o.at, reason: o.reason || null })),
      ledger: m.ledger ? { balance: m.ledger.balance, profit: m.ledger.profit, closedTrades: m.ledger.closedTrades,
        dayPnl: m.ledger.dayPnl, risk: m.ledger.risk } : null,
      durableStorageReady: this.storageReady(), plannedRiskPolicy: RISK.POLICY };
  }
  async pair(user, body) {
    if (!ticket(body.login) || !safeString(body.server, 80) || !safeString(body.symbol, 80)) throw new Mt5Error('mt5-exact-account-required');
    if (this.busy.has(user.id) || exposure(user.mt5) || user.mt5?.positions?.length || user.mt5?.pendingOrders) throw new Mt5Error('mt5-reconciliation-required', 409);
    if (this.getDb().users.some(u => u.id !== user.id && [u.mt5, ...(u.mt5Archive || [])].some(m => m?.login === body.login && m.server === body.server))) throw new Mt5Error('mt5-account-already-linked', 409);
    const token = 'rhp5_' + crypto.randomBytes(32).toString('base64url');
    const before = user.mt5, previousArchive = user.mt5Archive;
    const archive = [...(user.mt5Archive || [])];
    const same = before?.login === body.login && before.server === body.server;
    const archived = archive.findIndex(m => m.login === body.login && m.server === body.server);
    const retained = same ? before : archived >= 0 ? archive.splice(archived, 1)[0] : null;
    if (before && !same) archive.push(before);
    if (archive.length >= 20) throw new Mt5Error('mt5-account-history-capacity', 409);
    user.mt5Archive = archive;
    user.mt5 = { ...(retained || {}), version: PROTOCOL, login: body.login, server: body.server, symbol: body.symbol,
      tokenHash: hash(token), instanceId: null, agentSessionId: null, agentLeaseUntil: 0, lastSeenAt: null, sequence: 0, mode: 'monitor', orders: retained?.orders || [],
      settings: settingsFor({}, retained?.settings || DEFAULT_SETTINGS),
      createdAt: retained?.createdAt || Date.now(), waitingReason: 'mt5-agent-offline', lastReply: null, lastPayloadHash: null };
    this.runtime.delete(user.id);
    try { await this.persist(); }
    catch (error) { user.mt5 = before; user.mt5Archive = previousArchive; throw new Mt5Error('risk-state-unavailable', 503); }
    return { token, mt5: this.publicStatus(user) };
  }
  async settings(user, body) {
    if (!user.mt5) throw new Mt5Error('mt5-not-paired', 409);
    if (this.busy.has(user.id)) throw new Mt5Error('mt5-bridge-busy', 409);
    const next = settingsFor(body, user.mt5.settings);
    user.mt5.settings = next; await this.persist();
    return this.publicStatus(user);
  }
  async rotate(user) {
    if (!user.mt5) throw new Mt5Error('mt5-not-paired', 409);
    if (this.busy.has(user.id)) throw new Mt5Error('mt5-bridge-busy', 409);
    const token = 'rhp5_' + crypto.randomBytes(32).toString('base64url');
    user.mt5.mode = 'monitor'; user.mt5.tokenHash = hash(token);
    user.mt5.waitingReason = 'mt5-token-rotated-restart-agent';
    // Retain account, instance, sequence, risk, receipts and unresolved intents.
    await this.persist();
    return { token, mt5: this.publicStatus(user) };
  }
  authenticate(raw) {
    if (typeof raw !== 'string' || !/^rhp5_[A-Za-z0-9_-]{43}$/.test(raw)) throw new Mt5Error('mt5-agent-unauthorized', 401);
    const digest = hash(raw);
    const user = this.getDb().users.find(u => u.mt5?.tokenHash &&
      crypto.timingSafeEqual(Buffer.from(u.mt5.tokenHash, 'hex'), Buffer.from(digest, 'hex')));
    if (!user) throw new Mt5Error('mt5-agent-unauthorized', 401);
    return user;
  }
  async start(user, body) {
    const m = user.mt5, rt = this.runtime.get(user.id);
    if (body.confirmation !== 'MT5_DEMO_ONLY') throw new Mt5Error('mt5-demo-confirmation-required');
    if (!m || !rt || Date.now() - rt.at > FRESH_MS) throw new Mt5Error('mt5-agent-offline', 409);
    if (!freshQuote(rt.quote)) throw new Mt5Error('mt5-stale-quote', 409);
    if (!this.storageReady()) throw new Mt5Error('durable-storage-required', 503);
    const reason = this.entryBlock(user);
    if (reason) throw new Mt5Error(reason, 403);
    if (m.account.tradeMode !== 0) throw new Mt5Error('mt5-real-orders-disabled', 403);
    if (m.account.currency !== 'USD') throw new Mt5Error('mt5-usd-account-required', 409);
    if (m.account.marginMode !== 2) throw new Mt5Error('mt5-hedging-account-required', 409);
    if (!m.account.tradeAllowed || !m.account.expertAllowed) throw new Mt5Error('mt5-terminal-trading-disabled', 409);
    if (user.bot.running || user.bot.positions.length || exposure(m) || m.positions.length || m.pendingOrders) throw new Mt5Error('mt5-reconciliation-required', 409);
    if (!m.ledger) throw new Mt5Error('mt5-account-not-funded', 409);
    const risk = RISK.inspect(m.ledger, m.account.equity);
    if (risk.blocked || m.waitingReason === 'mt5-balance-reconciliation-required') throw new Mt5Error(risk.reason || m.waitingReason, 409);
    const settings = m.settings || DEFAULT_SETTINGS;
    if (m.ledger.dayPnl <= -Math.min(m.ledger.dayStartBalance * 0.03, settings.dailyLossLimit || Infinity)) throw new Mt5Error('daily-loss-limit', 409);
    if (settings.profitTarget > 0 && m.ledger.profit >= settings.profitTarget) throw new Mt5Error('mt5-profit-target-reached', 409);
    m.mode = 'demo'; m.waitingReason = null; await this.persist();
    return this.publicStatus(user);
  }
  async pause(user) {
    if (user.mt5) { user.mt5.mode = 'monitor'; user.mt5.waitingReason = 'mt5-entries-paused'; await this.persist(); }
    return this.publicStatus(user);
  }
  async unlink(user) {
    if (this.busy.has(user.id) || exposure(user.mt5) || user.mt5?.positions?.length || user.mt5?.pendingOrders) throw new Mt5Error('mt5-reconciliation-required', 409);
    const before = user.mt5, previousArchive = user.mt5Archive;
    if (before) {
      user.mt5Archive = [...(previousArchive || []), before];
      if (user.mt5Archive.length > 20) { user.mt5Archive = previousArchive; throw new Mt5Error('mt5-account-history-capacity', 409); }
    }
    user.mt5 = null;
    try { await this.persist(); this.runtime.delete(user.id); }
    catch (error) { user.mt5 = before; user.mt5Archive = previousArchive; throw new Mt5Error('risk-state-unavailable', 503); }
    return this.publicStatus(user);
  }
  validateReport(m, body) {
    if (body.protocol !== PROTOCOL || !/^[a-f0-9-]{36}$/.test(body.instanceId || '') || !/^[a-f0-9-]{36}$/.test(body.sessionId || '') ||
        !Number.isSafeInteger(body.sequence) || body.sequence < 1 || !validAccount(body.account) ||
        body.account.login !== m.login || body.account.server !== m.server ||
        !validQuote(body.quote) || body.quote.symbol !== m.symbol ||
        !Array.isArray(body.positions) || body.positions.length > 100 || !Number.isInteger(body.pendingOrders) || body.pendingOrders < 0 || body.pendingOrders > 100 ||
        !Array.isArray(body.results) || body.results.length > 20) throw new Mt5Error('mt5-invalid-report');
    if (m.instanceId && m.instanceId !== body.instanceId) throw new Mt5Error('mt5-agent-instance-conflict', 409);
    if (m.agentSessionId && m.agentSessionId !== body.sessionId && Date.now() < m.agentLeaseUntil) throw new Mt5Error('mt5-agent-session-conflict', 409);
    for (const p of body.positions) if (!p || !ticket(p.id) || !safeString(p.symbol, 80) || !positive(p.volume) ||
      !['BUY', 'SELL'].includes(p.side) || !positive(p.entry) || !finite(p.sl) || p.sl < 0 || !finite(p.tp) || p.tp < 0) throw new Mt5Error('mt5-invalid-report');
    for (const r of body.results) if (!r || !/^[a-f0-9]{24}$/.test(r.id || '') ||
      !['filled', 'rejected', 'uncertain', 'closed'].includes(r.status) ||
      (['filled', 'closed'].includes(r.status) && !ticket(r.positionId)) ||
      (r.status === 'filled' && (!positive(r.volume) || !positive(r.entry) || !positive(r.sl) || !positive(r.tp))) ||
      (r.status === 'closed' && (!finite(r.pnl) || !['grossProfit', 'commission', 'swap', 'fee'].every(k => finite(r[k])) ||
        Math.abs(r.pnl - r.grossProfit - r.commission - r.swap - r.fee) > 1e-8 ||
        !positive(r.entryVolume) || !positive(r.exitVolume) || Math.abs(r.entryVolume - r.exitVolume) > 1e-8 ||
        !Number.isSafeInteger(r.dealCount) || r.dealCount < 2 || r.dealCount > 1000 ||
        !Number.isSafeInteger(r.closedAt) || r.closedAt <= 0 || r.closedAt > Date.now() + 2000))) throw new Mt5Error('mt5-invalid-result');
  }
  applyResults(m, results) {
    const ack = [];
    for (const r of results) {
      const o = m.orders.find(order => order.id === r.id);
      // Unknown receipts can indicate rollback/data loss. Never silently create
      // a new intent or assign a receipt to a different account/order.
      if (!o) throw new Mt5Error('mt5-unknown-receipt', 409);
      if (o.positionId && r.positionId && o.positionId !== r.positionId) throw new Mt5Error('mt5-receipt-conflict', 409);
      if (o.status === 'settled') {
        if (r.status !== 'closed' || r.pnl !== o.pnl || r.closedAt !== o.closedAt) throw new Mt5Error('mt5-receipt-conflict', 409);
        ack.push(r.id); continue;
      }
      if (o.status === 'rejected' && r.status !== 'rejected') throw new Mt5Error('mt5-receipt-conflict', 409);
      if (r.status === 'closed') {
        if (m.ledger.day !== new Date(r.closedAt).toISOString().slice(0, 10)) {
          // Out-of-order settlements cannot roll today's ledger backwards.
          if (new Date(r.closedAt).toISOString().slice(0, 10) > m.ledger.day) {
            m.ledger.day = new Date(r.closedAt).toISOString().slice(0, 10);
            m.ledger.dayPnl = 0; m.ledger.dayStartBalance = m.account.balance - r.pnl;
          }
        }
        if (new Date(r.closedAt).toISOString().slice(0, 10) === m.ledger.day) m.ledger.dayPnl += r.pnl;
        m.ledger.profit += r.pnl; m.ledger.peakProfit = Math.max(m.ledger.peakProfit, m.ledger.profit);
        m.ledger.closedTrades++; RISK.recordOutcome(m.ledger, r.pnl);
        Object.assign(o, { status: 'settled', positionId: r.positionId, pnl: r.pnl, closedAt: r.closedAt,
          costs: { grossProfit: r.grossProfit, commission: r.commission, swap: r.swap, fee: r.fee, dealCount: r.dealCount } });
      } else if (r.status === 'filled') {
        Object.assign(o, { status: 'filled', positionId: r.positionId, volume: r.volume, entry: r.entry, sl: r.sl, tp: r.tp });
      } else if (r.status === 'rejected') {
        if (o.status === 'filled' || o.positionId) throw new Mt5Error('mt5-receipt-conflict', 409);
        o.status = 'rejected';
      }
      else { o.status = 'uncertain'; m.mode = 'monitor'; m.waitingReason = 'mt5-reconciliation-required'; }
      ack.push(r.id);
    }
    return ack;
  }
  async poll(user, body) {
    if (this.busy.has(user.id)) throw new Mt5Error('mt5-bridge-busy', 409);
    this.busy.add(user.id);
    const m = user.mt5;
    try {
      this.validateReport(m, body);
      const digest = hash(JSON.stringify(body));
      if (body.sequence === m.sequence && digest === m.lastPayloadHash) {
        const reply = structuredClone(m.lastReply);
        reply.mode = m.mode; reply.reason = m.waitingReason;
        if (reply.command && (reply.command.expiresAt < Date.now() || m.mode !== 'demo' || this.entryBlock(user))) {
          reply.reconcile = [...(reply.reconcile || []), reply.command]; reply.command = null;
        }
        return reply;
      }
      if (body.sequence <= m.sequence) throw new Mt5Error('mt5-report-replayed', 409);
      // Validate receipts on a clone before touching any financial/sequence state.
      const staged = structuredClone(m);
      staged.account = structuredClone(body.account);
      if (!staged.ledger && body.account.balance > 0) staged.ledger = { risk: { ...RISK.newState(), peakBalance: body.account.balance },
        balance: body.account.balance, startBalance: body.account.balance, profit: 0, peakProfit: 0,
        closedTrades: 0, day: new Date().toISOString().slice(0, 10), dayPnl: 0, dayStartBalance: body.account.balance };
      if (!staged.ledger && body.results.length) throw new Mt5Error('mt5-invalid-account-equity', 409);
      const ack = staged.ledger ? this.applyResults(staged, body.results) : [];
      staged.positions = structuredClone(body.positions); staged.pendingOrders = body.pendingOrders;
      if (staged.ledger) staged.ledger.balance = body.account.balance;
      const day = new Date().toISOString().slice(0, 10);
      if (staged.ledger && staged.ledger.day < day) { staged.ledger.day = day; staged.ledger.dayPnl = 0; staged.ledger.dayStartBalance = body.account.balance; }
      const risk = staged.ledger ? RISK.inspect(staged.ledger, body.account.equity) : { blocked: true, reason: 'mt5-account-not-funded' };
      if (staged.ledger && !exposure(staged) && !body.positions.length && !body.pendingOrders &&
          Math.abs(staged.ledger.startBalance + staged.ledger.profit - body.account.balance) > 0.02) {
        staged.mode = 'monitor'; staged.waitingReason = 'mt5-balance-reconciliation-required';
      }
      const settings = staged.settings || DEFAULT_SETTINGS;
      if (risk.blocked || (staged.ledger && staged.ledger.dayPnl <= -Math.max(0, Math.min(staged.ledger.dayStartBalance * 0.03, settings.dailyLossLimit || Infinity))) || this.entryBlock(user) ||
          (settings.profitTarget > 0 && staged.ledger?.profit >= settings.profitTarget)) {
        staged.mode = 'monitor'; staged.waitingReason = risk.reason || this.entryBlock(user) || (settings.profitTarget > 0 && staged.ledger?.profit >= settings.profitTarget ? 'mt5-profit-target-reached' : 'daily-loss-limit');
      }
      let rt = this.runtime.get(user.id);
      if (!rt) rt = { history: [], timeMsc: 0, at: 0 };
      const newTick = body.quote.timeMsc > rt.timeMsc && freshQuote(body.quote);
      if (newTick) {
        rt.history.push((body.quote.bid + body.quote.ask) / 2);
        if (rt.history.length > 180) rt.history.shift();
        rt.timeMsc = body.quote.timeMsc;
      }
      rt.quote = structuredClone(body.quote); rt.at = Date.now();
      this.runtime.set(user.id, rt);
      let command = null;
      if (staged.mode === 'demo') {
        let reason = !this.storageReady() ? 'durable-storage-required'
          : body.account.tradeMode !== 0 ? 'mt5-real-orders-disabled'
          : body.account.currency !== 'USD' ? 'mt5-usd-account-required'
          : body.account.marginMode !== 2 ? 'mt5-hedging-account-required'
          : !body.account.tradeAllowed || !body.account.expertAllowed ? 'mt5-terminal-trading-disabled'
          : !freshQuote(body.quote) ? 'mt5-stale-quote'
          : !newTick ? 'mt5-awaiting-new-tick'
          : exposure(staged) || body.positions.length || body.pendingOrders ? 'mt5-exposure-reserved'
          : Date.now() - (staged.lastEntryAt || 0) < 5000 ? 'mt5-entry-cooldown'
          : rt.history.length <= ENGINE.WARMUP ? 'mt5-warming-up' : null;
        if (!reason) {
          const context = ENGINE.buildContext(rt.history, rt.history.length - 1);
          const signal = this.chooseSignal(context, { ...user.bot, ...settings });
          const pct = Math.min(RISK.POLICY.maxTradeRiskPct, settings.riskPerTrade);
          const base = Math.min(body.account.balance, body.account.equity, settings.compoundProfits ? Infinity : staged.ledger.startBalance);
          const daily = Math.max(0, Math.min(staged.ledger.dayStartBalance * 0.03, settings.dailyLossLimit || Infinity) + staged.ledger.dayPnl);
          const chosen = settings.maxLossPerTrade || Infinity;
          const budget = Math.min(1, base * pct / 100, daily, risk.headroom, chosen);
          const plan = planOrder(signal, body.quote, body.account, budget, settings);
          if (plan) {
            command = { ...plan, protocol: PROTOCOL, id: crypto.randomBytes(12).toString('hex'),
              login: staged.login, server: staged.server, sessionId: body.sessionId, demoOnly: true, createdAt: Date.now(), expiresAt: Date.now() + COMMAND_MS };
            staged.orders.unshift({ ...command, command: structuredClone(command), status: 'delivered', risk: budget, at: Date.now() });
            staged.lastEntryAt = Date.now();
          } else reason = signal ? 'mt5-minimum-lot-exceeds-risk' : 'mt5-no-signal';
        }
        staged.waitingReason = reason;
        if (['durable-storage-required', 'mt5-real-orders-disabled'].includes(reason)) staged.mode = 'monitor';
      }
      // Keep every unresolved reservation. Retired display rows are bounded.
      let retired = 0;
      staged.orders = staged.orders.filter(o => UNRESOLVED.has(o.status) || ++retired <= CLOSED_CAP);
      staged.instanceId = body.instanceId; staged.sequence = body.sequence;
      staged.agentSessionId = body.sessionId; staged.agentLeaseUntil = Date.now() + 20000;
      staged.lastSeenAt = Date.now(); staged.lastPayloadHash = digest;
      const reconcile = staged.orders.filter(o => ['delivered', 'uncertain'].includes(o.status) && o.command && o.id !== command?.id).map(o => o.command);
      staged.lastReply = { protocol: PROTOCOL, ack, command, reconcile, mode: staged.mode,
        reason: staged.waitingReason, liveEnabled: false };
      user.mt5 = staged;
      // Heartbeats/quote changes are memory-only. Persist authority, money,
      // reservations, mode and exposure transitions before acknowledging them.
      // A quiet 1 Hz terminal must not rewrite the whole private DB every second.
      try { if (durableFingerprint(m) !== durableFingerprint(staged)) await this.persist(); }
      catch (error) { user.mt5.mode = 'monitor'; user.mt5.waitingReason = 'risk-state-unavailable'; throw new Mt5Error('risk-state-unavailable', 503); }
      const reply = structuredClone(staged.lastReply);
      reply.mode = user.mt5.mode; reply.reason = user.mt5.waitingReason;
      if (reply.command && (user.mt5.mode !== 'demo' || this.entryBlock(user) || reply.command.expiresAt < Date.now())) {
        reply.reconcile.push(reply.command); reply.command = null;
      }
      return reply;
    } finally { this.busy.delete(user.id); }
  }
}
module.exports = { DEFAULT_SETTINGS, settingsFor, Mt5Bridge, Mt5Error, PROTOCOL, FRESH_MS, COMMAND_MS, exposure, restored,
  planOrder, validQuote, freshQuote, validAccount, hash };
