import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
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

test("later unrelated updater errors do not reopen a successful installation gate", () => {
  const request = createUpdateInstallationGate(), errors = new EventEmitter();
  errors.on("error", () => {});
  let calls = 0;
  request(() => { calls++; }, errors);
  assert.equal(errors.listenerCount("error"), 1);
  errors.emit("error", new Error("later update check failed"));
  request(() => { calls++; }, errors);
  assert.equal(calls, 1);
});
