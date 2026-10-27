import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(clientDir, '..');
const suffix = `${process.pid}`;
const image = `hichat-nginx-csp-test:${suffix}`;
const container = `hichat-nginx-csp-test-${suffix}`;
const wsOrigin = authority => ['ws:', '//', authority].join('');
const wssOrigin = authority => ['wss:', '//', authority].join('');

function resolveDockerExecutable() {
  const override = process.env.DOCKER_EXECUTABLE;
  if (override !== undefined && !path.isAbsolute(override)) {
    throw new Error('DOCKER_EXECUTABLE must be an absolute path; PATH lookup is intentionally disabled');
  }

  const candidates = override
    ? [override]
    : process.platform === 'win32'
      ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker', 'resources', 'bin', 'docker.exe')]
    : process.platform === 'darwin'
      ? ['/usr/local/bin/docker', '/opt/homebrew/bin/docker', '/Applications/Docker.app/Contents/Resources/bin/docker']
      : ['/usr/bin/docker', '/usr/local/bin/docker', '/bin/docker'];

  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate) || !existsSync(candidate)) continue;
    try {
      if (!statSync(candidate).isFile()) continue;
      if (process.platform !== 'win32') accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Ignore inaccessible candidates and fail with a clear diagnostic below.
    }
  }

  throw new Error(`Docker CLI not found in configured absolute path or trusted installation locations: ${candidates.join(', ')}`);
}

const dockerExecutable = resolveDockerExecutable();

function docker(args, { allowFailure = false, inherit = false } = {}) {
  const result = spawnSync(dockerExecutable, args, {
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
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = docker(['exec', container, 'nginx', '-t'], { allowFailure: true });
    const health = docker(['inspect', '--format', '{{.State.Health.Status}}', container], { allowFailure: true });
    if (result.status === 0 && health.status === 0 && health.output.trim() === 'healthy') return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`nginx did not become healthy with a valid config:\n${docker(['logs', container]).output}`);
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

  const configuredUser = docker(['inspect', '--format', '{{.Config.User}}', image]).output.trim();
  assert.equal(configuredUser, 'nginx', 'production image must run Nginx as the non-root nginx user');
  const exposedPorts = docker(['inspect', '--format', '{{json .Config.ExposedPorts}}', image]).output;
  assertContains(exposedPorts, '80/tcp', 'production image must preserve the container port 80 contract');

  // Default policy keeps the existing wss:/https: sources and adds no ws: source.
  startContainer();
  await waitForNginx();
  const runtimeUid = docker(['exec', container, 'sh', '-c', "awk '/^Uid:/ { print $2 }' /proc/1/status"]).output.trim();
  assert.match(runtimeUid, /^[1-9]\d*$/, 'Nginx master process must not run as uid 0');
  const defaultConfig = docker(['exec', container, 'nginx', '-T']).output;
  assertContains(defaultConfig, "connect-src 'self' wss: https: ;", 'default CSP lost wss:/https: or has an unexpected source');
  assertContains(defaultConfig, 'proxy_set_header Host $host;', 'envsubst modified an Nginx $host variable');
  assertContains(defaultConfig, 'proxy_set_header X-Forwarded-Proto $scheme;', 'envsubst modified an Nginx $scheme variable');
  const defaultResponse = docker(['exec', container, 'sh', '-c', 'wget -qSO- http://127.0.0.1:80/ 2>&1']).output;
  assertContains(defaultResponse, "connect-src 'self' wss: https: ;", 'default HTTP CSP header is missing baseline sources');
  assert.ok(!defaultResponse.includes('ws://'), 'default CSP unexpectedly allows a ws:// origin');
  removeContainer();

  // Only local endpoints may use plaintext WebSockets; remote services need wss:.
  startContainer(['--env', 'LIVEKIT_CSP_WS_ORIGIN=ws://localhost:7880']);
  await waitForNginx();
  const configuredResponse = docker(['exec', container, 'sh', '-c', 'wget -qSO- http://127.0.0.1:80/ 2>&1']).output;
  assertContains(configuredResponse, "connect-src 'self' wss: https: ws://localhost:7880;", 'response CSP lacks the exact localhost origin or baseline sources');
  removeContainer();

  startContainer(['--env', 'LIVEKIT_CSP_WS_ORIGIN=ws://127.0.0.2:7880']);
  await waitForNginx();
  const ipv4Response = docker(['exec', container, 'sh', '-c', 'wget -qSO- http://127.0.0.1:80/ 2>&1']).output;
  assertContains(ipv4Response, "connect-src 'self' wss: https: ws://127.0.0.2:7880;", 'response CSP lacks the exact loopback IPv4 origin');
  removeContainer();

  startContainer(['--env', 'LIVEKIT_CSP_WS_ORIGIN=ws://[::1]:7880']);
  await waitForNginx();
  const ipv6Response = docker(['exec', container, 'sh', '-c', 'wget -qSO- http://127.0.0.1:80/ 2>&1']).output;
  assertContains(ipv6Response, "connect-src 'self' wss: https: ws://[::1]:7880;", 'response CSP lacks the exact IPv6 loopback origin');
  removeContainer();

  startContainer(['--env', 'LIVEKIT_CSP_WS_ORIGIN=ws://[0:0:0:0:0:0:0:1]:7880']);
  await waitForNginx();
  const expandedIPv6Response = docker(['exec', container, 'sh', '-c', 'wget -qSO- http://127.0.0.1:80/ 2>&1']).output;
  assertContains(expandedIPv6Response, "connect-src 'self' wss: https: ws://[0:0:0:0:0:0:0:1]:7880;", 'response CSP lacks the exact expanded IPv6 loopback origin');
  removeContainer();

  // Malformed origins, multiline values and CSP token injection fail closed.
  const invalidOrigins = [
    `${wsOrigin('voice.example.test:7880')}; add_header X-Injected yes;`,
    `${wsOrigin('voice.example.test:7880')}\n${wsOrigin('attacker.example.test:7880')}`,
    wsOrigin('voice.example.test:7880'),
    wsOrigin('192.168.1.10:7880'),
    wsOrigin('128.0.0.1:7880'),
    wssOrigin('voice.example.test:7880'),
    `${wsOrigin('voice.example.test')}/path`,
    `${wsOrigin('voice.example.test')}:65536`,
    wsOrigin('[2001:db8::8]:7880'),
    wsOrigin('[::2]:7880'),
    wsOrigin('[2001:::1]:7880'),
    wsOrigin('[2001:db8::1::2]:7880'),
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
