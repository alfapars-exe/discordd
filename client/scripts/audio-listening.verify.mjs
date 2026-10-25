// Validate all local listening sources without autoplay or microphone permission.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.HICHAT_PLAYWRIGHT_MODULE ?? 'playwright');
const directory = fileURLToPath(new URL('../../artifacts/audio-qa/', import.meta.url));
const browser = await chromium.launch({ executablePath: process.env.HICHAT_CHROME_PATH, headless: true });
const report = { startedAt: new Date().toISOString(), results: [] };
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1080 } });
  await page.goto(pathToFileURL(path.join(directory, 'listening.html')).href);
  for (const recordingPath of ['offline', 'livekit', 'p2p']) for (const fixture of ['clean', 'fan', 'keyboard', 'transient']) {
    await page.selectOption('#path', recordingPath); await page.selectOption('#fixture', fixture);
    const result = await page.evaluate(async ({ recordingPath, fixture }) => {
      const players = [...document.querySelectorAll('audio')];
      await Promise.all(players.map(player => new Promise(resolve => {
        const finish = () => { clearTimeout(timer); player.removeEventListener('loadedmetadata', finish); player.removeEventListener('error', finish); resolve(); };
        const timer = setTimeout(finish, 5000);
        player.addEventListener('loadedmetadata', finish); player.addEventListener('error', finish); player.load();
      })));
      const results = players.map(player => {
        const expected = player.dataset.engine === 'input' ? `inputs/${fixture}.wav` : recordingPath === 'offline'
          ? `${player.dataset.engine}-${fixture}.wav` : `remote-${player.dataset.engine}-${fixture}-${recordingPath}.webm`;
        return { engine: player.dataset.engine, src: player.getAttribute('src'), duration: player.duration,
          // MediaRecorder WebM may omit duration metadata. FFmpeg separately
          // verifies the complete decoded duration of every remote recording.
          metadataLoaded: player.readyState >= 1 && !player.error, expectedSource: player.getAttribute('src') === expected };
      });
      return { recordingPath, fixture, players: results, passed: results.length === 6 && results.every(player => player.metadataLoaded && player.expectedSource) };
    }, { recordingPath, fixture });
    report.results.push(result);
  }
  await page.selectOption('#path', 'offline'); await page.selectOption('#fixture', 'fan');
  await page.evaluate(async () => Promise.all([...document.querySelectorAll('audio')].map(player => new Promise(resolve => {
    player.addEventListener('loadedmetadata', resolve, { once: true }); player.load();
  }))));
  await page.screenshot({ path: path.join(directory, 'listening-preview.png'), fullPage: true });
  report.passed = report.results.length === 12 && report.results.every(result => result.passed);
  if (!report.passed) process.exitCode = 1;
  console.log(JSON.stringify({ passed: report.passed, combinations: report.results.length, validPlayers: report.results.reduce((sum, result) => sum + result.players.filter(player => player.metadataLoaded && player.expectedSource).length, 0) }));
} finally {
  report.completedAt = new Date().toISOString();
  await browser.close();
  await fs.writeFile(path.join(directory, 'listening-ui-report.json'), JSON.stringify(report, null, 2));
}
