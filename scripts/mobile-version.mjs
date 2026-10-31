import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function mobileVersion(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('Mobile release requires major.minor.patch');
  const [major, minor, patch] = version.split('.').map(Number);
  const code = major * 1_000_000 + minor * 1_000 + patch;
  if (minor > 999 || patch > 999 || !Number.isSafeInteger(code) || code < 1 || code > 2_100_000_000) throw new Error('Mobile version exceeds platform bounds');
  return { name: version, code };
}

export function syncMobileVersion(root, check = false) {
  const version = mobileVersion(JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version);
  const files = [
    ['client/android/app/build.gradle', text => text.replace(/versionCode \d+/g, `versionCode ${version.code}`).replace(/versionName "[^"]+"/g, `versionName "${version.name}"`)],
    ['client/ios/App/App.xcodeproj/project.pbxproj', text => text.replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${version.name};`).replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version.name};`)],
  ];
  for (const [name, transform] of files) {
    const path = resolve(root, name), before = readFileSync(path, 'utf8'), after = transform(before);
    if (check && before !== after) throw new Error(`Stale mobile version: ${name}`);
    if (!check && before !== after) writeFileSync(path, after);
  }
  const lock = JSON.parse(readFileSync(resolve(root, 'client/package-lock.json'), 'utf8'));
  const capacitor = lock.packages['node_modules/@capacitor/core'].version;
  for (const name of ['ios', 'android', 'cli']) {
    if (lock.packages[`node_modules/@capacitor/${name}`].version !== capacitor) throw new Error('Capacitor npm versions differ');
  }
  const swift = readFileSync(resolve(root, 'client/ios/App/CapApp-SPM/Package.swift'), 'utf8');
  if (!swift.includes(`exact: "${capacitor}"`)) throw new Error('Run cap sync to align native Capacitor');
  for (const name of ['client/ios/App/CapApp-SPM/Package.resolved', 'client/ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved']) {
    const pins = JSON.parse(readFileSync(resolve(root, name), 'utf8')).pins;
    if (pins.find(pin => pin.identity === 'capacitor-swift-pm')?.state.version !== capacitor) throw new Error(`Stale native lock: ${name}`);
  }
  return version;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(syncMobileVersion(fileURLToPath(new URL('../', import.meta.url)), process.argv.includes('--check')));
}
