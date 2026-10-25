// Isolated Chrome acceptance runner. Generated/file audio only; no microphone.
// Requires local Vite and LiveKit17880 (--dev, node-ip127.0.0.1).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const { chromium } = await import(process.env.HICHAT_PLAYWRIGHT_MODULE ?? 'playwright');
const baseUrl = process.env.HICHAT_AUDIO_QA_URL ?? 'http://127.0.0.1:3041';
const executablePath = process.env.HICHAT_CHROME_PATH;
const soakMs = Math.max(0, Number(process.env.HICHAT_AUDIO_SOAK_MS) || 0);
const runFixtures = process.env.HICHAT_AUDIO_FIXTURES === '1';

const directory = fileURLToPath(new URL('../../artifacts/audio-qa/', import.meta.url));
await fs.mkdir(directory, { recursive: true });
const report = { startedAt: new Date().toISOString(), syntheticCapture: true, microphonePermissionRequested: false, engines: [], transport: [], fixtures: [] };
if (runFixtures) {
  report.fixtureInputs = await Promise.all(['clean', 'fan', 'keyboard', 'transient'].map(async fixture => {
    const bytes = await fs.readFile(path.join(directory, 'inputs', `${fixture}.wav`));
    return { fixture, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }));
}
const browser = await chromium.launch({ executablePath, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const activeWorkers = new Set();
let createdWorkers = 0;
const prepare = async page => {
  page.on('worker', worker => { createdWorkers++; activeWorkers.add(worker); worker.on('close', () => activeWorkers.delete(worker)); });
  await page.addInitScript(() => {
    const OriginalContext = window.AudioContext;
    window.qaContexts = new Set();
    window.AudioContext = class extends OriginalContext {
      constructor(...args) { super(...args); window.qaContexts.add(this); }
      async close() { try { await super.close(); } finally { if (this.state === 'closed') window.qaContexts.delete(this); } }
    };
  });
  await page.goto(`${baseUrl}/audio-engine-qa.html`);
};
try {
  const page = await browser.newPage();
  await page.route('**/__audio_qa_inputs/*.wav', async route => {
    const name = path.basename(new URL(route.request().url()).pathname);
    if (!['clean.wav', 'fan.wav', 'keyboard.wav', 'transient.wav'].includes(name)) return route.abort();
    await route.fulfill({ status: 200, contentType: 'audio/wav', path: path.join(directory, 'inputs', name) });
  });
  page.on('pageerror', error => console.log('PAGE_ERROR', error.message));
  await prepare(page);
  await page.evaluate(() => {
    document.getElementById('start').onclick = () => { window.qaContext = new AudioContext({ sampleRate: 48000 }); window.qaContext.resume(); };
  });
  await page.click('#start');
  report.userAgent = await page.evaluate(() => navigator.userAgent);
  report.minimal = await page.evaluate(async () => {
    const context = window.qaContext;
    await context.audioWorklet.addModule(URL.createObjectURL(new Blob([`registerProcessor('ping',class extends AudioWorkletProcessor { constructor(){super();this.port.postMessage({ready:true});}process(){return false;}})`], { type: 'text/javascript' })));
    const node = new AudioWorkletNode(context, 'ping');
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Minimal worklet timed out')), 10000);
      node.port.onmessage = ({ data }) => { clearTimeout(timeout); node.disconnect(); node.port.close(); resolve(data); };
      node.connect(context.destination);
    });
  });
  console.log('MINIMAL', JSON.stringify(report.minimal));
  for (const engine of ['rnnoise', 'gtcrn', 'speex', 'deepfilter']) {
    const result = await page.evaluate(async engine => (await import('/src/audio/engines/engineBrowserProbe.mjs')).probeWorkletEngine(window.qaContext, engine, { durationMs: 1200 }), engine);
    report.engines.push(result);
    console.log('ENGINE', JSON.stringify(result));
    await fs.writeFile(path.join(directory, 'chrome-audio-report.json'), JSON.stringify(report, null, 2));
  }
  report.dtln = await page.evaluate(async () => (await import('/src/audio/engines/dtlnBrowserProbe.mjs')).probeDtlnEngine());
  console.log('DTLN', JSON.stringify(report.dtln));
  report.gate = await page.evaluate(async () => (await import('/src/audio/engines/engineBrowserProbe.mjs')).probeGateBehavior());
  console.log('GATE', JSON.stringify({ passed: report.gate.passed, gainPowerRatio: report.gate.gainPowerRatio, inputDbDifference: report.gate.inputDbDifference }));
  report.deepfilterLifecycle = await page.evaluate(async () => (await import('/src/audio/engines/engineBrowserProbe.mjs')).probeWorkletEngine(window.qaContext, 'deepfilter', { cycles: 20, durationMs: 250 }));
  console.log('DFN_LIFECYCLE', JSON.stringify({ passed: report.deepfilterLifecycle.passed, cycles: report.deepfilterLifecycle.results.length }));
  let soakPage;
  let soak;
  if (soakMs) {
    soakPage = await browser.newPage(); await prepare(soakPage);
    soak = soakPage.evaluate(async durationMs => {
      const context = new AudioContext({ sampleRate: 48000 }); await context.resume();
      try { return await (await import('/src/audio/engines/engineBrowserProbe.mjs')).probeWorkletEngine(context, 'deepfilter', { durationMs }); }
      finally { await context.close(); }
    }, soakMs);
    console.log('DFN_SOAK_STARTED', soakMs);
  }
  await page.evaluate(async () => { await window.qaContext.close(); window.transportProbe = await (await import('/src/audio/engines/transportBrowserProbe.mjs')).createTransportProbeSession(); });
  for (const engine of ['webrtc', 'rnnoise', 'gtcrn', 'speex', 'deepfilter', 'dtln']) {
    const result = await page.evaluate(engine => window.transportProbe.run(engine, { productionPublishProfile: true }), engine);
    report.transport.push(result);
    console.log('TRANSPORT', JSON.stringify({ engine, passed: result.passed, livekit: result.livekit, p2p: result.p2p, error: result.error }));
    await fs.writeFile(path.join(directory, 'chrome-audio-report.json'), JSON.stringify(report, null, 2));
  }
  if (runFixtures) {
    for (const fixture of ['clean', 'fan', 'keyboard', 'transient']) for (const engine of ['rnnoise', 'gtcrn', 'speex', 'deepfilter', 'dtln']) {
      const result = await page.evaluate(({ engine, fixtureUrl }) => window.transportProbe.run(engine, { fixtureUrl }), { engine, fixtureUrl: `/__audio_qa_inputs/${fixture}.wav` });
      report.fixtures.push({ fixture, ...result });
      console.log('FIXTURE', JSON.stringify({ fixture, engine, passed: result.passed, livekitFrames: result.livekit?.nonzeroFrames, p2pFrames: result.p2p?.nonzeroFrames, error: result.error }));
      await fs.writeFile(path.join(directory, 'chrome-audio-report.json'), JSON.stringify(report, null, 2));
    }
  }
  const recordings = await page.evaluate(() => window.transportProbe.listRecordings());
  report.recordings = recordings;
  for (const recording of recordings) {
    const data = await page.evaluate(id => window.transportProbe.recordingBase64(id), recording.id);
    await fs.writeFile(path.join(directory, `${recording.id}.webm`), Buffer.from(data, 'base64'));
  }
  await page.evaluate(() => window.transportProbe.close());
  if (soak) { report.deepfilterSoak = await soak; console.log('DFN_SOAK', JSON.stringify(report.deepfilterSoak)); }
  for (let i = 0; i < 20 && activeWorkers.size; i++) await new Promise(resolve => setTimeout(resolve, 100));
  report.cleanup = { createdWorkers, activeWorkers: activeWorkers.size,
    mainOpenContexts: await page.evaluate(() => window.qaContexts.size),
    soakOpenContexts: soakPage ? await soakPage.evaluate(() => window.qaContexts.size) : 0 };
  console.log('CLEANUP', JSON.stringify(report.cleanup));
  // Verify the standalone listening artifact without playing any audio.
  const listening = await browser.newPage();
  await listening.goto(new URL(`file:///${directory.replaceAll('\\', '/')}listening.html`).href);
  report.listening = await listening.evaluate(async () => {
    const audios = [...document.querySelectorAll('audio')];
    await Promise.all(audios.map(audio => new Promise(resolve => {
      if (audio.readyState >= 1) return resolve();
      audio.addEventListener('loadedmetadata', resolve, { once: true });
      audio.addEventListener('error', resolve, { once: true });
      setTimeout(resolve, 5000); audio.load();
    })));
    return { audioCount: audios.length, validMetadata: audios.filter(audio => Number.isFinite(audio.duration) && audio.duration > 0).length };
  });
  await listening.screenshot({ path: path.join(directory, 'listening-preview.png'), fullPage: true });
  report.completedAt = new Date().toISOString();
  report.passed = report.engines.every(result => result.passed) && report.dtln.passed && report.deepfilterLifecycle.passed && report.transport.every(result => result.passed)
    && report.fixtures.every(result => result.passed) && (!report.deepfilterSoak || report.deepfilterSoak.passed)
    && report.cleanup.activeWorkers === 0 && report.cleanup.mainOpenContexts === 0 && report.cleanup.soakOpenContexts === 0
    && report.gate.passed && report.listening.audioCount === 6 && report.listening.validMetadata === 6;
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  report.error = { message: error.message, stack: error.stack };
  report.passed = false;
  console.error('FAILED', error.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  await fs.writeFile(path.join(directory, 'chrome-audio-report.json'), JSON.stringify(report, null, 2));
}
console.log('REPORT', path.join(directory, 'chrome-audio-report.json'));
