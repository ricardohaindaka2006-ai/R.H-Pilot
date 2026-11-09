'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const os = require('node:os');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhpilot-risk-'));
process.env.DATA_DIR = dir;
process.env.DERIV_WS_URL = 'ws://127.0.0.1:1';
const app = require('../server.js'), I = app._internals, P = I.ENGINE.EXECUTION;
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const signal = { strategy: 'breakout-momentum', dir: 1, confidence: 0.9, atr: 1,
  tpDist: 6, slDist: 2, hold: 20, be: 0.99 };
function fresh(balance = 2) {
  const user = { id: 'risk-user', email: 'risk@test.local', role: 'admin', active: true,
    paid: true, deriv: null, bot: app.applyPreset(app.defaultBot(), 'safe', balance) };
  I.db = { users: [user], sessions: {}, config: I.DEFAULT_CONFIG() };
  I.hist.XAUUSD = [];
  I.market.XAUUSD = { price: 100, source: 'sim', at: Date.now(), epoch: Math.floor(Date.now() / 1000) };
  app.notePrice('XAUUSD', 100, 'sim');
  return user;
}
function risk(lots, distance = 2) { return lots * distance * app.pointValue('XAUUSD'); }
async function http(t, user) {
  I.db.sessions['risk-session'] = { userId: user.id, exp: Date.now() + 60000 };
  const server = app.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (route, body) => {
    const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: 'sid=risk-session' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  };
}

test('new accounts default to conservative, editable paper risk and earlier profit protection', () => {
  const b = app.defaultBot();
  assert.equal(b.preset, 'safe');
  assert.equal(b.riskPerTrade, 0.5);
  assert.equal(b.maxLossPerTrade, 0.5);
  assert.equal(b.dailyLossLimit, 3);
  assert.equal(b.maxTrades, 1);
  assert.equal(b.maxEntriesPerSession, 0, 'zero keeps the default paper run uncapped');
  assert.equal(b.sessionEntries, 0);
  assert.equal(b.aggression, 3);
  assert.equal(b.autoRisk, true);
  assert.equal(b.compoundProfits, true);
  assert.equal(b.lockInProfit, true);
  assert.equal(b.trailing, true);
  assert.equal(b.lockAfterR, 0.5);
  assert.equal(b.trailAfterR, 1);
  assert.equal(b.trailByR, 0.35);
  assert.equal(b.strategy, 'auto');
  assert.equal(b.live, false);
});

test('a $2 paper account starts at one-cent risk and compounds only up to $1 planned risk', () => {
  const user = fresh(), b = user.bot;
  assert.equal(b.maxLossPerTrade, 0.01);
  assert.equal(b.dailyLossLimit, 0.06);
  app.rollDay(b);
  for (const balance of [2, 5, 10, 100, 1000, 100000]) {
    b.balance = balance; b.profit = balance - b.startBalance; b.dayPnl = b.profit;
    const budget = Math.min(1, balance * 0.005);
    assert.ok(Math.abs(app.riskBudgetFor(b) - budget) < 1e-10);
    const lots = app.sizeFor(user, b, 100, 1, 2);
    assert.ok(risk(lots) <= budget, 'lot rounding cannot overspend a small balance');
    assert.ok(risk(lots) >= budget * 0.98);
    assert.equal(b.riskPerTrade, 0.5, 'growth must not silently raise the percentage');
  }
});

test('compounding is optional and disabling it still reduces size after drawdown', () => {
  const user = fresh(), b = user.bot;
  b.dailyLossLimit = 0; // isolate compounding from the independent daily ledger
  const initial = app.sizeFor(user, b, 100, 1, 2);
  b.balance = 10;
  const grown = app.sizeFor(user, b, 100, 1, 2);
  assert.ok(grown > initial);
  b.compoundProfits = false;
  const frozen = app.sizeFor(user, b, 100, 1, 2);
  assert.equal(frozen, initial);
  assert.equal(app.riskBudgetFor(b), 0.01);
  b.balance = 1;
  assert.equal(app.riskBudgetFor(b), 0, 'the drawdown rail overrides compounding settings');
  assert.equal(b.risk.drawdownLatched, true);
  // Independently check a small, sub-rail drawdown; do not clear the old latch.
  const other = fresh(), c = other.bot;
  c.compoundProfits = false; c.balance = 1.99;
  assert.ok(app.sizeFor(other, c, 100, 1, 2) < initial);
  assert.equal(app.riskBudgetFor(c), 0.00995);
});

