import assert from "node:assert/strict";
import test from "node:test";
import { createUpdateInstallationGate } from "./update-installation";

test("different update entry points share one installation attempt", () => {
  const request = createUpdateInstallationGate(), calls: string[] = [];
  request(() => { calls.push("notification"); });
  request(() => { calls.push("tray"); });
  request(() => { calls.push("renderer"); });
  assert.deepEqual(calls, ["notification"]);
});

test("a synchronous installer failure permits retry and preserves the original error", () => {
  const request = createUpdateInstallationGate(), failure = new Error("installer unavailable");
  assert.throws(() => request(() => { throw failure; }), error => error === failure);
  let calls = 0;
  request(() => { calls++; }); request(() => { calls++; });
  assert.equal(calls, 1);
});

test("reentrant install requests cannot start another installer", () => {
  const request = createUpdateInstallationGate();
  let nested = false;
  request(() => { request(() => { nested = true; }); });
  assert.equal(nested, false);
});
