import assert from "node:assert/strict";
import test from "node:test";
import { OverlayWelcomeLifecycle } from "./overlay-welcome";

test("welcome requires actual show, deduplicates updates, expires without replay and follows real context/hide", () => {
  const lifecycle = new OverlayWelcomeLifecycle();
  assert.equal(lifecycle.current(0), null);
  const first = lifecycle.shown("game:a", true, 1000)!;
  assert.deepEqual(first, { id: 1, expiresAt: 6000 });
  assert.deepEqual(lifecycle.shown("game:a", true, 5000), first);
  assert.equal(lifecycle.current(6000), null);
  assert.equal(lifecycle.shown("game:a", true, 7000), null);
  const next = lifecycle.shown("game:b", true, 8000)!;
  assert.equal(next.id, 2);
  lifecycle.hide();
  assert.equal(lifecycle.current(8000), null);
  assert.equal(lifecycle.shown("game:b", true, 9000)!.id, 3);
});

test("default-off and mid-activation preference changes never invent an activation; duration respects accessibility", () => {
  const lifecycle = new OverlayWelcomeLifecycle();
  assert.equal(lifecycle.shown("desktop", false, 1000), null);
  assert.equal(lifecycle.shown("desktop", true, 2000), null);
  lifecycle.hide();
  assert.equal(lifecycle.shown("desktop", true, 3000, 20000)!.expiresAt, 23000);
  assert.equal(lifecycle.shown("desktop", false, 4000), null);
  assert.equal(lifecycle.shown("desktop", true, 5000), null);
});
