/**
 * Local-only packaged Electron cancellation acceptance probe.
 * node scripts/verify-packaged-api-cancellation.cjs --exe PATH --cert PATH --key PATH [--output DIR]
 * Requires e2e Playwright dependencies and a local TLS certificate/key. Certificate
 * trust is scoped to its SPKI pin; all non-loopback traffic is denied by a proxy.
 * Uses a fresh profile, never installs or publishes, and writes no key material.
 */
const { _electron } = require('../e2e/node_modules/playwright');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const crypto = require('node:crypto');
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]]);
  return pairs;
}, []));
for (const required of ['exe', 'cert', 'key']) if (!args[required]) throw Error(`Missing --${required}`);
const tempRoot = path.resolve(args.output || 'e2e/.tmp');
fs.mkdirSync(tempRoot, { recursive: true });
const output = fs.mkdtempSync(path.join(tempRoot, 'packaged-cancellation-'));
const executablePath = path.resolve(args.exe);
const cert = fs.readFileSync(args.cert), key = fs.readFileSync(args.key);
const pin = crypto.createHash('sha256').update(new crypto.X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
const requests = {}, timers = new Set();
const report = {
  kind: 'packaged renderer / trusted IPC / protocol proxy / HTTPS upstream cancellation',
  fixture: 'loopback TLS with pinned test certificate; non-loopback traffic denied; fresh profile',
  upstreamDelayMs: 5000, rendererAbortMs: 150, upstreamCloseLimitMs: 1500, checks: [],
  asarSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(path.dirname(executablePath), 'resources/app.asar'))).digest('hex'),
};
const fixture = https.createServer({ key, cert }, (req, res) => {
  const name = new URL(req.url, 'https://127.0.0.1').pathname;
  const entry = requests[name] = { start: Date.now(), aborted: null, closed: null, finished: null,
    leakedPrivateHeader: req.headers['x-hichat-request-id'] !== undefined || req.headers['x-hichat-upstream'] !== undefined };
  req.on('aborted', () => { entry.aborted = Date.now(); });
  res.on('close', () => { entry.closed = Date.now(); });
  res.on('finish', () => { entry.finished = Date.now(); });
  if (name.includes('body')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{"success":'); }
  const timer = setTimeout(() => {
    timers.delete(timer);
    if (res.destroyed) return;
    if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(name.includes('body') ? 'true}' : '{"success":true}');
  }, name.includes('control') ? 100 : report.upstreamDelayMs);
  timers.add(timer);
});
const deny = http.createServer((_req, res) => { res.writeHead(403); res.end(); });
deny.on('connect', (_req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'));
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
async function waitFor(predicate, timeout) {
  const end = Date.now() + timeout;
  while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
  return !!predicate();
}
function serverResult(name) {
  const entry = requests[`/api/cancel-probe/${name}`];
  return entry ? { requestStartedAtUnixMs: entry.start, requestAbortedAtUnixMs: entry.aborted, responseClosedAtUnixMs: entry.closed,
    requestAbortedMs: entry.aborted === null ? null : entry.aborted - entry.start,
    responseClosedMs: entry.closed === null ? null : entry.closed - entry.start,
    responseFinishedMs: entry.finished === null ? null : entry.finished - entry.start,
    leakedPrivateHeader: entry.leakedPrivateHeader } : null;
}
let app;
(async () => {
  try {
    const tlsPort = await listen(fixture), denyPort = await listen(deny), upstream = `https://127.0.0.1:${tlsPort}`;
    const profile = path.join(output, 'profile');
    app = await _electron.launch({ executablePath,
      args: [`--user-data-dir=${profile}`, '--disable-background-networking', '--disable-component-update',
        `--proxy-server=http://127.0.0.1:${denyPort}`, '--proxy-bypass-list=127.0.0.1;localhost', `--ignore-certificate-errors-spki-list=${pin}`],
      env: { ...process.env, ELECTRON_FORCE_PROD: '1' }, timeout: 90000,
    });
    report.runtime = await app.evaluate(({ app, BrowserWindow }) => {
      BrowserWindow.prototype.show = function() { this.hide(); };
      for (const win of BrowserWindow.getAllWindows()) { win.setSkipTaskbar(true); win.hide(); win.webContents.setBackgroundThrottling(false); }
      return { appVersion: app.getVersion(), electron: process.versions.electron, profile: app.getPath('userData') };
    });
    if (path.resolve(report.runtime.profile).toLowerCase() !== profile.toLowerCase()) throw Error('Isolated profile assertion failed');
    delete report.runtime.profile;
    await app.firstWindow();
    await waitFor(() => !!app.windows().find(page => page.url().startsWith('app://')), 30000);
    const page = app.windows().find(page => page.url().startsWith('app://'));
    if (!page) throw Error('Packaged renderer not found');
    for (const name of ['renderer-control', 'renderer-headers', 'renderer-body']) {
      const result = await page.evaluate(async ({ name, upstream }) => {
        const ctrl = new AbortController(), start = Date.now(), api = window.electronAPI;
        let abortIssuedAtUnixMs = null;
        const url = `app://hichat/api/cancel-probe/${name}`;
        const id = await api.reserveApiRequest({ url, method: 'GET', upstream });
        const cancel = () => { void api.cancelApiRequest(id); };
        ctrl.signal.addEventListener('abort', cancel, { once: true });
        const timer = name.includes('control') ? null : setTimeout(() => { abortIssuedAtUnixMs = Date.now(); ctrl.abort(); }, 150);
        try {
          const response = await fetch(url, { signal: ctrl.signal, headers: { 'X-HiChat-Upstream': upstream, 'X-HiChat-Request-Id': id } });
          await response.text();
          return { outcome: 'fulfilled', elapsedMs: Date.now() - start, abortIssuedAtUnixMs };
        } catch (error) { return { outcome: error.name, elapsedMs: Date.now() - start, abortIssuedAtUnixMs }; }
        finally { if (timer) clearTimeout(timer); ctrl.signal.removeEventListener('abort', cancel); await api.cancelApiRequest(id); }
      }, { name, upstream });
      await waitFor(() => !!requests[`/api/cancel-probe/${name}`]?.closed, report.upstreamCloseLimitMs);
      const server = serverResult(name);
      const passed = name.includes('control')
        ? result.outcome === 'fulfilled' && server?.responseFinishedMs !== null
        : result.outcome === 'AbortError' && server?.responseClosedMs !== null && server?.responseClosedMs < report.upstreamCloseLimitMs && server?.responseFinishedMs === null;
      report.checks.push({ name, ...result, server, upstreamClosedAfterAbortMs: result.abortIssuedAtUnixMs && server?.responseClosedAtUnixMs
        ? server.responseClosedAtUnixMs - result.abortIssuedAtUnixMs : null,
        passed: Boolean(passed && server && !server.leakedPrivateHeader) });
    }
    const beforeDispatch = await page.evaluate(async upstream => {
      const api = window.electronAPI, url = 'app://hichat/api/cancel-probe/before-dispatch';
      const id = await api.reserveApiRequest({ url, method: 'GET', upstream });
      await api.cancelApiRequest(id);
      try { await fetch(url, { headers: { 'X-HiChat-Upstream': upstream, 'X-HiChat-Request-Id': id } }); return 'fulfilled'; }
      catch (error) { return error.name; }
    }, upstream);
    report.checks.push({ name: 'cancel-before-dispatch', outcome: beforeDispatch, passed: beforeDispatch === 'TypeError' && !requests['/api/cancel-probe/before-dispatch'] });
    report.passed = report.checks.every(check => check.passed);
    if (!report.passed) process.exitCode = 1;
  } catch (error) { report.error = error.message.split('\n')[0]; report.passed = false; process.exitCode = 1; }
  finally {
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ output, report }, null, 2));
    if (app) await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    for (const timer of timers) clearTimeout(timer);
    fixture.closeAllConnections(); fixture.close(); deny.closeAllConnections(); deny.close();
  }
})();
