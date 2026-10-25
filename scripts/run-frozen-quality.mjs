import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceSnapshot } from './run-quality.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Copy materialized dirty/untracked sources, retaining the base Git index.
 * Dependencies are shared read-only by convention; npm install is never run.
 */
export function createFrozenSource(origin, destination) {
  const before = sourceSnapshot(origin);
  execFileSync('git', ['clone', '--shared', '--no-checkout', '--local', origin, destination], { stdio: 'pipe', windowsHide: true });
  execFileSync('git', ['read-tree', 'HEAD'], { cwd: destination, stdio: 'pipe', windowsHide: true });
  const names = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: origin, encoding: 'utf8' }).split('\0');
  for (const name of new Set(names)) {
    if (!name || !existsSync(join(origin, name))) continue;
    const target = join(destination, name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(origin, name), target);
  }
  for (const name of ['node_modules', 'client/node_modules', 'e2e/node_modules']) {
    if (existsSync(join(origin, name))) symlinkSync(join(origin, name), join(destination, name), 'junction');
  }
  const after = sourceSnapshot(origin);
  const frozen = sourceSnapshot(destination);
  if (before.head !== after.head || before.sha256 !== after.sha256 || before.sha256 !== frozen.sha256) {
    throw new Error('Sources changed while copying; retry after the current edit finishes');
  }
  return { head: before.head, sha256: before.sha256, directory: destination };
}

export function removeFrozenSource(directory) {
  const temporaryRoot = resolve(tmpdir());
  const target = resolve(directory);
  if (dirname(target) !== temporaryRoot || !target.split(/[\\/]/).at(-1).startsWith('hichat-quality-frozen-')) {
    throw new Error('Refusing cleanup outside the generated snapshot directory');
  }
  // Remove junction entries explicitly before recursive cleanup. Never recurse
  // into the original workspace's shared dependency directories.
  for (const name of ['node_modules', 'client/node_modules', 'e2e/node_modules']) {
    const link = join(target, name);
    if (existsSync(link) && !lstatSync(link).isSymbolicLink()) throw new Error('Expected dependency junction');
    if (existsSync(link)) rmSync(link, { recursive: true, force: true });
  }
  rmSync(target, { recursive: true, force: true });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = mkdtempSync(join(tmpdir(), 'hichat-quality-frozen-'));
  try {
    const profile = process.argv[2] ?? 'baseline';
    const output = resolve(process.argv[3] ?? 'implementation/verification/refactoring-frozen-baseline.json');
    const snapshot = createFrozenSource(ROOT, directory);
    console.log(`Frozen ${snapshot.head.slice(0, 12)} and source manifest ${snapshot.sha256}`);
    const result = spawnSync(process.execPath, ['scripts/run-quality.mjs', profile, 'implementation/verification/frozen-result.json'], {
      cwd: directory, stdio: 'inherit', windowsHide: true,
    });
    const reportPath = join(directory, 'implementation/verification/frozen-result.json');
    if (!existsSync(reportPath)) throw new Error('Frozen check did not produce its evidence report');
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    const artifactName = 'frozen-' + directory.split(/[\\/]/).at(-1);
    const artifacts = join(ROOT, 'artifacts/refactoring', artifactName);
    cpSync(join(directory, 'artifacts/refactoring'), artifacts, { recursive: true });
    for (const check of report.checks) {
      check.log = `artifacts/refactoring/${artifactName}/` + check.log.replace(/^artifacts\/refactoring\//, '');
    }
    const coveragePath = join(directory, 'client/coverage/coverage-summary.json');
    if (existsSync(coveragePath)) report.client_coverage = JSON.parse(readFileSync(coveragePath, 'utf8')).total;
    const goCoverage = join(directory, 'coverage/go.out');
    if (existsSync(goCoverage)) {
      copyFileSync(goCoverage, join(artifacts, 'go.out'));
      try {
        const summary = execFileSync('go', ['tool', 'cover', '-func=' + goCoverage], { cwd: join(directory, 'server'), encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        writeFileSync(join(artifacts, 'go-summary.txt'), summary);
        report.go_coverage_summary = summary.trim().split('\n').at(-1);
      } catch {
        report.go_coverage_error = 'Coverage summary unavailable; inspect the failed Go check';
      }
    }
    report.execution = { kind: 'frozen-worktree-copy', original_root: ROOT, dependencies: 'existing workspace dependencies; no install or update' };
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(`Frozen evidence: ${relative(ROOT, output)}`);
    process.exitCode = result.status ?? 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    removeFrozenSource(directory);
  }
}
