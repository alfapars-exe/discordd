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
    ['client/android/app/build.gradle', [
      [/^(\s*versionCode\s+)\d+/gm, version.code],
      [/^(\s*versionName\s+)"[^"]+"/gm, `"${version.name}"`],
    ]],
    ['client/ios/App/App.xcodeproj/project.pbxproj', [
      [/^(\s*CURRENT_PROJECT_VERSION\s*=\s*)[^;]+/gm, version.name],
      [/^(\s*MARKETING_VERSION\s*=\s*)[^;]+/gm, version.name],
    ]],
  ];
  const updates = new Map();
  for (const [name, fields] of files) {
    const path = resolve(root, name);
    const before = readFileSync(path, 'utf8');
    let after = before;
    for (const [pattern, value] of fields) {
      let found = false;
      after = after.replace(pattern, (_, prefix) => {
        found = true;
        return prefix + value;
      });
      if (!found) throw new Error(`Missing mobile version field in ${name}: ${pattern}`);
    }
    if (check && before !== after) throw new Error(`Stale mobile version: ${name}`);
    if (before !== after) updates.set(path, after);
  }
  const lock = JSON.parse(readFileSync(resolve(root, 'client/package-lock.json'), 'utf8'));
  const capacitor = lock.packages['node_modules/@capacitor/core'].version;
  for (const name of ['ios', 'android', 'cli']) {
    if (lock.packages[`node_modules/@capacitor/${name}`].version !== capacitor) throw new Error('Capacitor npm versions differ');
  }
  const swift = readFileSync(resolve(root, 'client/ios/App/CapApp-SPM/Package.swift'), 'utf8');
  if (!swift.includes(`exact: "${capacitor}"`)) throw new Error('Run cap sync to align native Capacitor');
  let capacitorRevision;
  for (const name of ['client/ios/App/CapApp-SPM/Package.resolved', 'client/ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved']) {
    const pins = JSON.parse(readFileSync(resolve(root, name), 'utf8')).pins;
    const state = pins.find(pin => pin.identity === 'capacitor-swift-pm')?.state;
    if (state?.version !== capacitor || !/^[0-9a-f]{40}$/.test(state.revision)) throw new Error(`Stale native lock: ${name}`);
    if (capacitorRevision && state.revision !== capacitorRevision) throw new Error(`Capacitor revisions differ: ${name}`);
    capacitorRevision = state.revision;
  }
  for (const [path, content] of updates) writeFileSync(path, content);
  return version;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(syncMobileVersion(fileURLToPath(new URL('../', import.meta.url)), process.argv.includes('--check')));
}
