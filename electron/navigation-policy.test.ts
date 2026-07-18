/**
 * Uses node:test — zero new dependencies. Run via the electron test script
 * (see package.json electron:test), which compiles electron/*.ts and runs
 * node --test over dist-electron/*.test.js.
 *
 * These live in a pure module (no `electron` import) precisely so they can
 * run under plain node, mirroring resolve-path.ts / resolve-path.test.ts.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { isInternalNavigation } from "./navigation-policy.js";

test("allows the packaged app:// origin", () => {
  // THE regression this module exists for. The production renderer loads
  // app://hichat/index.html; before this entry existed, any real navigation
  // inside the packaged app was treated as external — punted to the OS
  // browser and cancelled in-window.
  assert.equal(isInternalNavigation("app://hichat/index.html"), true);
  assert.equal(isInternalNavigation("app://hichat/"), true);
  assert.equal(isInternalNavigation("app://hichat"), true);
  assert.equal(isInternalNavigation("app://hichat/assets/main.js"), true);
});

test("allows file:// (current behavior — legacy production bundle path)", () => {
  assert.equal(isInternalNavigation("file:///C:/app/client/dist/index.html"), true);
  assert.equal(isInternalNavigation("file:///home/u/app/index.html"), true);
});

test("allows the Vite dev server origin", () => {
  assert.equal(isInternalNavigation("http://localhost:3030"), true);
  assert.equal(isInternalNavigation("http://localhost:3030/login"), true);
});

test("blocks arbitrary external https origins", () => {
  assert.equal(isInternalNavigation("https://evil.example"), false);
  assert.equal(isInternalNavigation("https://evil.example/phishing"), false);
  assert.equal(isInternalNavigation("http://evil.example"), false);
});

test("blocks a different app:// host", () => {
  // The scheme alone must not be enough — only our host.
  assert.equal(isInternalNavigation("app://evil/index.html"), false);
  assert.equal(isInternalNavigation("app://evil"), false);
});

test("blocks prefix-extension impersonation of the app host", () => {
  // "app://hichat.evil.example" starts with "app://hichat" as a raw string.
  // A naive startsWith allowlist would let it through; the boundary check
  // must reject it.
  assert.equal(isInternalNavigation("app://hichat.evil.example/x"), false);
  assert.equal(isInternalNavigation("app://hichat-evil/x"), false);
});

test("blocks prefix-extension impersonation of the dev origin", () => {
  // Same class of bug on the http origin: "http://localhost:3030.evil.com"
  // and "http://localhost:30300" both share the allowed prefix.
  assert.equal(isInternalNavigation("http://localhost:3030.evil.example"), false);
  assert.equal(isInternalNavigation("http://localhost:30300"), false);
  assert.equal(isInternalNavigation("http://localhost:3030evil.example"), false);
});

test("blocks dangerous non-navigational schemes", () => {
  assert.equal(isInternalNavigation("javascript:alert(1)"), false);
  assert.equal(isInternalNavigation("data:text/html,<script>alert(1)</script>"), false);
  assert.equal(isInternalNavigation("about:blank"), false);
});

test("blocks malformed and empty input", () => {
  assert.equal(isInternalNavigation(""), false);
  assert.equal(isInternalNavigation("not a url"), false);
  assert.equal(isInternalNavigation("://"), false);
});
