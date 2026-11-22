/** Local-only, single-constructor diagnostic. Requires e2e Playwright and Python.
 * node scripts/trace-windows-voice-bootstrap.cjs --exe <packaged-HiChat.exe>
 * No account, capture, SDP, offer, or candidate gathering. Reports contain only
 * named native spans, not device identifiers or trace arguments. The raw trace
 * is deleted after successful parsing; an error leaves it in ignored QA output.
 */
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { _electron } = require('../e2e/node_modules/playwright');
const root = path.resolve(__dirname, '..');
const exeIndex = process.argv.indexOf('--exe');
if (exeIndex < 0 || !process.argv[exeIndex + 1]) throw Error('Missing --exe');
const tempRoot = path.join(root, 'e2e/.tmp'); fs.mkdirSync(tempRoot, { recursive: true });
const output = fs.mkdtempSync(path.join(tempRoot, 'cold-constructor-trace-'));
const exe = path.resolve(process.argv[exeIndex + 1]);
const profile = path.join(output, 'profile'), tracePath = path.join(output, 'constructor.trace');
const report = { test: 'single fresh packaged renderer; no account, tracks, offer, SDP, capture or ICE gathering', asarSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(path.dirname(exe), 'resources/app.asar'))).digest('hex') };
const deny = http.createServer((_req, res) => { res.writeHead(403); res.end(); });
deny.on('connect', (_req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'));
let app;
(async () => {
  try {
    await new Promise(resolve => deny.listen(0, '127.0.0.1', resolve));
    app = await _electron.launch({ executablePath: exe,
      args: [`--user-data-dir=${profile}`, '--disable-background-networking', '--disable-component-update', `--proxy-server=http://127.0.0.1:${deny.address().port}`],
      env: { ...process.env, ELECTRON_FORCE_PROD: '1' }, timeout: 90000 });
    report.runtime = await app.evaluate(({ app, BrowserWindow }) => {
      BrowserWindow.prototype.show = function() { this.hide(); };
      for (const w of BrowserWindow.getAllWindows()) { w.setSkipTaskbar(true); w.hide(); w.webContents.setBackgroundThrottling(false); }
      return { electron: process.versions.electron, chrome: process.versions.chrome, profile: app.getPath('userData') };
    });
    if (path.resolve(report.runtime.profile).toLowerCase() !== profile.toLowerCase()) throw Error('Unexpected profile');
    delete report.runtime.profile;
    const page = await app.firstWindow();
    await page.waitForURL('app://**', { timeout: 30000 });
    await page.waitForLoadState('domcontentloaded');
    report.categories = ['webrtc', 'media', 'audio', 'gpu', 'toplevel', 'blink.user_timing', 'disabled-by-default-webrtc'];
    await app.evaluate(async ({ contentTracing }, categories) => contentTracing.startRecording({
      included_categories: categories, excluded_categories: ['netlog'], enable_argument_filter: true,
      recording_mode: 'record-until-full', trace_buffer_size_in_kb: 16384,
    }), report.categories);
    report.constructor = await page.evaluate(() => {
      performance.mark('qa-pc-constructor-start');
      const start = performance.now();
      const pc = new RTCPeerConnection({ iceServers: [], iceCandidatePoolSize: 0 });
      const end = performance.now();
      performance.mark('qa-pc-constructor-end');
      const beforeClose = { signaling: pc.signalingState, gathering: pc.iceGatheringState, connection: pc.connectionState, senderCount: pc.getSenders().length, receiverCount: pc.getReceivers().length, hasLocalDescription: !!pc.localDescription };
      pc.close();
      return { elapsedMs: end - start, closeMs: performance.now() - end, beforeClose };
    });
    await app.evaluate(async ({ contentTracing }, p) => contentTracing.stopRecording(p), tracePath);
    const bytes = fs.readFileSync(tracePath);
    report.traceBytes = bytes.length;
    report.nativeSpans = JSON.parse(execFileSync('python', [path.join(__dirname, 'parse-windows-voice-bootstrap.py'), tracePath], { encoding: 'utf8' }));
    fs.unlinkSync(tracePath);
  } catch (error) { report.error = error.message.split('\n')[0]; process.exitCode = 1; }
  finally {
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ output, report }, null, 2));
    if (app) await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    deny.closeAllConnections(); deny.close();
  }
})();
