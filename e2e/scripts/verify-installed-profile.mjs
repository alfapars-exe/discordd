import assert from "node:assert/strict";
import path from "node:path";
import { _electron as electron } from "@playwright/test";

const [executablePath, profile, phase, marker] = process.argv.slice(2);
assert.ok(path.isAbsolute(executablePath) && path.isAbsolute(profile));
assert.ok(["before", "after"].includes(phase) && marker);
const app = await electron.launch({ executablePath, args: [
  `--user-data-dir=${profile}`,
  // The installer under test owns the upgrade. Prevent the old application's
  // startup updater from downloading and launching a different release.
  "--host-resolver-rules=MAP huggingface.co ~NOTFOUND",
], timeout: 45000 });
try {
  const actual = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, profile: app.getPath("userData") }));
  assert.ok(actual.packaged);
  assert.equal(path.resolve(actual.profile), path.resolve(profile));
  // Older releases open and close a splash before creating the main window.
  const deadline = Date.now() + 45000;
  let window;
  while (!(window = app.windows().find(page => page.url().startsWith("app://hichat/index.html")))) {
    if (Date.now() >= deadline) throw new Error("Installed main window did not open");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await window.locator('input[type="password"]').waitFor({ timeout: 45000 });
  const key = "hichatInstallUpgradeProbe";
  if (phase === "before") {
    await window.evaluate(([key, value]) => localStorage.setItem(key, value), [key, marker]);
    await app.evaluate(async ({ session }) => session.defaultSession.flushStorageData());
  } else {
    assert.equal(await window.evaluate(key => localStorage.getItem(key), key), marker);
  }
  console.log(`Verified installed renderer and profile (${phase} upgrade)`);
} finally {
  await app.close();
}
