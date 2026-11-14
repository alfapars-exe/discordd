import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { qualityChecks, redactLog, runChecks, summarizeOutput } from './run-quality.mjs';

test('required failure is preserved while later checks still run; optional acceptance stays visible', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hichat-quality-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checks = ['failed', 'later', 'acceptance'].map((id) => ({ id, cwd: '.', command: 'fake', args: [], required: id !== 'acceptance' }));
  const calls = [];
  const source = { head: 'revision', sha256: 'manifest', files: [] };
  const report = runChecks(checks, { root, output: join(root, 'report.json'), snapshot: () => source, execute: (_command, _args, options) => {
    assert.equal(options.windowsHide, true);
    calls.push(calls.length);
    return { status: calls.length === 2 ? 0 : 1, stdout: 'Bearer disposable-value', stderr: '' };
  } });
  assert.equal(report.success, false);
  assert.equal(report.checks.length, 3);
  assert.equal(report.checks[1].status, 'passed');
  assert.equal(report.checks[2].required, false);
  assert.doesNotMatch(readFileSync(join(root, report.checks[0].log), 'utf8'), /disposable-value/);
});

test('source drift invalidates successful tests and identifies changed files', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hichat-quality-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let call = 0;
  const report = runChecks([{ id: 'test', cwd: '.', command: 'fake', args: [] }], {
    root, execute: () => ({ status: 0 }),
    snapshot: () => ({ head: 'revision', sha256: String(call), files: [{ path: 'source.ts', sha256: String(call++) }] }),
  });
  assert.equal(report.success, false);
  assert.equal(report.source_stable, false);
  assert.deepEqual(report.source_changed_paths, ['source.ts']);
});

test('timeout and absent process exit cannot become a pass', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hichat-quality-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = { head: 'revision', sha256: 'hash', files: [] };
  const report = runChecks([{ id: 'test', cwd: '.', command: 'fake', args: [] }], {
    root, snapshot: () => source, execute: () => ({ status: null, error: { code: 'ETIMEDOUT' } }),
  });
  assert.equal(report.success, false);
  assert.equal(report.checks[0].timed_out, true);
});

test('profiles reject typos and retain mandatory baseline checks', () => {
  assert.throws(() => qualityChecks('typo', 'npm-cli.js'), /Unknown/);
  const checks = qualityChecks('baseline', 'npm-cli.js');
  assert.ok(checks.find((check) => check.id === 'e2e'));
  assert.equal(checks.find((check) => check.id === 'acceptance-complete').required, false);
});

test('structured output reports tests rather than nested suite count', () => {
  assert.deepEqual(summarizeOutput({ id: 'client-test' }, '{"numTotalTestSuites":900,"numPassedTests":42,"numFailedTests":1,"numPendingTests":2}'), { passed: 42, failed: 1, skipped: 2 });
  assert.deepEqual(summarizeOutput({ id: 'server' }, '{"Action":"pass","Test":"TestOne"}\n{"Action":"skip","Test":"TestTwo"}'), { pass: 1, fail: 0, skip: 1 });
});

test('diagnostic redaction removes bearer and database credentials', () => {
  const result = redactLog('Authorization: Bearer disposable\npostgres://test:opaque@localhost/test password=opaque');
  assert.doesNotMatch(result, /disposable|opaque/);
});

test('empty run or missing structured results cannot produce green evidence', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hichat-quality-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => runChecks([], { root }), /at least one/);
  const source = { head: 'revision', sha256: 'hash', files: [] };
  const report = runChecks([{ id: 'client-test', command: 'fake', args: [], cwd: '.' }], {
    root, snapshot: () => source, execute: () => ({ status: 0, stdout: 'no test result' }),
  });
  assert.equal(report.success, false);
  assert.ok(report.checks[0].summary.reportError);
});

const clientResult = (overrides) => JSON.stringify({ numTotalTestSuites: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, ...overrides });
const invalidStructuredResults = [
 { name: 'client-only-skips', id: 'client-test', stdout: clientResult({ numPassedTests: 0, numPendingTests: 2 }) },
 { name: 'client-failure-with-zero-exit', id: 'client-test', stdout: clientResult({ numFailedTests: 1 }) },
 { name: 'client-suite-failure', id: 'client-test', stdout: clientResult({ numFailedTestSuites: 1 }) },
 { name: 'client-explicit-unsuccessful', id: 'client-test', stdout: clientResult({ success: false }) },
 { name: 'client-negative-count', id: 'client-test', stdout: clientResult({ numPendingTests: -1, numPassedTests: 2 }) },
 { name: 'go-only-skips', id: 'server', stdout: '{"Action":"skip","Test":"TestRequiresEnvironment"}' },
 { name: 'go-incomplete-run', id: 'server', stdout: '{"Action":"run","Test":"TestStarted"}' },
 { name: 'go-failure-with-zero-exit', id: 'server', stdout: '{"Action":"pass","Test":"TestOne"}\n{"Action":"fail","Test":"TestTwo"}' },
 { name: 'go-package-teardown-failure', id: 'server', stdout: '{"Action":"pass","Test":"TestOne"}\n{"Action":"fail","Package":"fixture"}' },
];
for (const fixture of invalidStructuredResults) {
 test(`structured verdict rejects ${fixture.name} even with zero process exit`, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hichat-quality-verdict-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = { head: 'revision', sha256: 'source', files: [] };
  const report = runChecks([{ id: fixture.id, cwd: '.', command: 'fake', args: [] }], {
   root, snapshot: () => source, execute: () => ({ status: 0, stdout: fixture.stdout }),
  });
  assert.equal(report.success, false);
  assert.equal(report.checks[0].status, 'failed');
 });
}

test('passing tests retain explicitly reported optional skips', (t) => {
 const root = mkdtempSync(join(tmpdir(), 'hichat-quality-verdict-'));
 t.after(() => rmSync(root, { recursive: true, force: true }));
 const source = { head: 'revision', sha256: 'source', files: [] };
 for (const fixture of [
  { id: 'client-test', stdout: clientResult({ numPendingTests: 1 }) },
  { id: 'server', stdout: '{"Action":"pass","Test":"TestOne"}\n{"Action":"skip","Test":"TestOptional"}' },
 ]) {
  const report = runChecks([{ id: fixture.id, cwd: '.', command: 'fake', args: [] }], {
   root, snapshot: () => source, execute: () => ({ status: 0, stdout: fixture.stdout }),
  });
  assert.equal(report.success, true);
  assert.equal(report.checks[0].status, 'passed');
 }
});
