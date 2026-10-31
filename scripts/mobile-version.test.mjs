import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mobileVersion } from './mobile-version.mjs';
test('mobile codes follow root version ordering', () => {
  assert.deepEqual(mobileVersion('2.11.123'), {name:'2.11.123',code:2011123});
  assert.ok(mobileVersion('2.12.0').code > mobileVersion('2.11.999').code);
  assert.ok(mobileVersion('3.0.0').code > mobileVersion('2.999.999').code);
});
test('reject invalid or overflowing platform versions', () => {
  for (const value of ['0.0.0','2.1000.0','2.0.1000','2100.0.1','2.11.123-beta','02.1.1','1.2','-1.0.0']) assert.throws(()=>mobileVersion(value));
});