test('fractional and fixed paper lots never round up past the affordable budget', () => {
  for (const balance of [0.01, 2, 2.3456, 25, 100, 1000]) {
    for (const distance of [0.000123, 0.04, 0.7, 2, 1337.5, 50000]) {
      const user = fresh(balance), b = user.bot;
      const budget = app.riskBudgetFor(b);
      for (const autoRisk of [true, false]) {
        b.autoRisk = autoRisk; b.lots = 0.12345678;
        const lots = app.sizeFor(user, b, 100000, 1, distance);
        assert.ok(Number.isFinite(lots) && lots >= 0 && lots <= 50);
        assert.ok(risk(lots, distance) <= budget,
          `${balance} balance / ${distance} stop / ${autoRisk}: ${risk(lots, distance)} > ${budget}`);
        assert.ok(autoRisk || lots <= b.lots);
      }
    }
  }
});

test('an unaffordable minimum paper clip is skipped, never rounded up or treated as a broker minimum', () => {
  const user = fresh(), b = user.bot;
  assert.ok(app.sizeFor(user, b, 100000, 1, 500) > 0, 'affordable fractions may trade in paper');
  assert.equal(app.sizeFor(user, b, 100000, 1, 50000), 0);
  b.running = true;
  b.pendingEntry = { source: 'sim', at: Date.now(), signal: { ...signal, slDist: 50000 } };
  I.market.XAUUSD.price = 100000;
  app.notePrice('XAUUSD', 100000, 'sim');
  app.evaluate(user);
  assert.equal(b.positions.length, 0);
  assert.equal(b.closedTrades, 0);
  assert.equal(b.balance, 2);
  assert.equal(b.waitingReason, 'risk-budget-below-minimum-paper-size');
});

test('an orderly $2 losing sequence respects pauses, shrinks size and exhausts the daily reserve without martingale', () => {
  const originalNow = Date.now;
  let clock = Date.UTC(2026, 10, 8, 12); Date.now = () => clock;
  try {
    const user = fresh(), b = user.bot;
    b.running = true; b.startedAt = Date.now();
    let previous = Infinity, losses = 0, pauses = 0;
    for (; losses < 20; losses++) {
      if (b.risk.pauseUntil > clock) {
        assert.equal(app.sizeFor(user, b, 100, 1, 2), 0, 'no recovery trade during a loss pause');
        clock = b.risk.pauseUntil + 1; pauses++;
      }
      const lots = app.sizeFor(user, b, 100, 1, 2);
      if (!lots) break;
      assert.ok(lots <= previous, 'a loss must not trigger a larger recovery bet');
      previous = lots;
      const planned = risk(lots);
      b.positions = [{ ...P.paperPosition(signal, 100, { spreadAtr: 0, slippageAtr: 0 }),
        id: 'loss-' + losses, marketSource: 'sim', lots, plannedRiskCash: planned }];
      I.market.XAUUSD = { price: 98, source: 'sim', at: clock };
      app.notePrice('XAUUSD', 98, 'sim');
      const pnl = app.closePos(user, 0, 98, 'stop-loss');
      assert.ok(Math.abs(pnl + planned) < 1e-12, 'ordinary stops book their actual fill loss');
      assert.equal(b.riskPerTrade, 0.5);
      assert.ok(b.balance >= 1.94 - 1e-10);
    }
    assert.ok(losses >= 6 && losses < 20);
    assert.ok(pauses > 0);
    assert.equal(app.sizeFor(user, b, 100, 1, 2), 0);
    assert.equal(b.closedLosses, losses);
    assert.equal(b.closedWins, 0);
    assert.ok(app.dailyLossBudget(b) < 0.000002, 'not enough daily reserve for one minimum clip');
    assert.ok(Math.abs(b.balance - (2 + b.profit)) < 1e-12);
    // Orderly fills only. Separate gap tests must still book unbounded actual losses.
  } finally { Date.now = originalNow; }
});

