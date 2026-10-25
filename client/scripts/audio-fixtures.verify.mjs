// Local WAV files are supplied as test inputs only. Model/transport requests
// still reach the real Vite and LiveKit servers; no microphone is opened.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const { chromium } = await import(process.env.HICHAT_PLAYWRIGHT_MODULE ?? 'playwright');
const baseUrl = process.env.HICHAT_AUDIO_QA_URL ?? 'http://127.0.0.1:3041';
const directory = fileURLToPath(new URL('../../artifacts/audio-qa/', import.meta.url));
const browser = await chromium.launch({ executablePath: process.env.HICHAT_CHROME_PATH, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const report = { startedAt: new Date().toISOString(), captureConstraintsSimulated: true, fixtureServing: 'exact local WAV bytes through isolated Playwright input routes', results: [], recordings: [] };
report.fixtureInputs = await Promise.all(['clean', 'fan', 'keyboard', 'transient'].map(async fixture => {
  const bytes = await fs.readFile(path.join(directory, 'inputs', `${fixture}.wav`));
  return { fixture, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}));
const workers = new Set();
let createdWorkers = 0;
try {
  const page = await browser.newPage();
  page.on('worker', worker => { createdWorkers++; workers.add(worker); worker.on('close', () => workers.delete(worker)); });
  await page.addInitScript(() => {
    const Original = window.AudioContext;
    window.qaContexts = new Set();
    window.AudioContext = class extends Original {
      constructor(...args) { super(...args); window.qaContexts.add(this); }
      async close() { try { await super.close(); } finally { if (this.state === 'closed') window.qaContexts.delete(this); } }
    };
  });
  await page.route('**/__audio_qa_inputs/*.wav', async route => {
    const name = path.basename(new URL(route.request().url()).pathname);
    if (!['clean.wav', 'fan.wav', 'keyboard.wav', 'transient.wav'].includes(name)) return route.abort();
    await route.fulfill({ status: 200, contentType: 'audio/wav', path: path.join(directory, 'inputs', name) });
  });
  await page.goto(`${baseUrl}/audio-engine-qa.html`);
  await page.evaluate(async () => { window.probe = await (await import('/src/audio/engines/transportBrowserProbe.mjs?fixtures=2')).createTransportProbeSession(); });
  for (const fixture of ['clean', 'fan', 'keyboard', 'transient']) for (const engine of ['rnnoise', 'gtcrn', 'speex', 'deepfilter', 'dtln']) {
    const result = await page.evaluate(({ engine, fixture }) => window.probe.run(engine, { fixtureUrl: `/__audio_qa_inputs/${fixture}.wav` }), { engine, fixture });
    for (const recording of result.recordings ?? []) {
      const data = await page.evaluate(id => window.probe.recordingBase64(id), recording.id);
      const filename = `remote-${engine}-${fixture}-${recording.transport}.webm`;
      await fs.writeFile(path.join(directory, filename), Buffer.from(data, 'base64'));
      report.recordings.push({ ...recording, fixture, filename });
    }
    report.results.push({ fixture, ...result });
    console.log('FIXTURE', JSON.stringify({ fixture, engine, passed: result.passed, livekit: result.livekit?.nonzeroFrames, p2p: result.p2p?.nonzeroFrames, frames: result.livekit?.frames, error: result.error }));
    await fs.writeFile(path.join(directory, 'chrome-fixtures-report.json'), JSON.stringify(report, null, 2));
  }
  await page.evaluate(() => window.probe.close());
  for (let i = 0; i < 20 && workers.size; i++) await new Promise(resolve => setTimeout(resolve, 100));
  report.cleanup = { createdWorkers, activeWorkers: workers.size, openAudioContexts: await page.evaluate(() => window.qaContexts.size) };
  report.passed = report.results.length === 20 && report.results.every(result => result.passed) && report.cleanup.activeWorkers === 0 && report.cleanup.openAudioContexts === 0;
  if (!report.passed) process.exitCode = 1;
  report.completedAt = new Date().toISOString();
  console.log('CLEANUP', JSON.stringify(report.cleanup));
} catch (error) {
  report.error = { message: error.message, stack: error.stack }; report.passed = false; process.exitCode = 1;
} finally {
  await browser.close();
  await fs.writeFile(path.join(directory, 'chrome-fixtures-report.json'), JSON.stringify(report, null, 2));
}
