'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = name => fs.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8');

test('dashboard has one bronze palette and matching browser theme metadata', () => {
  const css = read('styles.css'), html = read('index.html'), manifest = JSON.parse(read('site.webmanifest'));
  assert.equal((css.match(/:root\s*\{[^}]*--bg:/g) || []).length, 1, 'old competing skins must not return');
  assert.match(css, /Savanna Bronze/i);
  const definitions = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
  for (const [, name] of css.matchAll(/var\((--[\w-]+)/g)) assert.ok(definitions.has(name), `undefined theme variable ${name}`);
  assert.doesNotMatch(css, /LAGOON BLUE EDITION|MEDIUM-TONE COMFORT PASS/);
  assert.equal(manifest.theme_color, '#633b25');
  assert.match(html, /<meta name="theme-color" content="#633b25">/);
  assert.match(html, /id="sidebar-close"[^>]*aria-label="Close navigation"/);
  assert.match(html, /Practice execution\. Real-money orders are disabled\./);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.sidebar\s*\{[^}]*position: fixed/);
});

test('mobile navigation manages focus, inert content and expansion without hiding desktop navigation', () => {
  function element() {
    return { attrs: {}, inert: false, classes: new Set(), focused: false,
      setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
      focus() { this.focused = true; },
      classList: { toggle(k, active) { active ? this.owner.classes.add(k) : this.owner.classes.delete(k); } } };
  }
  const nodes = Object.fromEntries(['#sidebar', '#menu-btn', '#main-content', '#sidebar-scrim'].map(id => [id, element()]));
  const body = element();
  for (const n of [...Object.values(nodes), body]) n.classList.owner = n;
  const first = element(); nodes['#sidebar'].querySelector = () => first;
  const mobileNav = { matches: true };
  const sandbox = { $: id => nodes[id], document: { body }, mobileNav };
  vm.createContext(sandbox);
  const source = read('app.js'), start = source.indexOf('function setSidebarOpen(');
  const end = source.indexOf("$('#menu-btn').onclick", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end) + '\nglobalThis.setOpen = setSidebarOpen;', sandbox);
  sandbox.setOpen(true);
  assert.equal(nodes['#menu-btn'].attrs['aria-expanded'], 'true');
  assert.equal(nodes['#sidebar'].attrs.role, 'dialog');
  assert.equal(nodes['#sidebar'].attrs['aria-modal'], 'true');
  assert.equal(nodes['#main-content'].inert, true);
  assert.equal(nodes['#sidebar'].inert, false);
  assert.equal(first.focused, true);
  sandbox.setOpen(false, true);
  assert.equal(nodes['#sidebar'].inert, true);
  assert.equal(nodes['#main-content'].inert, false);
  assert.equal(nodes['#menu-btn'].attrs['aria-expanded'], 'false');
  assert.equal(nodes['#menu-btn'].focused, true);
  assert.equal(nodes['#sidebar'].attrs.role, undefined);
  assert.equal(body.classes.has('nav-open'), false);
  mobileNav.matches = false;
  sandbox.setOpen(true);
  assert.equal(nodes['#sidebar'].inert, false, 'desktop navigation remains interactive');
  assert.equal(nodes['#main-content'].inert, false);
  assert.equal(nodes['#menu-btn'].attrs['aria-expanded'], 'false');
});

test('all horizontal trade tables are named, keyboard-scrollable regions', () => {
  const tables = [...read('index.html').matchAll(/<div class="table-scroll"[^>]*>/g)];
  assert.equal(tables.length, 6);
  const names = new Set();
  for (const [tag] of tables) {
    assert.match(tag, /tabindex="0"/);
    assert.match(tag, /role="region"/);
    const name = tag.match(/aria-label="([^"]+)"/)?.[1];
    assert.ok(name && !names.has(name)); names.add(name);
  }
});

test('dialogs block background controls, contain keyboard focus and restore the opener on cancellation', () => {
  const document = { activeElement: null };
  function element(hidden = false) {
    const classes = new Set(hidden ? ['hidden'] : []);
    return { inert: false, innerHTML: '', tabIndex: 0, isConnected: true,
      classList: { contains: k => classes.has(k), add: k => classes.add(k), remove: k => classes.delete(k),
        toggle(k, on) { on ? classes.add(k) : classes.delete(k); } },
      focus() { document.activeElement = this; }, getClientRects: () => [{}] };
  }
  const nodes = Object.fromEntries(['#app', '#auth-screen', '#modal', '#manual-overlay', '#modal-content', '#modal-close', '#manual-title'].map(id => [id, element(id === '#modal' || id === '#manual-overlay')]));
  const opener = element(), first = element(), last = element();
  document.body = element(); document.activeElement = opener;
  nodes['#modal-content input, #modal-content select, #modal-content button'] = first;
  nodes['#modal'].querySelectorAll = () => [first, last];
  const sandbox = { $: id => nodes[id], document };
  vm.createContext(sandbox);
  const source = read('app.js'), start = source.indexOf('let modalDismiss = null'), end = source.indexOf('\nfunction stopPolling()', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end) + '\nglobalThis.show = modal; globalThis.close = closeModal; globalThis.trap = trapOverlayFocus;', sandbox);
  sandbox.show('<p>Confirm paper execution</p>');
  assert.equal(nodes['#app'].inert, true);
  assert.equal(nodes['#auth-screen'].inert, true);
  assert.equal(document.activeElement, first);
  assert.equal(document.body.classList.contains('modal-open'), true);
  let prevented = false;
  document.activeElement = last;
  sandbox.trap({ key: 'Tab', shiftKey: false, preventDefault() { prevented = true; } }, nodes['#modal']);
  assert.equal(prevented, true); assert.equal(document.activeElement, first);
  vm.runInContext('modalDismiss = () => { globalThis.dismissals = (globalThis.dismissals || 0) + 1; };', sandbox);
  sandbox.close(); sandbox.close();
  assert.equal(sandbox.dismissals, 1, 'cancel callback fires exactly once');
  assert.equal(document.activeElement, opener);
  assert.equal(nodes['#app'].inert, false);
  assert.equal(nodes['#auth-screen'].inert, false);
  assert.equal(document.body.classList.contains('modal-open'), false);
  nodes['#manual-overlay'].classList.remove('hidden');
  sandbox.show('<p>Administrator dialog</p>');
  assert.equal(nodes['#manual-overlay'].inert, true);
  sandbox.close();
  assert.equal(nodes['#app'].inert, true, 'an underlying manual still blocks the workspace');
  assert.equal(nodes['#manual-overlay'].inert, false);
  assert.equal(document.activeElement, nodes['#manual-title']);
});
