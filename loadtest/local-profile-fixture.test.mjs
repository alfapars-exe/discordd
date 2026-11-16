import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { once } from 'node:events';
import { readLocalConfig, validateLocalFixture, snapshotSources, assertSnapshotUnchanged,
  spawnOwned, joinOwnedProcesses, openProfileLog, finishProfileLog, captureProbeResult } from './local-profile-fixture.mjs';

function fixture(t) {
  const tempDir = mkdtempSync(join(tmpdir(), 'hichat-local-profile-contract-'));
  // Contract-owned temporary directory only; no workspace links are created.
  t.after(() => {
    assert.equal(dirname(resolve(tempDir)), resolve(tmpdir()));
    assert.ok(basename(tempDir).startsWith('hichat-local-profile-contract-'));
    rmSync(tempDir, { recursive: true, force: true });
  });
  const source = join(tempDir, 'source');
  for (const dir of ['server', 'e2e/scripts', 'loadtest']) mkdirSync(join(source, dir), { recursive: true });
  for (const file of ['server/go.mod', 'e2e/scripts/pg-fixture.go', 'loadtest/ws_connect.js']) {
    writeFileSync(join(source, file), 'contract-only input\n');
  }
  const sourceCommit = 'a'.repeat(40), ownerLabel = 'local-fanout-' + 'b'.repeat(32);
  writeFileSync(join(tempDir, 'owner.json'), JSON.stringify({ sourceCommit, label: ownerLabel }));
  const dsn = new URL('postgres://hichat_tls_test:private-fixture-value@127.0.0.1:54321/hichat_e2e_control');
  dsn.searchParams.set('sslmode', 'verify-full');
  for (const [key, leaf] of [['sslrootcert', 'ca.crt'], ['sslcert', 'client.crt'], ['sslkey', 'client.key']]) {
    dsn.searchParams.set(key, join(tempDir, leaf));
  }
  const config = { tempDir, source, sourceCommit, ownerLabel, container: 'owned-container',
    containerID: 'c'.repeat(64), controlDSN: dsn.toString(), goBinary: 'go', k6: 'k6' };
  const container = { Id: config.containerID, State: { Running: true },
    Config: { Labels: { 'hichat.task': ownerLabel } },
    NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '54321' }] } } };
  const validate = (c = config, inspected = container) => validateLocalFixture(c, {
    platform: 'win32', inspect: () => inspected,
  });
  return { config, container, validate, source, tempDir };
}

test('owned running loopback mTLS fixture is accepted', t => {
  const { validate } = fixture(t);
  assert.doesNotThrow(() => validate());
});

test('private config parsing is bounded and errors never echo malformed credentials', t => {
  const { tempDir, config } = fixture(t);
  const path = join(tempDir, 'private.json');
  writeFileSync(path, JSON.stringify(config));
  assert.deepEqual(readLocalConfig(path), config);
  for (const data of ['private-fixture-value{', ' '.repeat(32769)]) {
    writeFileSync(path, data);
    assert.throws(() => readLocalConfig(path), /^Error: Invalid owned local profile fixture$/);
  }
});

test('foreign database, TLS weakening and duplicate DSN options fail before Docker access', t => {
  const { config } = fixture(t);
  for (const mutate of [
    u => { u.hostname = 'example.test'; },
    u => { u.pathname = '/production'; },
    u => { u.searchParams.set('sslmode', 'disable'); },
    u => { u.searchParams.append('sslmode', 'verify-full'); },
    u => { u.searchParams.set('sslkey', join(config.tempDir, '..', 'foreign.key')); },
    u => { u.searchParams.set('options', '-c search_path=foreign'); },
  ]) {
    const dsn = new URL(config.controlDSN); mutate(dsn);
    let inspected = false;
    assert.throws(() => validateLocalFixture({ ...config, controlDSN: dsn.toString() }, {
      platform: 'win32', inspect: () => { inspected = true; },
    }), /^Error: Invalid owned local profile fixture$/);
    assert.equal(inspected, false);
  }
});

test('container identity, label, liveness and published loopback port must all match', t => {
  const { validate, container } = fixture(t);
  for (const mutate of [
    c => { c.Id = 'd'.repeat(64); },
    c => { c.Config.Labels['hichat.task'] = 'unrelated'; },
    c => { c.State.Running = false; },
    c => { c.NetworkSettings.Ports['5432/tcp'][0].HostIp = '0.0.0.0'; },
    c => { c.NetworkSettings.Ports['5432/tcp'][0].HostPort = '54322'; },
  ]) {
    const other = structuredClone(container); mutate(other);
    assert.throws(() => validate(undefined, other), /Invalid owned local profile fixture/);
  }
});

test('source directory, owner marker, platform and unknown config fields cannot bypass ownership', t => {
  const { validate, config, tempDir } = fixture(t);
  assert.throws(() => validate({ ...config, source: tempDir }), /Invalid owned local/);
  assert.throws(() => validate({ ...config, unknown: true }), /Invalid owned local/);
  assert.throws(() => validateLocalFixture(config, { platform: 'linux' }), /Invalid owned local/);
  writeFileSync(join(tempDir, 'owner.json'), JSON.stringify({ label: 'foreign', sourceCommit: config.sourceCommit }));
  assert.throws(() => validate(), /Invalid owned local/);
});

