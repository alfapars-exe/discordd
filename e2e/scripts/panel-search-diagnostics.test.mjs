import assert from "node:assert/strict";
import test from "node:test";
import { createPanelSearchDiagnostics } from "./panel-search-diagnostics.mjs";

test("preserves synchronous value, receiver and thrown error identity", () => {
  const d = createPanelSearchDiagnostics();
  const error = new Error("fixture failure");
  const value = {};
  const target = { value, read() { return this.value; }, fail() { throw error; } };
  assert.equal(d.wrap(target, "snapshot", ["read", "fail"]), target);
  assert.equal(target.read(), value);
  assert.throws(() => target.fail(), actual => actual === error);
  assert.deepEqual(d.failures, [{ phase: "snapshot.fail", name: "Error", message: "fixture failure" }]);
});

test("preserves resolved and rejected promise identity", async () => {
  const d = createPanelSearchDiagnostics();
  const ready = Promise.resolve({});
  const error = new Error("page failed");
  const failed = Promise.reject(error);
  assert.equal(d.observe("ready", () => ready), ready);
  assert.equal(d.observe("page", () => failed), failed);
  await assert.rejects(failed, actual => actual === error);
  assert.equal(d.failures.length, 1);
  assert.equal(d.failures[0].phase, "page");
});

test("bounds diagnostics while retaining the first cause", () => {
  const d = createPanelSearchDiagnostics(3);
  for (let i = 0; i < 10; i++) assert.throws(() => d.observe("write", () => { throw new Error(String(i)); }));
  assert.deepEqual(d.failures.map(row => row.message), ["0", "8", "9"]);
  d.reset();
  assert.deepEqual(d.failures, []);
});

test("unprintable rejection metadata cannot replace the original failure", async () => {
  const d = createPanelSearchDiagnostics();
  const error = {
    get name() { throw new Error("name getter"); },
    get message() { throw new Error("message getter"); },
  };
  assert.throws(() => d.observe("sync", () => { throw error; }), actual => actual === error);
  const rejected = Promise.reject(error);
  assert.equal(d.observe("async", () => rejected), rejected);
  await assert.rejects(rejected, actual => actual === error);
  assert.deepEqual(d.failures.map(row => row.message), ["Unprintable failure", "Unprintable failure"]);
});

test("records bounded names and messages without copying error properties", () => {
  const d = createPanelSearchDiagnostics();
  const error = { name: "N".repeat(100), message: "M".repeat(1000), privatePayload: "not diagnostic data" };
  assert.throws(() => d.observe("P".repeat(100), () => { throw error; }), actual => actual === error);
  assert.deepEqual(Object.keys(d.failures[0]), ["phase", "name", "message"]);
  assert.equal(d.failures[0].phase.length, 64);
  assert.equal(d.failures[0].name.length, 64);
  assert.equal(d.failures[0].message.length, 256);
});

test("observes native aborts once and wraps pool frontiers without changing results", () => {
  const d = createPanelSearchDiagnostics();
  const listeners = new Map();
  const db = { addEventListener(name, handler) { assert.ok(!listeners.has(name)); listeners.set(name, handler); } };
  d.watchDatabase(db); d.watchDatabase(db);
  listeners.get("abort")({ target: { error: new Error("native abort") } });
  const error = new Error("writer unavailable");
  const frontier = { append() { throw error; }, drain() {}, dispose() {} };
  const pool = { create: () => frontier, close() {} };
  assert.equal(d.wrapPool(pool).create(), frontier);
  assert.throws(() => frontier.append(), actual => actual === error);
  assert.deepEqual(d.failures.map(row => row.phase), ["idb.abort", "spool.append"]);
});
