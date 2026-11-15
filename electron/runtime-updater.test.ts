import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { startRuntimeUpdater } from "./runtime-updater";

const events = ["update-available", "download-progress", "update-downloaded", "error"];
function fixture() {
  const updater = Object.assign(new EventEmitter(), { checkForUpdates: async () => null });
  const sibling = () => {};
  for (const event of events) updater.on(event, sibling);
  const operations = { updater: updater as unknown as Parameters<typeof startRuntimeUpdater>[0]["updater"], available: () => {}, progress: () => {}, downloaded: () => {}, failed: () => {},
    startPolling: () => () => {} };
  return { updater, sibling, operations };
}

test("failed poller acquisition retires updater subscriptions and preserves siblings", () => {
  const { updater, sibling, operations } = fixture();
  const failure = new Error("poller unavailable");
  operations.startPolling = () => { throw failure; };
  assert.throws(() => startRuntimeUpdater(operations), error => error === failure);
  for (const event of events) assert.deepEqual(updater.listeners(event), [sibling], event);
});

test("failed poller cleanup still retires updater subscriptions once", () => {
  const { updater, sibling, operations } = fixture();
  const failure = new Error("poller cleanup failed");
  let stops = 0;
  let delivered = 0;
  operations.available = () => { delivered++; };
  operations.startPolling = () => () => { stops++; throw failure; };
  const dispose = startRuntimeUpdater(operations);
  const queued = updater.listeners("update-available")[1];
  assert.throws(dispose, error => error === failure);
  for (const event of events) assert.deepEqual(updater.listeners(event), [sibling], event);
  dispose(); assert.equal(stops, 1);
  queued({ version: "late" }); assert.equal(delivered, 0);
});

test("partial subscription failure cleans only listeners acquired by this owner", () => {
  const { updater, sibling, operations } = fixture();
  const failure = new Error("subscription unavailable"), original = updater.on;
  updater.on = (event, listener) => {
    if (event === "update-downloaded") throw failure;
    return original.call(updater, event, listener);
  };
  assert.throws(() => startRuntimeUpdater(operations), error => error === failure);
  for (const event of events) assert.deepEqual(updater.listeners(event), [sibling], event);
});
