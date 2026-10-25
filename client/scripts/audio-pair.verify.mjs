// Narrow same-clock DFN diagnostic; preserve the primary comparison matrix.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const { chromium } = await import(process.env.HICHAT_PLAYWRIGHT_MODULE ?? 'playwright');
const directory = fileURLToPath(new URL('../../artifacts/audio-qa/', import.meta.url));
const input = await fs.readFile(path.join(directory, 'inputs', 'transient.wav'));
const report = { startedAt: new Date().toISOString(), input: { file: 'inputs/transient.wav', bytes: input.length,
  sha256: createHash('sha256').update(input).digest('hex') }, recordings: [] };
const browser = await chromium.launch({ executablePath: process.env.HICHAT_CHROME_PATH, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage();
  await page.route('**/__audio_qa_inputs/transient.wav', route => route.fulfill({ status: 200, contentType: 'audio/wav', body: input }));
  await page.goto(`${process.env.HICHAT_AUDIO_QA_URL ?? 'http://127.0.0.1:3041'}/audio-engine-qa.html`);
  await page.evaluate(async () => { window.probe = await (await import('/src/audio/engines/transportBrowserProbe.mjs')).createTransportProbeSession(); });
  report.result = await page.evaluate(() => window.probe.run('deepfilter', {
    fixtureUrl: '/__audio_qa_inputs/transient.wav', diagnosticPair: true, productionPublishProfile: false,
  }));
  for (const recording of report.result.recordings ?? []) {
    const data = await page.evaluate(id => window.probe.recordingBase64(id), recording.id);
    const filename = recording.stage === 'local-remote-pair' ? 'dfn-transient-paired-repro.wav' : `dfn-transient-repro-${recording.transport}.webm`;
    await fs.writeFile(path.join(directory, filename), Buffer.from(data, 'base64'));
    report.recordings.push({ ...recording, filename });
  }
  await page.evaluate(() => window.probe.close());
  report.passed = report.result.passed && report.recordings.some(recording => recording.stage === 'local-remote-pair' && recording.bytes > 44);
  if (!report.passed) process.exitCode = 1;
  console.log(JSON.stringify({ passed: report.passed, transportPassed: report.result.passed, recordings: report.recordings }));
} finally {
  report.completedAt = new Date().toISOString();
  await browser.close();
  await fs.writeFile(path.join(directory, 'dfn-transient-paired-repro.json'), JSON.stringify(report, null, 2));
}
