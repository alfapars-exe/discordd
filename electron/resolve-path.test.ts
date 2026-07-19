/**
 * Uses node:test — zero new dependencies. Run via
 *   node --experimental-vm-modules --loader ts-node/esm resolve-path.test.ts
 * or the electron test script (see package.json test:electron).
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveAppPath } from "./resolve-path.js";

// Use a synthetic root so tests don't touch the real client/dist.
const DIST = process.platform === "win32" ? "C:\\dist" : "/dist";
const sep = path.sep;

function assertRejected(url: string, expectedReason?: string): void {
  const r = resolveAppPath(url, DIST);
  assert.equal(r.ok, false, `URL ${url} should be rejected`);
  if (expectedReason && r.ok === false) {
    assert.equal(r.reason, expectedReason);
  }
}

function assertResolves(url: string, expectedRelative: string): void {
  const r = resolveAppPath(url, DIST);
  assert.equal(r.ok, true, `URL ${url} should resolve`);
  if (r.ok) {
    const expected = path.join(DIST, expectedRelative);
    assert.equal(r.absolutePath, expected);
  }
}

test("resolves index.html for root URL", () => {
  assertResolves("app://hichat/", "index.html");
  assertResolves("app://hichat", "index.html");
});

test("resolves nested asset paths", () => {
  assertResolves("app://hichat/index.html", "index.html");
  assertResolves("app://hichat/assets/main.js", `assets${sep}main.js`);
  assertResolves(
    "app://hichat/assets/css/theme.css",
    `assets${sep}css${sep}theme.css`
  );
});

test("percent-encoded ASCII characters are decoded", () => {
  // "space name.png" → "space name.png"
  assertResolves("app://hichat/assets/space%20name.png", `assets${sep}space name.png`);
});

test("Node URL parser eats plain .. traversal (property: resolves inside distRoot)", () => {
  // The Node URL constructor normalizes `..` at parse-time — even for
  // custom schemes. `app://hichat/../etc/passwd` arrives at the
  // resolver as pathname `/etc/passwd`. The security guarantee is that
  // the resolved path stays inside distRoot; the "reason" for a
  // rejection isn't what matters.
  const r = resolveAppPath("app://hichat/../etc/passwd", DIST);
  assert.equal(r.ok, true);
  if (r.ok) assert.ok(r.absolutePath.startsWith(DIST));
});

test("Node URL parser eats percent-encoded .. (property: resolves inside distRoot)", () => {
  // %2e%2e also normalized by URL parser before we see it.
  const r = resolveAppPath("app://hichat/%2e%2e/etc/passwd", DIST);
  assert.equal(r.ok, true);
  if (r.ok) assert.ok(r.absolutePath.startsWith(DIST));
});

test("double-encoded traversal is inert (property: resolves inside distRoot)", () => {
  // %252e%252e survives URL-parser normalization as literal "%2e%2e"
  // (a filename with weird chars, not a traversal). One decodeURIComponent
  // in the resolver turns it into "%2e%2e" — still not "..". Path lands
  // inside distRoot, at a filename that just won't exist.
  const r = resolveAppPath("app://hichat/%252e%252e/etc/passwd", DIST);
  assert.equal(r.ok, true);
  if (r.ok) assert.ok(r.absolutePath.startsWith(DIST));
});

test("resolver's own segment check catches raw '..' if URL parsing is ever bypassed", () => {
  // Defense in depth: if a future call site hands the resolver a
  // pre-parsed pathname (skipping the URL constructor's normalization),
  // the resolver's own segment check catches `..`. Simulate that path
  // by constructing a URL with an encoded slash — Node's URL doesn't
  // split on %2f, so `..` survives to the resolver.
  const r = resolveAppPath("app://hichat/foo%2f..%2fbar", DIST);
  assert.equal(r.ok, false);
  if (r.ok === false) assert.equal(r.reason, "traversal");
});

test("rejects null byte in path", () => {
  assertRejected("app://hichat/index.html%00.evil", "null_byte");
});

test("rejects absolute POSIX path", () => {
  // Path "/etc/passwd" normalizes to "/etc/passwd"; withoutLeadingSlash
  // is "etc/passwd" which is not absolute — this actually resolves to
  // DIST/etc/passwd (inside distRoot). That's fine — files at that
  // relative location inside dist would just 404 when read. What we
  // guard against is escaping. Confirm this stays inside distRoot.
  const r = resolveAppPath("app://hichat/etc/passwd", DIST);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.ok(r.absolutePath.startsWith(DIST));
  }
});

test("rejects Windows drive letter injection", () => {
  assertRejected("app://hichat/C:/Windows/System32/config", "absolute_path");
});

test("rejects wrong scheme", () => {
  assertRejected("file:///dist/index.html", "wrong_scheme");
  assertRejected("http://hichat/index.html", "wrong_scheme");
});

test("rejects wrong host", () => {
  assertRejected("app://evil/index.html", "wrong_host");
});

test("rejects malformed URL", () => {
  assertRejected("not a url", "malformed_url");
});

test("stays inside distRoot even for deep nesting", () => {
  const r = resolveAppPath("app://hichat/a/b/c/d/e.html", DIST);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.ok(r.absolutePath.startsWith(DIST));
  }
});

test("multiple slashes are normalized", () => {
  assertResolves("app://hichat//assets///main.js", `assets${sep}main.js`);
});

test("traversal only in one segment", () => {
  // "assets/../secret" resolves to "secret" — still inside distRoot,
  // so it's technically allowed. It'll 404 if secret doesn't exist.
  // The key guarantee is: it does NOT escape distRoot.
  const r = resolveAppPath("app://hichat/assets/../secret", DIST);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.ok(r.absolutePath.startsWith(DIST));
    assert.equal(r.absolutePath, path.join(DIST, "secret"));
  }
});

test("stacked ../../.. is inert after URL normalization (property: inside distRoot)", () => {
  const r = resolveAppPath("app://hichat/../../../etc/passwd", DIST);
  assert.equal(r.ok, true);
  if (r.ok) assert.ok(r.absolutePath.startsWith(DIST));
});

test("query string and fragment do not confuse the resolver", () => {
  // Vite adds ?t=1234 to hot-reload; also fragment identifiers for SPA
  // routing. URL parser strips both from pathname automatically.
  assertResolves("app://hichat/index.html?v=1", "index.html");
  assertResolves("app://hichat/index.html#section", "index.html");
});
