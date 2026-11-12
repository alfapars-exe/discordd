const { readdirSync } = require('node:fs');
const { join } = require('node:path');
const { listPackage } = require('@electron/asar');
const archives = readdirSync('release', { recursive: true }).map(String).filter(name => name.endsWith('app.asar'));
if (!archives.length) throw new Error('No packaged application found');
for (const name of archives) {
  const files = listPackage(join('release', name));
  if (!files.some(file => /client[\\/]dist[\\/]index.html$/.test(file))) throw new Error('Missing bundled frontend');
  const desktopFiles = files.map(file => file.replaceAll('\\', '/').replace(/^\//, ''))
    .filter(file => file.startsWith('dist-electron/'));
  if (!desktopFiles.includes('dist-electron/main.js')) throw new Error('Missing Electron entry point');
  const testFile = desktopFiles.find(file => file.endsWith('.test.js') || file.endsWith('-test-fixture.js'));
  if (testFile) throw new Error('Packaged Electron test file: ' + testFile);
  if (files.some(file => file.endsWith('.map'))) throw new Error('Packaged source map found');
}
console.log('Packaged frontend present; no source maps in application archives');
