import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import { controlledPanelCryptoImport } from "./panel-controlled-imports.mjs";
const root = resolve("fixture-client");
for (const [name, source, importer, expected] of [
  ["channel snapshot", "../../crypto/cachedSearchSnapshot", "src/components/chat/SearchPanel.tsx", "index"],
  ["DM cache", "../../crypto/keyStorage", "src/components/dm/DMSearchPanel.tsx", "cache"],
  ["shared runner snapshot", "./cachedSearchSnapshot", "src/crypto/cachedSearchRunner.ts", "index"],
  ["page reader cache", "./keyStorage", "src/crypto/cachedSearchPage.ts", "cache"],
  ["foreign directory", "./cachedSearchSnapshot", "src/unrelated/consumer.ts", null],
  ["foreign crypto path", "../../crypto/cachedSearchSnapshot", "other/deep/consumer.ts", null],
  ["explicit real module", "./cachedSearchSnapshot.ts", "src/crypto/cachedSearchRunner.ts", null],
  ["package name", "cachedSearchSnapshot", "src/crypto/cachedSearchRunner.ts", null],
]) test(name, () => assert.equal(controlledPanelCryptoImport(source, join(root, importer), root), expected));
test("virtual wrapper's absolute real imports bypass interception", () => {
 assert.equal(controlledPanelCryptoImport("/src/crypto/cachedSearchSnapshot.ts", "\0panel-index.js", root), null);
});
