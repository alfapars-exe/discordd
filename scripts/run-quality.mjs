import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_EXTENSIONS = /\.(?:go|ts|tsx|js|mjs|py|json|ya?ml|sql|cpp|h|kt|java|swift|html|css|sh|ps1)$/;

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

// Hash actual worktree bytes, including untracked source. Never collect env
// values, credentials, user data, generated bundles or verification artifacts.
export function sourceSnapshot(root = ROOT) {
  const names = new Set(git(root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0'));
  const files = [...names].filter((name) => (SOURCE_EXTENSIONS.test(name) || ['.editorconfig', '.gitignore', '.gitattributes', 'Dockerfile'].includes(name.split('/').at(-1)))
    && !/^(?:artifacts|implementation\/verification|docs)\//.test(name)
    && !/(?:^|\/)\.env(?:\.|$)/.test(name)).sort().map((name) => ({
    path: name,
    sha256: existsSync(join(root, name))
      ? createHash('sha256').update(readFileSync(join(root, name))).digest('hex') : null,
  }));
  return {
    head: git(root, 'rev-parse', 'HEAD').trim(),
    dirty: git(root, 'status', '--porcelain=v1', '--untracked-files=all').trim().split('\n').filter(Boolean),
    sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    files,
  };
}

export function redactLog(text) {
  return text.replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:postgres(?:ql)?|libsql):\/\/[^\s"'<>]+/gi, '[database-url]')
    .replace(/((?:password|secret|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[=:]\s*)[^\s,;}]+/gi, '$1[redacted]');
}

export function npmCli() {
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')];
  const cli = candidates.find((path) => path && existsSync(path));
  if (!cli) throw new Error('Run through npm so npm_execpath identifies the local npm CLI');
  return cli;
}

export function qualityChecks(profile, cli = npmCli()) {
  const npm = (id, cwd, ...args) => ({ id, cwd, command: process.execPath, args: [cli, ...args] });
  const python = process.platform === 'win32' ? ['py', '-3.12'] : ['python3'];
  const checks = {
    tooling: { id: 'tooling', cwd: '.', command: process.execPath, args: ['--test', 'scripts/check-implementation-coverage.test.mjs', 'scripts/run-quality.test.mjs', 'scripts/run-frozen-quality.test.mjs'] },
    'python-tools': { id: 'python-tools', cwd: '.', command: python[0], args: [...python.slice(1), '-m', 'unittest', 'discover', '-s', 'scripts', '-p', 'test_*.py'] },
    postgres: { id: 'postgres', cwd: '.', command: python[0], args: [...python.slice(1), 'scripts/run-postgres-tests.py'] },
    encoding: { id: 'encoding', cwd: '.', command: python[0], args: [...python.slice(1), 'scripts/check-text-encoding.py'] },
    bot: { id: 'bot', cwd: 'bots/welcome-bot', command: 'go', args: ['test', './...', '-count=1', '-timeout=60s'] },
    'client-lint': npm('client-lint', 'client', 'run', 'lint'),
    'client-test': { ...npm('client-test', 'client', 'test', '--', '--maxWorkers=4', '--coverage', '--reporter=json', '--outputFile=../artifacts/refactoring/client-tests.json'), reportPath: 'artifacts/refactoring/client-tests.json' },
    'client-build': npm('client-build', 'client', 'run', 'build'),
    electron: npm('electron', '.', 'run', 'electron:test'),
    server: { id: 'server', cwd: 'server', command: 'go', args: ['test', '-json', './...', '-count=1', '-timeout=5m', '-p=2', '-covermode=atomic', '-coverprofile=../coverage/go.out'] },
    e2e: npm('e2e', 'e2e', 'test', '--', '--reporter=line'),
    'acceptance-structure': npm('acceptance-structure', '.', 'run', 'check:coverage'),
    'acceptance-complete': { ...npm('acceptance-complete', '.', 'run', 'check:acceptance'), required: false },
    'client-coverage': npm('client-coverage', 'client', 'run', 'test:coverage', '--', '--maxWorkers=4'),
    'audio-gate': npm('audio-gate', 'client', 'run', 'test:audio:gate'),
    'audio-wasm': npm('audio-wasm', 'client', 'run', 'test:audio:wasm'),
  };
  const profiles = {
    baseline: ['encoding', 'tooling', 'python-tools', 'client-lint', 'client-test', 'client-build', 'electron', 'server', 'bot', 'e2e', 'acceptance-structure', 'acceptance-complete'],
    fast: ['encoding', 'tooling', 'python-tools', 'client-lint', 'client-build', 'acceptance-structure'],
    coverage: ['client-coverage'],
    audio: ['audio-gate', 'audio-wasm'],
  };
  const selected = profiles[profile] ?? (checks[profile] ? [profile] : null);
  if (!selected) throw new Error(`Unknown quality profile: ${profile}`);
  return selected.map((id) => ({ required: true, timeoutMs: 20 * 60_000, ...checks[id] }));
}

export function summarizeOutput(check, stdout) {
  if (check.id === 'client-test') {
    // Vitest JSON is stdout; startup banners can precede the first JSON line.
    const start = stdout.indexOf('{"numTotalTestSuites"');
    try {
      const report = JSON.parse(stdout.slice(start));
      if (![report.numPassedTests, report.numFailedTests, report.numPendingTests].every(Number.isInteger)
        || report.numPassedTests + report.numFailedTests + report.numPendingTests === 0) throw new Error('Empty test report');
      return { passed: report.numPassedTests, failed: report.numFailedTests, skipped: report.numPendingTests };
    } catch { return { reportError: 'Client JSON result unavailable; inspect command log' }; }
  }
  if (check.id === 'server') {
    const events = stdout.split('\n').flatMap((line) => {
      try { const event = JSON.parse(line); return event.Test ? [event] : []; } catch { return []; }
    });
    if (!events.length) return { reportError: 'Go test result contains no executed tests' };
    return Object.fromEntries(['pass', 'fail', 'skip'].map((action) => [action, events.filter((event) => event.Action === action).length]));
  }
  return null;
}

export function runChecks(checks, { root = ROOT, output, execute = spawnSync, snapshot = sourceSnapshot } = {}) {
  if (!checks.length) throw new Error('Quality run must contain at least one check');
  const before = snapshot(root);
  const startedAt = new Date().toISOString();
  const report = { schema_version: 1, started_at: startedAt, platform: process.platform, node: process.version, source_before: before, checks: [] };
  const logDir = join(root, 'artifacts/refactoring', startedAt.replace(/[:.]/g, '-'));
  mkdirSync(logDir, { recursive: true });
  if (checks.some((check) => check.id === 'server')) mkdirSync(join(root, 'coverage'), { recursive: true });
  for (const check of checks) {
    if (check.reportPath) rmSync(join(root, check.reportPath), { force: true });
    const started = Date.now();
    const result = execute(check.command, check.args, {
      cwd: resolve(root, check.cwd), encoding: 'utf8', timeout: check.timeoutMs,
      maxBuffer: 64 * 1024 * 1024, windowsHide: true,
    });
    const stdout = String(result.stdout ?? '');
    const log = join(logDir, `${check.id}.log`);
    writeFileSync(log, redactLog(stdout + '\n' + String(result.stderr ?? '')));
    const structuredOutput = check.reportPath && existsSync(join(root, check.reportPath))
      ? readFileSync(join(root, check.reportPath), 'utf8') : stdout;
    const summary = summarizeOutput(check, structuredOutput);
    const record = {
      id: check.id, required: check.required !== false, cwd: check.cwd,
      command: [check.command === process.execPath ? 'node' : check.command, ...check.args.map((arg) => arg.endsWith('npm-cli.js') ? '<npm-cli>' : arg)],
      status: result.status === 0 && !result.error && !summary?.reportError ? 'passed' : 'failed',
      exit_code: result.status, signal: result.signal ?? null,
      timed_out: result.error?.code === 'ETIMEDOUT',
      error_code: result.error?.code ?? null, duration_ms: Date.now() - started,
      log: relative(root, log).replaceAll('\\', '/'), summary,
    };
    report.checks.push(record);
    console.log(`${record.id}: ${record.status} (${record.duration_ms}ms)`);
  }
  const after = snapshot(root);
  const afterByPath = new Map(after.files.map((file) => [file.path, file.sha256]));
  const beforeByPath = new Map(before.files.map((file) => [file.path, file.sha256]));
  report.source_after = { head: after.head, sha256: after.sha256 };
  report.source_changed_paths = [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])]
    .filter((path) => beforeByPath.get(path) !== afterByPath.get(path)).sort();
  report.source_stable = before.head === after.head && before.sha256 === after.sha256;
  report.finished_at = new Date().toISOString();
  report.success = report.source_stable && report.checks.every((check) => !check.required || check.status === 'passed');
  if (output) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 2) throw new Error('Usage: run-quality.mjs [profile] [report.json]');
    const profile = args[0] ?? 'baseline';
    const output = resolve(args[1] ?? `implementation/verification/refactoring-${profile}-${new Date().toISOString().slice(0, 10)}.json`);
    const report = runChecks(qualityChecks(profile), { output });
    try { report.go_version = execFileSync('go', ['version'], { encoding: 'utf8', windowsHide: true }).trim(); }
    catch { report.go_version = null; }
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(`Source stable: ${report.source_stable}; report: ${relative(ROOT, output)}`);
    process.exitCode = report.success ? 0 : 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
