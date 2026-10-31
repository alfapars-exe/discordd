import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const client = fileURLToPath(new URL('../client/', import.meta.url));
const server = createServer((_req, res) => { res.writeHead(503); res.end('fixture unavailable'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const env = { ...process.env, VITE_SENTRY_DSN: 'https://public@example.invalid/1',
  SENTRY_AUTH_TOKEN: 'test-only', SENTRY_ORG: 'fixture', SENTRY_PROJECT: 'fixture',
  SENTRY_URL: `http://127.0.0.1:${server.address().port}/`, SENTRY_HTTP_MAX_RETRIES: '0' };
try {
  const child = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], { cwd: client, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const timeout = setTimeout(() => child.kill(), 90000);
  const code = await new Promise(resolve => child.on('close', resolve));
  clearTimeout(timeout);
  assert.notEqual(code, 0, 'upload failure must reject release');
  assert.match(output, /Sentry source-map upload failed; release refused/);
  const assets = await readdir(`${client}/dist/assets`);
  const scripts = await Promise.all(assets.filter(name => name.endsWith('.js')).map(name => readFile(`${client}/dist/assets/${name}`, 'utf8')));
  assert.ok(scripts.some(source => source.includes('_sentryDebugIds')), 'built JS must contain Debug IDs');
  assert.ok(scripts.every(source => !source.includes('sourceMappingURL=')), 'source maps must be hidden');
  console.log('PASS: exact built JS has Debug IDs; hidden maps; failed local upload rejects release');
} finally { server.closeAllConnections(); server.close(); }
