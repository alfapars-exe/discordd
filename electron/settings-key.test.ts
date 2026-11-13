import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_APP_SETTINGS, isAppSettingKey } from "./settings";

test("persisted settings keys include defaults and exclude inherited or non-string names", () => {
  for (const key of Object.keys(DEFAULT_APP_SETTINGS)) assert.equal(isAppSettingKey(key), true);
  for (const key of ["constructor", "toString", "valueOf", "__proto__", "hasOwnProperty", "windowBounds", "unknown", null, {}, 1]) {
    assert.equal(isAppSettingKey(key), false);
  }
});