test('configuration errors never disclose the private DSN or underlying Docker error', t => {
  const { config } = fixture(t);
  assert.throws(() => validateLocalFixture(config, { platform: 'win32', inspect() {
    throw new Error(config.controlDSN);
  } }), error => error.message === 'Invalid owned local profile fixture' && !error.message.includes('private-fixture-value'));
});

test('source snapshots detect added, removed and edited inputs without hashing generated output', t => {
  const { source, tempDir } = fixture(t);
  const before = snapshotSources(source);
  writeFileSync(join(tempDir, 'result.json'), '{}');
  assert.doesNotThrow(() => assertSnapshotUnchanged(before, snapshotSources(source)));
  const added = join(source, 'server', 'new.go'); writeFileSync(added, 'new input');
  assert.throws(() => assertSnapshotUnchanged(before, snapshotSources(source)), /source changed/);
  rmSync(added);
  assert.doesNotThrow(() => assertSnapshotUnchanged(before, snapshotSources(source)));
  writeFileSync(join(source, 'loadtest/ws_connect.js'), 'edited input');
  assert.throws(() => assertSnapshotUnchanged(before, snapshotSources(source)), /source changed/);
  writeFileSync(join(source, 'loadtest/ws_connect.js'), 'contract-only input\n');
  assert.doesNotThrow(() => assertSnapshotUnchanged(before, snapshotSources(source)));
  rmSync(join(source, 'server/go.mod'));
  assert.throws(() => assertSnapshotUnchanged(before, snapshotSources(source)), /source changed/);
});

test('source snapshot refuses a junction or symlink even when its target is readable', t => {
  const { source, tempDir } = fixture(t);
  const target = join(tempDir, 'outside-source'); mkdirSync(target);
  writeFileSync(join(target, 'foreign.txt'), 'must not be followed');
  symlinkSync(target, join(source, 'server', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => snapshotSources(source), /source contains a filesystem link/);
});

test('cleanup joins both real owned children before resolving', async () => {
  const children = [1, 2].map(() => spawnOwned(process.execPath,
    ['-e', 'console.log("ready");setInterval(()=>{},1000)'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
  await Promise.all(children.map(child => once(child.stdout, 'data')));
  await joinOwnedProcesses(children);
  assert.ok(children.every(child => child.stdout.closed && child.stderr.closed));
});

test('unregistered-process error cannot skip cleanup of another owned child', async () => {
  const child = spawnOwned(process.execPath, ['-e', 'console.log("ready");setInterval(()=>{},1000)'],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  await once(child.stdout, 'data');
  await assert.rejects(joinOwnedProcesses([{}, child]), error => {
    assert.equal(error.errors[0].message, 'Refusing to manage an unregistered process');
    return true;
  });
  assert.ok(child.stdout.closed && child.stderr.closed);
});

test('executable start failure stays observable without leaking arguments', async t => {
  const { tempDir } = fixture(t);
  const child = spawnOwned(join(tempDir, 'absent-executable'), ['private-argument'],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  await assert.rejects(joinOwnedProcesses([child]), error => {
    assert.equal(error.errors[0].message, 'Owned process failed to start');
    return true;
  });
});

test('profile log completion flushes output before resolving', async t => {
  const { tempDir } = fixture(t);
  const path = join(tempDir, 'output.log');
  let failures = 0;
  const log = openProfileLog(path, () => { failures++; });
  log.write('complete fixture output');
  await finishProfileLog(log);
  assert.equal(readFileSync(path, 'utf8'), 'complete fixture output');
  assert.equal(failures, 0);
});

test('log open/write failure is observed and cannot masquerade as flushed output', async t => {
  const { tempDir } = fixture(t);
  let failures = 0;
  const log = openProfileLog(join(tempDir, 'missing', 'output.log'), () => { failures++; });
  const failed = once(log, 'error');
  log.write('output');
  await failed;
  assert.equal(failures, 1);
  await assert.rejects(finishProfileLog(log), /^Error: Profile log write failed$/);
});

test('probe close callback keeps valid events and makes disk failure observable without throwing', t => {
  const { tempDir } = fixture(t);
  const event = { event: 'finished', reason: 'write_failed' };
  const input = { exitCode: 0, text: JSON.stringify(event) + '\n', stderrPresent: false };
  const outputPath = join(tempDir, 'probe.json');
  const captured = captureProbeResult({ ...input, outputPath });
  assert.equal(captured.failed, false);
  assert.deepEqual(JSON.parse(readFileSync(outputPath, 'utf8')).events, [event]);
  const failed = captureProbeResult({ ...input, outputPath: join(tempDir, 'missing', 'probe.json') });
  assert.equal(failed.failed, true);
  assert.equal(failed.result.reportWriteFailed, true);
  assert.deepEqual(failed.result.events, [event]);
});

test('malformed probe output cannot become a successful close result', t => {
  const { tempDir } = fixture(t);
  const captured = captureProbeResult({ exitCode: 0, text: 'malformed fixture output',
    stderrPresent: false, outputPath: join(tempDir, 'probe.json') });
  assert.equal(captured.failed, true);
  assert.deepEqual(captured.result.events, []);
});
