/**
 * Tests for the credential surface exposed to the renderer
 * (pentest 2026-07-26, H-09).
 *
 * Only toPublicCredentials is covered. The read/write path needs safeStorage,
 * which needs a running Electron app; importing this module is safe because
 * nothing here calls into it.
 *
 * The property is a negative one — "the password is not in the result" — so
 * the assertions check the serialised output rather than a field, because a
 * future shape change could reintroduce it under a different key and a
 * `result.password === undefined` check would still pass.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { toPublicCredentials } from "./credentials";

test("strips the password from what the renderer receives", () => {
  const result = toPublicCredentials({
    username: "ada",
    password: "hunter2",
  });

  assert.deepEqual(result, { username: "ada" });
  assert.equal(JSON.stringify(result).includes("hunter2"), false);
  assert.deepEqual(Object.keys(result!), ["username"]);
});

test("keeps the username, so autofill still works", () => {
  // Without this, "return null always" would satisfy the test above and quietly
  // break Remember Me.
  assert.equal(toPublicCredentials({ username: "ada", password: "x" })?.username, "ada");
});

test("passes null through for a device with nothing stored", () => {
  assert.equal(toPublicCredentials(null), null);
});
