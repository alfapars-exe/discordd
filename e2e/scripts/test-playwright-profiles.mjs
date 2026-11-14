import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "node_modules", "@playwright", "test", "cli.js");
const flags = ["HICHAT_E2E_CRYPTO_RECOVERY", "HICHAT_E2E_RECOVERY_MAIL", "HICHAT_E2E_PREFERENCE_ISOLATION"];
function list(selected = {}) {
  const env = { ...process.env };
  for (const name of [...flags, "PLAYWRIGHT_JSON_OUTPUT_FILE", "PLAYWRIGHT_JSON_OUTPUT_NAME", "PLAYWRIGHT_JSON_OUTPUT_DIR"]) delete env[name];
  Object.assign(env, selected);
  return spawnSync(process.execPath, [cli, "test", "--project=chromium", "--list", "--reporter=json"], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
}
function specs(suites) {
  return suites.flatMap(suite => [...(suite.specs ?? []), ...specs(suite.suites ?? [])]);
}
function checkedList(selected) {
  const result = list(selected);
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.errors, []);
  return specs(report.suites);
}
const regular = checkedList({});
const files = regular.map(spec => spec.file.replaceAll("\\", "/").split("/").at(-1));
assert.ok(files.includes("offline-retry.spec.ts"));
assert.ok(files.includes("channel-notifications.spec.ts"));
for (const name of ["crypto-recovery.spec.ts", "recovery-mail.spec.ts", "preferences-isolation.spec.ts"]) assert.ok(!files.includes(name), `${name} must own an isolated run`);
for (const [flag, file, count] of [
  [flags[0], "crypto-recovery.spec.ts", 3],
  [flags[1], "recovery-mail.spec.ts", 2],
  [flags[2], "preferences-isolation.spec.ts", 2],
]) {
  const selected = checkedList({ [flag]: "1" });
  assert.equal(selected.length, count, `${flag} must include setup and its scenarios`);
  assert.deepEqual(new Set(selected.map(spec => spec.file.replaceAll("\\", "/").split("/").at(-1))), new Set(["auth.setup.ts", file]));
}
const conflict = list({ [flags[0]]: "1", [flags[2]]: "1" });
assert.notEqual(conflict.status, 0);
assert.match(conflict.stderr + conflict.stdout, /Select only one isolated E2E profile/);
console.log("Playwright profile discovery and conflicting-mode rejection passed");
