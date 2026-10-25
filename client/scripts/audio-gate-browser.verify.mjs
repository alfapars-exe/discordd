import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.HICHAT_PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({ executablePath: process.env.HICHAT_CHROME_PATH, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage(); await page.goto(`${process.env.HICHAT_AUDIO_QA_URL ?? 'http://127.0.0.1:3041'}/audio-engine-qa.html`);
  const report = await page.evaluate(async () => (await import('/src/audio/engines/engineBrowserProbe.mjs')).probeGateBehavior());
  await fs.writeFile(fileURLToPath(new URL('../../artifacts/audio-qa/chrome-gate-report.json', import.meta.url)), JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
  if (!report.passed) process.exitCode = 1;
} finally { await browser.close(); }
