import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import type { App, WebContents } from "electron";
import { observeOverlayRenderers } from "./overlay-renderer-lifecycle";

function harness() {
  const app = new EventEmitter();
  const main = new EventEmitter(), other = new EventEmitter();
  let current = main;
  const calls: unknown[][] = [];
  const dispose = observeOverlayRenderers({
    app: app as App,
    mainContents: () => current as WebContents,
    retire: contents => { calls.push(["retire", contents]); },
    revokeMain: () => { calls.push(["revoke", current]); },
  });
  const create = (contents: EventEmitter) => app.emit("web-contents-created", {}, contents);
  return { app, main, other, calls, dispose, create, rotate: () => { current = other; } };
}

test("only current main renderer crash or main-document navigation revokes overlay policy", () => {
  const h = harness(); h.create(h.main); h.create(h.other);
  h.other.emit("render-process-gone");
  h.main.emit("did-start-navigation", {}, "fixture", true, true);
  h.main.emit("did-start-navigation", {}, "fixture", false, false);
  assert.deepEqual(h.calls, []);
  h.main.emit("render-process-gone");
  h.main.emit("did-start-navigation", {}, "fixture", false, true);
  assert.deepEqual(h.calls, [["revoke", h.main], ["revoke", h.main]]);
  h.rotate(); h.main.emit("render-process-gone"); h.other.emit("render-process-gone");
  assert.deepEqual(h.calls[h.calls.length - 1], ["revoke", h.other]);
  assert.equal(h.calls.length, 3);
  h.dispose();
});

test("destroyed contents retire once and release their listeners even for queued callbacks", () => {
  const h = harness(); h.create(h.main);
  const queued = h.main.listeners("render-process-gone")[0];
  h.main.emit("destroyed"); h.main.emit("destroyed"); queued();
  assert.deepEqual(h.calls, [["retire", h.main]]);
  for (const name of ["destroyed", "render-process-gone", "did-start-navigation"]) assert.equal(h.main.listenerCount(name), 0);
  h.dispose();
});

test("disposal removes only owned listeners and ignores retained or future creation callbacks", () => {
  const h = harness();
  const sibling = () => {};
  h.app.on("web-contents-created", sibling);
  h.main.on("render-process-gone", sibling);
  h.create(h.main); h.create(h.main);
  assert.equal(h.main.listenerCount("render-process-gone"), 2, "duplicate creation cannot duplicate owner subscriptions");
  const created = h.app.listeners("web-contents-created")[0];
  const crashed = h.main.listeners("render-process-gone")[1];
  const destroyed = h.main.listeners("destroyed")[0];
  h.dispose(); h.dispose();
  assert.deepEqual(h.app.listeners("web-contents-created"), [sibling]);
  assert.deepEqual(h.main.listeners("render-process-gone"), [sibling]);
  created({}, h.other); crashed(); destroyed(); h.create(h.other);
  assert.equal(h.other.eventNames().length, 0);
  assert.deepEqual(h.calls, []);
});
