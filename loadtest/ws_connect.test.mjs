import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('./ws_connect.js', import.meta.url), 'utf8');
async function harness(overrides = {}, environment = {}) {
  const state = { login: { success: true, data: { access_token: 'fixture-access' } }, ticket: { success: true, data: { ticket: 'fixture-ticket' } }, status: 200, completeHold: true, connectError: false, ...overrides };
  const requests = [], connections = [], checks = [], sleeps = [], metrics = new Map();
  const context = vm.createContext({ __ENV: { PASSWORD: randomUUID(), WS_VUS: '1', HOLD_SECONDS: '2', ...environment }, __VU: 1, __ITER: 0 });
  const http = { post: url => {
    requests.push(url);
    const body = url.endsWith('/login') ? state.login : state.ticket;
    return { status: state.status, json: selector => selector.split('.').reduce((value, key) => value?.[key], body) };
  } };
  const ws = { connect: (url, _options, callback) => {
    connections.push(url);
    if (state.connectError) throw new Error("fixture connect failure");
    const handlers = new Map();
    callback({ on: (event, handler) => handlers.set(event, handler), setInterval: () => {}, setTimeout: fn => { if (state.completeHold) fn(); }, close: () => {}, send: () => {} });
    handlers.get('open')?.();
    return { status: 101 };
  } };
  const check = (value, assertions) => {
    const results = Object.entries(assertions).map(([name, predicate]) => ({ name, passed: !!predicate(value) }));
    checks.push(...results); return results.every(result => result.passed);
  };
  class Counter { constructor(name) { this.name = name; metrics.set(name, 0); } add(value) { metrics.set(this.name, metrics.get(this.name) + value); } }
  const exports = { 'k6/http': { default: http }, 'k6/ws': { default: ws }, 'k6': { check, sleep: value => sleeps.push(value) }, 'k6/metrics': { Counter } };
  const module = new vm.SourceTextModule(source, { context });
  await module.link(specifier => new vm.SyntheticModule(Object.keys(exports[specifier]), function () {
    for (const [key, value] of Object.entries(exports[specifier])) this.setExport(key, value);
  }, { context }));
  await module.evaluate();
  return { state, requests, connections, checks, metrics, sleeps, context, options: module.namespace.options, run: module.namespace.default };
}

test('real API envelopes must reach one-time ticket and websocket handshake', async () => {
  const h = await harness(); h.run();
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.connections, ['ws://localhost:9090/ws?ticket=fixture-ticket']);
  assert.ok(h.checks.every(check => check.passed));
});

for (const login of [{ success: true, data: {} }, { success: true, data: { access_token: '' } }, { success: true, data: { access_token: 42 } }, { success: false, data: { access_token: 'fixture-access' } }]) {
  test(`HTTP 200 without a valid access token must fail the load checks (${JSON.stringify(login)})`, async () => {
    const h = await harness({ login }); h.run();
    assert.equal(h.connections.length, 0);
    assert.ok(h.checks.some(check => !check.passed));
  });
}

test('HTTP 200 without a valid one-use ticket must fail instead of silently skipping websocket', async () => {
  const h = await harness({ ticket: { success: true, data: {} } }); h.run();
  assert.equal(h.requests.length, 2);
  assert.equal(h.connections.length, 0);
  assert.ok(h.checks.some(check => !check.passed));
});

test('the load profile requires at least one measured successful handshake', async () => {
  const h = await harness();
  assert.deepEqual(Array.from(h.options.thresholds.ws_handshakes_succeeded ?? []), ['count>0', 'count==1']);
});

test('connection errors and early closure cannot produce a green load result', async () => {
  for (const state of [{ connectError: true }, { completeHold: false }]) {
    const h = await harness(state);
    assert.doesNotThrow(() => h.run());
    assert.ok(h.checks.some(check => !check.passed));
    assert.equal(h.metrics.get('ws_handshakes_succeeded'), state.connectError ? 0 : 1);
    assert.equal(h.metrics.get('ws_sessions_succeeded'), 0);
  }
});

test('a VU repeats no login or connection after its first measured session', async () => {
  const h = await harness(); h.run();
  h.context.__ITER = 1; h.run();
  assert.equal(h.connections.length, 1);
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.sleeps, [1]);
  assert.equal(h.metrics.get('ws_handshakes_succeeded'), 1);
});

for (const [name, value] of [['WS_VUS', '0'], ['WS_VUS', '2garbage'], ['HOLD_SECONDS', '-1'], ['HOLD_SECONDS', 'Infinity'], ['USER_COUNT', '1.5']]) {
  test(`invalid numeric configuration fails before network activity: ${name}=${value}`, async () => {
    await assert.rejects(harness({}, { [name]: value }), new RegExp(`${name} must be a positive integer`));
  });
}
