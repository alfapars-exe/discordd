import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const E2E_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const TMP_DIR = join(E2E_DIR, ".tmp");

// Remove only the generated credential/fixture files after all Playwright
// workers exit. The isolated SQLite run directories remain for short-term
// failure diagnosis and are pruned by start-server.mjs.
for (const name of ["account.json", "channel-notification-fixture.json", "notification-recipient-pending.json"]) {
  rmSync(join(TMP_DIR, name), { force: true });
}
