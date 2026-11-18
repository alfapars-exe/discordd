import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, sep } from "node:path";
import { searchSourceBaseline } from "./search-source-baseline.mjs";

const git = (process.platform === "win32" ? ["C:/Program Files/Git/cmd/git.exe"] : ["/usr/bin/git", "/usr/local/bin/git"]).find(existsSync);
assert.ok(git);
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "hichat-source-overlay-"));
  t.after(() => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    rmSync(root, { recursive: true, force: true });
  });
  const run = args => execFileSync(git, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (path, source) => { mkdirSync(resolve(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), source); };
  const commit = () => { run(["add", "client"]); run(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--no-gpg-sign", "-qm", "fixture"]); return run(["rev-parse", "HEAD"]); };
  run(["init", "--quiet"]);
  write("client/src/panel.ts", 'import { value } from "./backend"; export { value };');
  write("client/src/backend.ts", 'export const value = "historical";');
  const baseline = commit();
  return { root, write, commit, baseline };
}

test("a changed transitive backend uses historical code even when its panel is unchanged", t => {
  const f = fixture(t);
  f.write("client/src/backend.ts", 'export const value = "current";'); f.commit();
  const result = searchSourceBaseline(git, f.root, f.baseline, ["client/src/panel.ts"]);
  assert.equal(result.overrides.get("client/src/backend.ts"), 'export const value = "historical";');
  assert.match(result.overrides.get("client/src/panel.ts"), /backend/);
});

test("a current-only runtime module cannot silently enter a historical build", t => {
  const f = fixture(t);
  f.write("client/src/new.mjs", "export default true;"); f.commit();
  const result = searchSourceBaseline(git, f.root, f.baseline, ["client/src/panel.ts"]);
  assert.throws(() => result.assertHistoricalPath("client/src/new.mjs"), /absent from baseline/);
  result.assertHistoricalPath("client/src/backend.ts");
});

test("uncommitted client source cannot be reported as an immutable comparison", t => {
  const f = fixture(t);
  f.write("client/src/backend.ts", 'export const value = "dirty";');
  assert.throws(() => searchSourceBaseline(git, f.root, f.baseline, ["client/src/panel.ts"]), /committed client/);
});

test("required historical entry points cannot fall back to current files", t => {
  const f = fixture(t);
  assert.throws(() => searchSourceBaseline(git, f.root, f.baseline, ["client/src/missing.ts"]), /Missing required historical/);
});

test("untracked runtime source cannot be reported as an immutable comparison", t => {
  const f = fixture(t);
  f.write("client/src/untracked.mjs", "export default true;");
  assert.throws(() => searchSourceBaseline(git, f.root, f.baseline, ["client/src/panel.ts"]), /untracked client/);
});
