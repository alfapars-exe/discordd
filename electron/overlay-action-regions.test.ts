import assert from "node:assert/strict";
import test from "node:test";
import { INBOX_ACTION_HEIGHT, INBOX_ACTION_WIDTH, overlayActionAt, overlayNotificationActionAt, overlayNotificationReplyRowAt } from "./overlay-action-regions";

const bounds = { x: -1920, y: -100, width: 200, height: 100 };

test("maps only the two fixed 40-by-40 action rectangles in screen DIP", () => {
  assert.equal(overlayActionAt({ x: -1816, y: -48 }, bounds, true), "toggle-mute");
  assert.equal(overlayActionAt({ x: -1777, y: -9 }, bounds, true), "toggle-mute");
  assert.equal(overlayActionAt({ x: -1768, y: -48 }, bounds, true), "toggle-deafen");
  assert.equal(overlayActionAt({ x: -1737, y: -9 }, bounds, true), "toggle-deafen");
});

test("keeps button edges exclusive and the eight-pixel gap inert", () => {
  assert.equal(overlayActionAt({ x: -1817, y: -48 }, bounds, true), null, "left edge outside mute");
  assert.equal(overlayActionAt({ x: -1776, y: -48 }, bounds, true), null, "mute right edge is exclusive");
  assert.equal(overlayActionAt({ x: -1772, y: -28 }, bounds, true), null, "gap between buttons");
  assert.equal(overlayActionAt({ x: -1768, y: -48 }, bounds, true), "toggle-deafen", "deafen left edge is inclusive");
  assert.equal(overlayActionAt({ x: -1728, y: -48 }, bounds, true), null, "deafen right edge is exclusive");
  assert.equal(overlayActionAt({ x: -1768, y: -8 }, bounds, true), null, "bottom edge is exclusive");
});

test("does nothing when authorization/visibility is unavailable", () => {
  assert.equal(overlayActionAt({ x: -1816, y: -48 }, bounds, false), null);
});

test("rejects nonfinite points, invalid bounds, and windows smaller than the toolbar", () => {
  assert.equal(overlayActionAt({ x: Number.NaN, y: -48 }, bounds, true), null);
  assert.equal(overlayActionAt({ x: -1816, y: Number.POSITIVE_INFINITY }, bounds, true), null);
  assert.equal(overlayActionAt({ x: -1816, y: -48 }, { ...bounds, x: Number.NaN }, true), null);
  assert.equal(overlayActionAt({ x: -1816, y: -48 }, { ...bounds, width: 111 }, true), null);
  assert.equal(overlayActionAt({ x: -1816, y: -48 }, { ...bounds, height: 63 }, true), null);
});

test("notification action accepts only its exact fixed button rectangle", () => {
  const button = { x: 500, y: 700, width: INBOX_ACTION_WIDTH, height: INBOX_ACTION_HEIGHT };
  assert.equal(overlayNotificationActionAt({ x: 500, y: 700 }, button, true), "open-inbox");
  assert.equal(overlayNotificationActionAt({ x: 587.99, y: 719.99 }, button, true), "open-inbox");
  assert.equal(overlayNotificationActionAt({ x: 588, y: 710 }, button, true), null, "right edge is exclusive");
  assert.equal(overlayNotificationActionAt({ x: 510, y: 720 }, button, true), null, "bottom edge is exclusive");
  assert.equal(overlayNotificationActionAt({ x: 510, y: 710 }, button, false), null, "authorization is required");
  assert.equal(overlayNotificationActionAt({ x: 510, y: 710 }, { ...button, width: INBOX_ACTION_WIDTH - 1 }, true), null);
});


test("reply row targets exclude gaps, hidden rows and nonfinite coordinates", () => {
  const panel = { x: -300, y: 100, width: 88, height: 116 };
  assert.equal(overlayNotificationReplyRowAt({ x: -300, y: 126 }, panel, 3), 0);
  assert.equal(overlayNotificationReplyRowAt({ x: -213, y: 145.99 }, panel, 3), 0);
  assert.equal(overlayNotificationReplyRowAt({ x: -280, y: 146 }, panel, 3), null);
  assert.equal(overlayNotificationReplyRowAt({ x: -280, y: 158 }, panel, 3), 1);
  assert.equal(overlayNotificationReplyRowAt({ x: -280, y: 190 }, panel, 3), 2);
  assert.equal(overlayNotificationReplyRowAt({ x: -212, y: 126 }, panel, 3), null);
  assert.equal(overlayNotificationReplyRowAt({ x: Number.NaN, y: 126 }, panel, 3), null);
  assert.equal(overlayNotificationReplyRowAt({ x: -280, y: 158 }, { ...panel, height: 52 }, 1), null);
});
