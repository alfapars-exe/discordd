import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
// Compile beside node_modules so generated tests resolve the installed packages.
// A unique directory prevents removed tests from previous branches being run.
const output = mkdtempSync(path.join(root, ".electron-tests-"));
function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}
try {
  let status = run(["node_modules/electron/install.js"]);
  if (status === 0) status = run(["node_modules/typescript/bin/tsc", "-p", "electron/tsconfig.json", "--outDir", output]);
  if (status === 0) {
    const tests = readdirSync(output).filter(name => name.endsWith(".test.js")).sort().map(name => path.join(output, name));
    if (tests.length === 0) throw new Error("Electron compilation produced no test files");
    status = run(["--test", ...tests]);
  }
  process.exitCode = status;
} finally {
  rmSync(output, { recursive: true, force: true });
}
