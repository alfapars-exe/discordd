// Deliberate asset failures exercise real graph fallback; physical capture policy is simulated.
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.HICHAT_PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({ executablePath: process.env.HICHAT_CHROME_PATH, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const report = { startedAt: new Date().toISOString(), cases: [] };
try {
  for (const scenario of ['corrupt-deepfilter', 'unavailable-audioworklet', 'unverified-browser-suppression', 'locked-browser-suppression', 'late-locked-browser-suppression']) {
    const page = await browser.newPage();
    if (scenario === 'corrupt-deepfilter') await page.route('**/deepfilter/v2/pkg/df_bg.wasm', route => route.fulfill({ status: 200, body: 'deliberately invalid QA bytes' }));
    if (scenario === 'unavailable-audioworklet') await page.addInitScript(() => {
      // Simulate an unsupported capability while retaining the real native
      // MediaStream clone, AudioContext, graph and receiver PCM measurement.
      Object.defineProperty(AudioContext.prototype, 'audioWorklet', { get: () => undefined, configurable: true });
    });
    await page.goto(`${process.env.HICHAT_AUDIO_QA_URL ?? 'http://127.0.0.1:3041'}/audio-engine-qa.html`);
    const requestedEngine = scenario === 'unverified-browser-suppression' ? 'webrtc' : 'deepfilter';
    const result = await page.evaluate(async ({ requestedEngine, reportBrowserSuppression }) =>
      (await import('/src/audio/engines/engineBrowserProbe.mjs')).probePipelineFallback(requestedEngine, reportBrowserSuppression),
    { requestedEngine, reportBrowserSuppression: scenario === 'locked-browser-suppression' ? 'locked' : scenario === 'late-locked-browser-suppression' ? 'late-locked' : scenario === 'unavailable-audioworklet' });
    const expectedEngine = scenario === 'corrupt-deepfilter' ? 'rnnoise' : scenario === 'unverified-browser-suppression' ? 'none' : 'webrtc';
    const passed = result.finite && result.power > 1e-10 && result.status.phase === 'fallback'
      && result.status.activeEngine === expectedEngine && result.status.requestedEngine === requestedEngine
      && result.status.gateAvailable === (scenario !== 'unavailable-audioworklet')
      && (!scenario.endsWith('locked-browser-suppression') || result.status.errorCode === 'browser-noise-suppression-locked')
      && (scenario !== 'late-locked-browser-suppression' || result.initialStatus.activeEngine === 'deepfilter');
    report.cases.push({ scenario, ...result, passed });
    console.log(JSON.stringify({ scenario, passed, status: result.status, power: result.power }));
    await page.close();
  }
  report.passed = report.cases.every(result => result.passed);
  if (!report.passed) process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  await browser.close();
  await fs.writeFile(fileURLToPath(new URL('../../artifacts/audio-qa/chrome-fallback-report.json', import.meta.url)), JSON.stringify(report, null, 2));
}
