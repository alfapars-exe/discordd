import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyReleaseTagMatchesVersion } from "./verify-release-version.mjs";

const current = { refType: "tag", ref: "refs/tags/v2.11.117", refName: "v2.11.117", packageVersion: "2.11.117" };

test("matching release tag and package version pass", () => {
  assert.deepEqual(verifyReleaseTagMatchesVersion(current), {
    checked: true,
    tagName: "v2.11.117",
    packageVersion: "2.11.117",
  });
});

test("mismatched release tag fails closed", () => {
  assert.throws(
    () => verifyReleaseTagMatchesVersion({ ...current, refName: "v2.11.116" }),
    /does not match package\.json version 2\.11\.117/,
  );
});

test("tag ref is checked even when runner omits the ref type", () => {
  assert.throws(
    () => verifyReleaseTagMatchesVersion({ ...current, refType: "", refName: "", ref: "refs/tags/v2.11.116" }),
    /does not match package\.json version 2\.11\.117/,
  );
});

test("tagless workflow_dispatch branch remains allowed", () => {
  assert.deepEqual(
    verifyReleaseTagMatchesVersion({ refType: "branch", ref: "refs/heads/release-smoke", refName: "release-smoke", packageVersion: "2.11.117" }),
    { checked: false },
  );
});

test("workflow_dispatch selected on a tag still validates version", () => {
  assert.throws(
    () => verifyReleaseTagMatchesVersion({ ...current, refType: "tag", refName: "v2.11.118" }),
    /does not match package\.json version 2\.11\.117/,
  );
});

test("tag release rejects missing version data", () => {
  assert.throws(
    () => verifyReleaseTagMatchesVersion({ ...current, packageVersion: "" }),
    /missing; refusing to build a release/,
  );
});
