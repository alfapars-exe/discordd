import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, createWriteStream, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const processes = new WeakMap();
const invalid = () => new Error('Invalid owned local profile fixture');
const configKeys = ['tempDir', 'container', 'containerID', 'ownerLabel', 'controlDSN',
  'goBinary', 'source', 'k6', 'sourceCommit', 'dockerBinary'];

export function readLocalConfig(path) {
  let file;
  try {
    file = openSync(path, 'r');
    const bytes = Buffer.alloc(32769);
    let length = 0, count;
    while (length < bytes.length && (count = readSync(file, bytes, length, bytes.length - length, null)) > 0) length += count;
    if (length > 32768) throw invalid();
    return JSON.parse(bytes.subarray(0, length).toString('utf8'));
  } catch { throw invalid(); }
  finally { if (file !== undefined) closeSync(file); }
}

function inspectContainer(name, dockerBinary) {
  return JSON.parse(execFileSync(dockerBinary, ['inspect', name], {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }))[0];
}

/** Refuse arbitrary databases, source trees, or containers before building/seeding. */
export function validateLocalFixture(config, { platform = process.platform, inspect = inspectContainer } = {}) {
  try {
    if (platform !== 'win32' || !config || typeof config !== 'object' || Array.isArray(config)) throw invalid();
    if (Object.keys(config).length !== configKeys.length || configKeys.some(key =>
      typeof config[key] !== 'string' || !config[key] || config[key].length > 16384)) throw invalid();
    if (!/^[a-f0-9]{40}$/.test(config.sourceCommit) || !/^[a-f0-9]{64}$/.test(config.containerID) ||
      !/^local-fanout-[a-f0-9]{32}$/.test(config.ownerLabel)) throw invalid();
    if (!['dockerBinary', 'goBinary', 'k6'].every(key => isAbsolute(config[key]))) throw invalid();
    const directory = realpathSync(config.tempDir);
    const source = realpathSync(config.source);
    if (source !== join(directory, 'source')) throw invalid();
    const owner = JSON.parse(readFileSync(join(directory, 'owner.json'), 'utf8'));
    if (owner.label !== config.ownerLabel || owner.sourceCommit !== config.sourceCommit) throw invalid();
    const dsn = new URL(config.controlDSN);
    if (dsn.protocol !== 'postgres:' || dsn.hostname !== '127.0.0.1' ||
      dsn.username !== 'hichat_tls_test' || !dsn.password || !dsn.port ||
      dsn.pathname !== '/hichat_e2e_control' || dsn.hash) throw invalid();
    if ([...dsn.searchParams.keys()].sort((a, b) => a.localeCompare(b, 'en')).join(',') !== 'sslcert,sslkey,sslmode,sslrootcert' ||
      dsn.searchParams.get('sslmode') !== 'verify-full') throw invalid();
    for (const [key, leaf] of [['sslcert', 'client.crt'], ['sslkey', 'client.key'], ['sslrootcert', 'ca.crt']]) {
      if (resolve(dsn.searchParams.get(key)) !== join(directory, leaf)) throw invalid();
    }
    const container = inspect(config.container, config.dockerBinary);
    if (container.Id !== config.containerID || !container.State.Running ||
      container.Config.Labels['hichat.task'] !== config.ownerLabel ||
      !container.NetworkSettings.Ports['5432/tcp']?.some(binding =>
        binding.HostIp === '127.0.0.1' && binding.HostPort === dsn.port)) throw invalid();
  } catch {
    // Do not embed DSNs, underlying Docker output, or filesystem contents.
    throw invalid();
  }
}

/** Hash only archived input trees; refuse links into an unrelated checkout/cache. */
export function snapshotSources(source) {
  const files = {};
  const visit = path => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error('Profile source contains a filesystem link');
    if (stat.isDirectory()) {
      for (const child of readdirSync(path).sort()) visit(join(path, child));
    } else if (stat.isFile()) {
      files[relative(source, path).split(sep).join('/')] = createHash('sha256').update(readFileSync(path)).digest('hex');
    } else throw new Error('Profile source is not a regular file or directory');
  };
  for (const name of ['server', 'e2e/scripts/pg-fixture.go', 'loadtest']) visit(join(source, name));
  return { files, sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
}

export function assertSnapshotUnchanged(before, after) {
  if (before.sha256 !== after.sha256) throw new Error('Profile source changed during the workload');
}

/** Register close/error listeners immediately, including an executable-start failure. */
export function spawnOwned(command, args, options) {
  const child = spawn(command, args, options);
  let startFailed = false;
  const closed = new Promise(resolveClose => {
    child.once('error', () => { startFailed = true; });
    child.once('close', () => resolveClose({ startFailed }));
  });
  processes.set(child, closed);
  return child;
}

async function joinProcess(child) {
  const closed = processes.get(child);
  if (!closed) throw new Error('Refusing to manage an unregistered process');
  if (child.exitCode === null && child.signalCode === null && child.pid) child.kill();
  let timeout;
  try {
    const result = await Promise.race([closed, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Owned process did not close during cleanup')), 10000);
      timeout.unref();
    })]);
    if (result.startFailed) throw new Error('Owned process failed to start');
  } finally { clearTimeout(timeout); }
}

/** Join all children even when another child cannot be cleaned up. */
export async function joinOwnedProcesses(children) {
  const results = await Promise.allSettled(children.filter(Boolean).map(joinProcess));
  const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
  if (failures.length) throw new AggregateError(failures, 'Owned process cleanup failed');
}

/** Stream errors must enter normal fixture cleanup instead of crashing Node. */
export function openProfileLog(path, onFailure) {
  const stream = createWriteStream(path);
  stream.on('error', onFailure);
  return stream;
}

export function finishProfileLog(stream) {
  return new Promise((resolveLog, reject) => {
    const fail = () => reject(new Error('Profile log write failed'));
    if (stream.errored || stream.destroyed) { fail(); return; }
    stream.once('error', fail);
    stream.end(error => {
      stream.removeListener('error', fail);
      if (error) fail(); else resolveLog();
    });
  });
}

/** Called from a child close listener: filesystem errors must not escape it. */
export function captureProbeResult({ exitCode, text, stderrPresent, outputPath }) {
  let events = [], failed = false;
  try { events = text.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); }
  catch { failed = true; }
  const result = { exitCode, events, stderrPresent };
  try { writeFileSync(outputPath, JSON.stringify(result, null, 2)); }
  catch { failed = true; result.reportWriteFailed = true; }
  return { result, failed };
}
