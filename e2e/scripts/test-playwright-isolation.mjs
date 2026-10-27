import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const config = readFileSync(join(here, "..", "playwright.config.ts"), "utf8");

assert.match(config, /reuseExistingServer:\s*false/g, "both disposable test servers must always be spawned by Playwright");
assert.match(config, /env:\s*\{\s*E2E_SERVER_PORT:\s*String\(SERVER_PORT\),\s*HICHAT_E2E_RUN_ID:\s*E2E_RUN_ID\s*\}/,
  "the API server must ignore inherited E2E_SERVER_PORT overrides");
assert.match(config, /env:\s*\{\s*HICHAT_DEV_API_TARGET:\s*`http:\/\/127\.0\.0\.1:\$\{SERVER_PORT\}`\s*\}/,
  "Vite must proxy only to this run's loopback API");
assert.match(config, /HICHAT_E2E_RUN_ID\s*\?\?\s*`run-\$\{Date\.now\(\)\}-\$\{process\.pid\}-\$\{randomBytes\(8\)\.toString\("hex"\)\}`/,
  "each Playwright process must generate a unique run identity unless a valid inherited identity is present");
assert.match(config, /process\.env\.HICHAT_E2E_RUN_ID\s*=\s*E2E_RUN_ID/,
  "Playwright worker processes must inherit the same run identity");

const serverLauncher = readFileSync(join(here, "start-server.mjs"), "utf8");
assert.match(serverLauncher, /delete env\.SPACE_ID;\s*delete env\.SDK_SPACE;/,
  "the isolated API must not inherit hosted-space integration/probe selectors");
assert.match(serverLauncher, /process\.env\.HICHAT_E2E_RUN_ID[\s\S]*mkdirSync\(runDir\)/,
  "the API launcher must create the database under the unique run identity passed by Playwright");
assert.match(serverLauncher, /function buildServer\(runDir\)[\s\S]*lstatSync\(binDir\)[\s\S]*realpathSync\(binDir\)[\s\S]*relative\(realRunDir, realBinDir\)/,
  "Go build output must be a real directory contained inside the unique run before compilation");
assert.match(serverLauncher, /const binPath = join\(binDir, binName\)[\s\S]*existsSync\(binPath\) \|\| existsSync\(probePath\)/,
  "Go output paths must be fresh files under that verified directory");

const fixtureSetup = readFileSync(join(here, "setup-disposable-fixture.mjs"), "utf8");
assert.match(fixtureSetup, /function windowsSystemTool\(name\)[\s\S]*realpathSync\(join\(realWindowsRoot, "System32"\)\)[\s\S]*lstatSync\(executable\)/,
  "fixture system utilities must resolve to verified regular files under the Windows System32 directory");
assert.match(fixtureSetup, /execFileSync\(windowsSystemTool\("whoami"\)/);
assert.match(fixtureSetup, /execFileSync\(windowsSystemTool\("icacls"\)/);
assert.doesNotMatch(fixtureSetup, /execFileSync\("(?:whoami|icacls)"/,
  "fixture setup must not select system utilities through inherited PATH search");

const helpers = readFileSync(join(here, "..", "tests", "helpers.ts"), "utf8");
assert.match(helpers, /E2E_RUN_ID[\s\S]*realpathSync\(runDir\)[\s\S]*realpathSync\(dbPath\)[\s\S]*execFileSync\(realProbePath/,
  "the queue observer must use the exact run identity and validate realpath containment before execution");
const queueProbe = readFileSync(join(here, "queue-probe.go"), "utf8");
assert.match(queueProbe, /mode=ro/,
  "the E2E queue observer must open the disposable SQLite file read-only");
assert.match(queueProbe, /COUNT\(\*\),COALESCE\(SUM[\s\S]*FROM messages m[\s\S]*COALESCE\(m\.content,''\)=\?/,
  "queue completion must match the exact unique message before accepting an empty queue");

console.log("Playwright server isolation contract passed");
