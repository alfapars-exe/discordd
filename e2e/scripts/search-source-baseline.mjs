import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const runtimeSource = path => path.startsWith("client/src/") && /\.(?:[cm]?js|jsx|tsx?)$/.test(path);

/** Overlay changed runtime dependencies as well as the benchmark entry points.
 * Missing historical modules fail closed instead of borrowing current code.
 * Dependencies/toolchain stay installed at the current lockfile version.
 */
export function searchSourceBaseline(git, repo, baseline, requiredPaths) {
  assert.match(baseline, /^[0-9a-f]{40}$/);
  const run = args => execFileSync(git, args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try { run(["diff", "--quiet", "HEAD", "--", "client/src"]); }
  catch { throw new Error("Source comparison requires committed client/src changes"); }
  const untracked = run(["ls-files", "--others", "--exclude-standard", "--", "client/src"]).trim().split(/\r?\n/).filter(runtimeSource);
  assert.equal(untracked.length, 0, "Source comparison cannot include untracked client runtime source");
  const baselineFiles = new Set(run(["ls-tree", "-r", "--name-only", baseline, "--", "client/src"]).trim().split(/\r?\n/));
  for (const path of requiredPaths) assert.ok(baselineFiles.has(path), `Missing required historical source: ${path}`);
  const changed = run(["diff", "--name-only", baseline, "HEAD", "--", "client/src"]).trim().split(/\r?\n/);
  const paths = new Set([...requiredPaths, ...changed.filter(path => runtimeSource(path) && baselineFiles.has(path))]);
  const overrides = new Map([...paths].map(path => [path, run(["show", `${baseline}:${path}`])]));
  return {
    overrides,
    assertHistoricalPath(path) {
      if (runtimeSource(path)) assert.ok(baselineFiles.has(path), `Historical build imported a module absent from baseline: ${path}`);
    },
  };
}