test('HTTP settings validate atomically, clear queued entries, and leave old exit snapshots unchanged', async t => {
  const user = fresh(), b = user.bot, request = await http(t, user);
  const oldPosition = { ...P.paperPosition(signal, 100), id: 'saved', lots: 0.00001, strategy: signal.strategy };
  b.positions = [oldPosition];
  b.sessionEntries = 2;
  const oldExit = { ...oldPosition.exitSettings };
  b.pendingEntry = { source: 'sim', at: Date.now(), signal };
  const before = JSON.stringify(b);
  for (const route of ['/api/bot/settings', '/api/bot/start']) {
    for (const invalid of [{ lockAfterR: 0.5, trailAfterR: 0.3 }, { lockAfterR: 1.1 },
      { trailByR: 0 }, { compoundProfits: 'false' }, { trailing: 'true' },
      { maxEntriesPerSession: -1 }, { maxEntriesPerSession: 1.5 }, { maxEntriesPerSession: 1001 }]) {
      const result = await request(route, invalid);
      assert.equal(result.status, 400);
      assert.equal(JSON.stringify(b), before, 'invalid settings must not close, restart or partly mutate the bot');
    }
  }
  const changed = await request('/api/bot/settings', {
    preset: 'custom', lockAfterR: 0.7, trailAfterR: 1.4, trailByR: 0.25, compoundProfits: false,
    trailing: false, riskPerTrade: 0.25, maxEntriesPerSession: 3
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.data.bot.preset, 'custom');
  assert.equal(b.compoundProfits, false);
  assert.equal(b.trailing, false);
  assert.equal(b.riskPerTrade, 0.25);
  assert.equal(b.maxEntriesPerSession, 3);
  assert.equal(b.sessionEntries, 2, 'editing settings never resets the current run count');
  assert.equal(b.pendingEntry, null);
  assert.deepEqual(oldPosition.exitSettings, oldExit);
  const next = P.paperPosition(signal, 100, b);
  assert.equal(next.exitSettings.lockAfterR, 0.7);
  assert.equal(next.exitSettings.trailAfterR, 1.4);
  assert.equal(next.exitSettings.trailByR, 0.25);
  assert.equal(next.exitSettings.trailing, false);
  const preset = await request('/api/bot/settings', { preset: 'aggressive', strategy: 'breakout-momentum' });
  assert.equal(preset.status, 200);
  assert.equal(b.strategy, 'breakout-momentum', 'explicit valid overrides are consistent with start');
  assert.equal(b.compoundProfits, true);
  assert.equal(b.trailing, true);
  assert.equal(b.riskPerTrade, 1.5);
  assert.deepEqual(oldPosition.exitSettings, oldExit);
});

test('HTTP starts $2 with proportional defaults and accepts explicit custom protection and compounding', async t => {
  const user = fresh(100), request = await http(t, user);
  const config = await request('/api/config/public');
  assert.equal(config.data.engine.riskPresets.safe.riskPerTrade, 0.5);
  assert.equal(config.data.engine.riskPresets.safe.dailyPct, 3);
  assert.equal(config.data.engine.maxTradeRiskPct, 1.5);
  assert.equal(config.data.engine.maxOpenRiskPct, 3);
  const started = await request('/api/bot/start', { startBalance: 2, maxEntriesPerSession: 2 });
  assert.equal(started.status, 200);
  assert.equal(started.data.bot.balance, 2);
  assert.equal(started.data.bot.riskPerTrade, 0.5);
  assert.equal(started.data.bot.liveCap, 0.01);
  assert.equal(started.data.bot.plannedEntryRisk, 0.01);
  assert.equal(started.data.bot.liveDailyLimit, 0.06);
  assert.equal(started.data.bot.maxTrades, 1);
  assert.equal(started.data.bot.maxEntriesPerSession, 2);
  assert.equal(started.data.bot.sessionEntries, 0);
  assert.ok(started.data.bot.sessionStartedAt > 0);
  assert.equal(started.data.bot.compoundProfits, true);
  user.bot.sessionEntries = 1; user.bot.sessionStartedAt = Date.now() - 1000;
  const custom = await request('/api/bot/start', { preset: 'custom', compoundProfits: false,
    lockAfterR: 0.75, trailAfterR: 1.5, trailByR: 0.4, riskPerTrade: 0.25, trailing: false,
    maxEntriesPerSession: 1 });
  assert.equal(custom.status, 200);
  assert.equal(custom.data.bot.preset, 'custom');
  assert.equal(custom.data.bot.compoundProfits, false);
  assert.equal(custom.data.bot.trailing, false);
  assert.equal(custom.data.bot.lockAfterR, 0.75);
  assert.equal(custom.data.bot.trailAfterR, 1.5);
  assert.equal(custom.data.bot.trailByR, 0.4);
  assert.equal(custom.data.bot.maxEntriesPerSession, 1);
  assert.equal(custom.data.bot.sessionEntries, 0, 'an explicit Start creates a fresh counted run');
  assert.equal(custom.data.bot.balance, 2);
  assert.equal(custom.data.bot.plannedEntryRisk, 0.005);
  assert.equal(custom.data.bot.live, false);
});

test('Start queues a ready signal for the next fresh tick and never same-tick fills it', async t => {
  const user = fresh(100), request = await http(t, user), base = I.SIM.XAUUSD.price;
  const step = base * 0.00015;
  I.hist.XAUUSD = Array.from({ length: 119 }, (_, i) => base + i * step);
  I.hist.XAUUSD.push(base + 118 * step + step * 2.5);
  const quote = I.hist.XAUUSD.at(-1), at = Date.now();
  I.market.XAUUSD = { price: quote, source: 'sim', at, epoch: Math.floor(at / 1000) };
  assert.ok(I.chooseSignal(I.marketContext('XAUUSD'), user.bot), 'the current tick has a ready paper signal');

  const started = await request('/api/bot/start', { startBalance: 100, strategy: 'breakout-momentum' });
  assert.equal(started.status, 200);
  assert.ok(user.bot.pendingEntry, 'Start carries forward a signal already available on the current quote');
  assert.equal(user.bot.positions.length, 0);
  app.evaluate(user);
  assert.equal(user.bot.positions.length, 0, 'the quote that produced the signal cannot also fill it');
  assert.ok(user.bot.pendingEntry);

  const nextAt = Date.now();
  I.market.XAUUSD = { ...I.market.XAUUSD, price: quote + 0.01, at: nextAt, epoch: Math.floor(nextAt / 1000) };
  app.notePrice('XAUUSD', I.market.XAUUSD.price, 'sim');
  app.evaluate(user);
  assert.equal(user.bot.positions.length, 1, 'the first subsequent fresh tick opens the queued paper entry');
  assert.equal(user.bot.sessionEntries, 1);
  assert.equal(user.bot.pendingEntry, null);
});

// Client-logic unit harness, not a full browser or DOM-layout test. It runs the
// actual form functions against minimal controls without adding dependencies.
function clientForm() {
  const user = fresh(), b = user.bot;
  const elements = {};
  for (const key of ['lots', 'tp', 'sl', 'maxTrades', 'maxEntriesPerSession', 'aggression', 'profitTarget', 'riskPerTrade',
    'maxLossPerTrade', 'dailyLossLimit', 'lockAfterR', 'trailAfterR', 'trailByR', 'preset', 'strategy', 'symbol']) {
    elements[key] = { value: String(b[key]), type: 'number', disabled: false };
  }
  for (const key of ['compoundProfits', 'autoRisk', 'lockInProfit', 'trailing']) {
    elements[key] = { type: 'checkbox', checked: b[key], disabled: false };
  }
  elements.startBalance = { value: '2', type: 'number' };
  const node = () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} } });
  const nodes = {
    '#quick-bot-form': { elements }, '#start-balance': elements.startBalance,
    '#preset-value': elements.preset, '#lots-input': elements.lots, '#risk-per-trade': elements.riskPerTrade,
    '#risk-output': node(), '#risk-note': node(), '#lots-note': node(), '#risk-pct-wrap': node(),
    '#preset-copy': node(), '#risk-profile': node()
  };
  let sent;
  const sandbox = {
    state: { bot: b, symbol: b.symbol, config: null },
    $: selector => nodes[selector], $$: () => [],
    setBusy() {}, updateBot() {}, renderSignal() {}, toast() {},
    confirmTrade: async () => true,
    api: async (route, { body }) => { sent = { route, body }; return { bot: { ...b, ...body }, signal: null }; },
    FormData: class {
      constructor(form) { this.form = form; }
      *[Symbol.iterator]() {
        for (const [key, input] of Object.entries(this.form.elements)) {
          if (input.disabled || (input.type === 'checkbox' && !input.checked)) continue;
          yield [key, input.type === 'checkbox' ? 'on' : String(input.value)];
        }
      }
    }
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const slice = (a, z) => source.slice(source.indexOf(a), source.indexOf(z, source.indexOf(a) + a.length));
  vm.createContext(sandbox);
  vm.runInContext(slice('function money(', 'function price(')
    + slice('const PRESETS =', '/* Balance detector.')
    + slice('function updateRiskProfile()', '/* Balance detector.')
    + slice('async function startEngine(', "$('#quick-bot-form').onsubmit")
    + '\nglobalThis.ui = { selectPreset, markCustomPreset, startEngine, updateRiskProfile };', sandbox);
  return { sandbox, elements, nodes, get sent() { return sent; } };
}

