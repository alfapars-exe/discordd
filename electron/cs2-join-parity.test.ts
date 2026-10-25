import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseCS2SteamInvite, buildCS2SteamJoinURI } from "./cs2-join-contract";
test("shared CS2 wire parity corpus agrees with strict native parser and fixed builder", () => {
  const rows = JSON.parse(readFileSync(path.join(__dirname, "..", "testdata", "cs2-join-parity.json"), "utf8")) as Array<{ name: string; invite: string; valid: boolean }>;
  assert.ok(rows.length >= 30);
  for (const row of rows) {
    const value = parseCS2SteamInvite(row.invite);
    assert.equal(value !== null, row.valid, row.name);
    assert.equal(buildCS2SteamJoinURI(value), row.valid ? row.invite : null, row.name);
  }
});
