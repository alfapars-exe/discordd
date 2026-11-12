import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mobileVersion, syncMobileVersion } from './mobile-version.mjs';
test('mobile codes follow root version ordering', () => {
  assert.deepEqual(mobileVersion('2.11.123'), {name:'2.11.123',code:2011123});
  assert.ok(mobileVersion('2.12.0').code > mobileVersion('2.11.999').code);
  assert.ok(mobileVersion('3.0.0').code > mobileVersion('2.999.999').code);
});
test('reject invalid or overflowing platform versions', () => {
  for (const value of ['0.0.0','2.1000.0','2.0.1000','2100.0.1','2.11.123-beta','02.1.1','1.2','-1.0.0']) assert.throws(()=>mobileVersion(value));
});

test('rejects divergent Swift revisions for the same Capacitor version', t => {
  const root = mkdtempSync(join(tmpdir(), 'hichat-mobile-version-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const repo = fileURLToPath(new URL('../', import.meta.url));
  const lock = 'client/ios/App/CapApp-SPM/Package.resolved';
  for (const path of ['package.json', 'client/package-lock.json', 'client/android/app/build.gradle',
    'client/ios/App/App.xcodeproj/project.pbxproj', 'client/ios/App/CapApp-SPM/Package.swift',
    lock, 'client/ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved']) {
    mkdirSync(dirname(join(root, path)), {recursive: true});
    cpSync(join(repo, path), join(root, path));
  }
  syncMobileVersion(root, true);
  const path = join(root, lock);
  const data = JSON.parse(readFileSync(path, 'utf8'));
  data.pins.find(pin => pin.identity === 'capacitor-swift-pm').state.revision = 'a'.repeat(40);
  writeFileSync(path, JSON.stringify(data));
  assert.throws(() => syncMobileVersion(root, true), /Capacitor revisions differ/);
});