test('client presets source server settings and recalculate $2 budgets without dollar floors', () => {
  const { sandbox: s, elements: el, nodes } = clientForm();
  s.ui.selectPreset('safe');
  assert.equal(Number(el.riskPerTrade.value), 0.5);
  assert.equal(Number(el.maxLossPerTrade.value), 0.01);
  assert.equal(Number(el.dailyLossLimit.value), 0.06);
  assert.equal(Number(el.trailAfterR.value), 1);
  assert.equal(el.compoundProfits.checked, true);
  assert.match(nodes['#risk-profile'].innerHTML, /\$0\.01 per trade/);
  assert.match(nodes['#risk-profile'].innerHTML, /\$0\.06/);
  // A later server preset revision must not be overridden by the JS fallback.
  s.state.config = { engine: { riskPresets: { safe: { ...app.PRESETS.safe,
    riskPerTrade: 1, capPct: 1, dailyPct: 4 } } } };
  s.ui.selectPreset('safe');
  assert.equal(Number(el.riskPerTrade.value), 1);
  assert.equal(Number(el.maxLossPerTrade.value), 0.02);
  assert.equal(Number(el.dailyLossLimit.value), 0.08);
});

test('client start preserves custom profit-lock values and explicit false toggles', async () => {
  const c = clientForm(), s = c.sandbox, el = c.elements;
  s.ui.selectPreset('safe');
  s.ui.markCustomPreset();
  el.lockAfterR.value = '0.7'; el.trailAfterR.value = '1.4'; el.trailByR.value = '0.25';
  el.compoundProfits.checked = false; el.trailing.checked = false; el.riskPerTrade.value = '0.75';
  el.maxEntriesPerSession.value = '3';
  await s.ui.startEngine(null);
  assert.equal(c.sent.route, '/api/bot/start');
  const body = c.sent.body;
  assert.equal(body.preset, 'custom');
  assert.equal(body.startBalance, 2);
  assert.equal(body.compoundProfits, false);
  assert.equal(body.trailing, false);
  assert.equal(body.lockAfterR, 0.7);
  assert.equal(body.trailAfterR, 1.4);
  assert.equal(body.trailByR, 0.25);
  assert.equal(body.riskPerTrade, 0.75);
  assert.equal(body.maxLossPerTrade, 0.01);
  assert.equal(body.dailyLossLimit, 0.06);
  assert.equal(body.maxEntriesPerSession, 3);
});
