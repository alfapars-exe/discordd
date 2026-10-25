// Real loopback LiveKit and WebRTC transport smoke; generated input, no microphone.
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.HICHAT_PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({ executablePath: process.env.HICHAT_CHROME_PATH, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const report = { startedAt: new Date().toISOString(), results: [] };
try {
  const page = await browser.newPage();
  await page.goto(`${process.env.HICHAT_AUDIO_QA_URL ?? 'http://127.0.0.1:3041'}/audio-engine-qa.html`);
  await page.evaluate(async () => { window.probe = await (await import('/src/audio/engines/transportBrowserProbe.mjs')).createTransportProbeSession(); });
  for (const engine of ['webrtc', 'rnnoise', 'gtcrn', 'speex', 'deepfilter', 'dtln']) {
    const result = await page.evaluate(engine => window.probe.run(engine, { record: false, productionPublishProfile: true }), engine);
    report.results.push(result);
    console.log(JSON.stringify({ engine, passed: result.passed, livekit: result.livekit?.nonzeroFrames, p2p: result.p2p?.nonzeroFrames, error: result.error }));
  }
  await page.evaluate(() => window.probe.close());
  report.passed = report.results.length === 6 && report.results.every(result => result.passed);
  if (!report.passed) process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  await browser.close();
  await fs.writeFile(fileURLToPath(new URL('../../artifacts/audio-qa/chrome-transport-report.json', import.meta.url)), JSON.stringify(report, null, 2));
}
