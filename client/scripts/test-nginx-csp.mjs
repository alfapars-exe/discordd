import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(clientDir, '..');
const suffix = `${process.pid}`;
const image = `hichat-nginx-csp-test:${suffix}`;
const container = `hichat-nginx-csp-test-${suffix}`;

function docker(args, { allowFailure = false, inherit = false } = {}) {
  const result = spawnSync('docker', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : 'pipe',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`docker ${args.join(' ')} failed (${result.status}):\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  }
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function assertContains(text, needle, message) {
  assert.ok(text.includes(needle), `${message}\nMissing: ${needle}`);
}

async function waitForNginx() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const result = docker(['exec', container, 'nginx', '-t'], { allowFailure: true });
    if (result.status === 0) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`nginx did not start with a valid config:\n${docker(['logs', container]).output}`);
}

function startContainer(extraArgs = []) {
  docker([
    'run', '--detach', '--name', container,
    '--add-host', 'server:127.0.0.1',
    ...extraArgs,
    image,
  ], { inherit: true });
}

function removeContainer() {
  docker(['rm', '--force', container], { allowFailure: true });
}

try {
  docker([
    'build', '--file', path.join(clientDir, 'Dockerfile'), '--target', 'production',
    '--tag', image, repoRoot,
  ], { inherit: true });

  // Default policy keeps the existing wss:/https: sources and adds no ws: source.
  startContainer();
  await waitForNginx();
  const defaultConfig = docker(['exec', container, 'nginx', '-T']).output;
  assertContains(defaultConfig, "connect-src 'self' wss: https: ;", 'default CSP lost wss:/https: or has an unexpected source');
  assertContains(defaultConfig, 'proxy_set_header Host $host;', 'envsubst modified an Nginx $host variable');
  assertContains(defaultConfig, 'proxy_set_header X-Forwarded-Proto $scheme;', 'envsubst modified an Nginx $scheme variable');
  const defaultResponse = docker(['exec', container, 'sh', '-c', 'wget -qSO- http://127.0.0.1/ 2>&1']).output;
  assertContains(defaultResponse, "connect-src 'self' wss: https: ;", 'default HTTP CSP header is missing baseline sources');
  assert.ok(!defaultResponse.includes('ws://'), 'default CSP unexpectedly allows a ws:// origin');
  removeContainer();

  // Only local endpoints may use plaintext WebSockets; remote services need wss:.
  startContainer(['--env', 'LIVEKIT_CSP_WS_ORIGIN=ws://localhost:7880']);
  await waitForNginx();
  const configuredResponse = docker(['exec', container, 'sh', '-c', 'wget -qSO- http://127.0.0.1/ 2>&1']).output;
  assertContains(configuredResponse, "connect-src 'self' wss: https: ws://localhost:7880;", 'response CSP lacks the exact localhost origin or baseline sources');
  removeContainer();

  startContainer(['--env', 'LIVEKIT_CSP_WS_ORIGIN=ws://127.0.0.2:7880']);
  await waitForNginx();
  const ipv4Response = docker(['exec', container, 'sh', '-c', 'wget -qSO- http://127.0.0.1/ 2>&1']).output;
  assertContains(ipv4Response, "connect-src 'self' wss: https: ws://127.0.0.2:7880;", 'response CSP lacks the exact loopback IPv4 origin');
  removeContainer();

  startContainer(['--env', 'LIVEKIT_CSP_WS_ORIGIN=ws://[::1]:7880']);
  await waitForNginx();
  const ipv6Response = docker(['exec', container, 'sh', '-c', 'wget -qSO- http://127.0.0.1/ 2>&1']).output;
  assertContains(ipv6Response, "connect-src 'self' wss: https: ws://[::1]:7880;", 'response CSP lacks the exact IPv6 loopback origin');
  removeContainer();

  startContainer(['--env', 'LIVEKIT_CSP_WS_ORIGIN=ws://[0:0:0:0:0:0:0:1]:7880']);
  await waitForNginx();
  const expandedIPv6Response = docker(['exec', container, 'sh', '-c', 'wget -qSO- http://127.0.0.1/ 2>&1']).output;
  assertContains(expandedIPv6Response, "connect-src 'self' wss: https: ws://[0:0:0:0:0:0:0:1]:7880;", 'response CSP lacks the exact expanded IPv6 loopback origin');
  removeContainer();

  // Malformed origins, multiline values and CSP token injection fail closed.
  const invalidOrigins = [
    'ws://voice.example.test:7880; add_header X-Injected yes;',
    'ws://voice.example.test:7880\nws://attacker.example.test:7880',
    'ws://voice.example.test:7880',
    'ws://192.168.1.10:7880',
    'ws://128.0.0.1:7880',
    'wss://voice.example.test:7880',
    'ws://voice.example.test/path',
    'ws://voice.example.test:65536',
    'ws://[2001:db8::8]:7880',
    'ws://[::2]:7880',
    'ws://[2001:::1]:7880',
    'ws://[2001:db8::1::2]:7880',
  ];
  for (const origin of invalidOrigins) {
    const result = docker(['run', '--name', container, '--env', `LIVEKIT_CSP_WS_ORIGIN=${origin}`, image], { allowFailure: true });
    assert.notEqual(result.status, 0, `invalid CSP origin was accepted: ${JSON.stringify(origin)}`);
    const log = docker(['logs', container]).output;
    assertContains(log, 'Invalid LIVEKIT_CSP_WS_ORIGIN', `invalid origin did not fail closed with a diagnostic: ${JSON.stringify(origin)}`);
    removeContainer();
  }

  process.stdout.write('PASS: production nginx default, exact localhost/IPv4/IPv6 loopback ws:// origins, Nginx variable preservation, response CSP, remote-origin rejection, and newline/token injection rejection.\n');
} finally {
  removeContainer();
  docker(['image', 'rm', image], { allowFailure: true });
}
