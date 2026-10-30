const { readdirSync } = require('node:fs');
const { join } = require('node:path');
const { listPackage } = require('@electron/asar');
const archives = readdirSync('release', { recursive: true }).map(String).filter(name => name.endsWith('app.asar'));
if (!archives.length) throw new Error('No packaged application found');
for (const name of archives) {
  const files = listPackage(join('release', name));
  if (!files.some(file => /client[\\/]dist[\\/]index.html$/.test(file))) throw new Error('Missing bundled frontend');
  if (files.some(file => file.endsWith('.map'))) throw new Error('Packaged source map found');
}
console.log('Packaged frontend present; no source maps in application archives');
