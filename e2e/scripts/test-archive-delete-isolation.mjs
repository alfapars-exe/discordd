import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertRealE2ETempRoot, removeSyntheticExportArchive } from "./remove-synthetic-export-archive.cjs";

const e2eRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const e2eStat = lstatSync(e2eRoot);
if (!e2eStat.isDirectory() || e2eStat.isSymbolicLink()) throw new Error("archive self-test requires a real E2E directory");
const realE2eRoot = realpathSync(e2eRoot);
const tmpRoot = join(realE2eRoot, ".tmp");
if (!existsSync(tmpRoot)) mkdirSync(tmpRoot);
// Crucially, reject a pre-existing .tmp junction/symlink before creating the
// run directory, marker, database, ZIP or any other file below it.
assertRealE2ETempRoot(realE2eRoot, tmpRoot);
const previous = process.env.HICHAT_E2E_RUN_ID;
const runID = `run-${Date.now()}-${process.pid}-${randomBytes(8).toString("hex")}`;
const runDir = join(tmpRoot, runID);
const exportsDir = join(runDir, "exports");
const outside = join(tmpRoot, `archive-delete-guard-${randomBytes(8).toString("hex")}`);
const fakeE2eRoot = join(runDir, "root-guard");
const fakeTmpRoot = join(fakeE2eRoot, ".tmp");
const jobID = "a".repeat(48), generation = "b".repeat(48);
const zip = join(exportsDir, `${jobID}-${generation}.zip`);
const unrelated = join(exportsDir, `${"c".repeat(48)}-${generation}.zip`);
let fileSymlinkSkipped = false;
mkdirSync(runDir); mkdirSync(exportsDir); mkdirSync(outside); mkdirSync(fakeE2eRoot);
writeFileSync(join(runDir, "owner.json"), JSON.stringify({ pid: process.pid }));
writeFileSync(join(runDir, "hichat-e2e.db"), Buffer.alloc(4096));
writeFileSync(join(outside, "keep.zip"), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
try {
  process.env.HICHAT_E2E_RUN_ID = runID;
  symlinkSync(outside, fakeTmpRoot, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => assertRealE2ETempRoot(fakeE2eRoot, fakeTmpRoot), /real owned directory/);
  assert.deepEqual(readFileSync(join(outside, "keep.zip")), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  unlinkSync(fakeTmpRoot);
  assert.throws(() => removeSyntheticExportArchive("../" + jobID), /48-hex/);
  assert.throws(() => removeSyntheticExportArchive("A".repeat(48)), /48-hex/);
  process.env.HICHAT_E2E_RUN_ID = `run-${Date.now() - 31 * 60_000}-${process.pid}-${"d".repeat(16)}`;
  assert.throws(() => removeSyntheticExportArchive(jobID), /fresh/);
  process.env.HICHAT_E2E_RUN_ID = runID;
  writeFileSync(zip, "not-a-zip");
  assert.throws(() => removeSyntheticExportArchive(jobID), /non-ZIP/);
  assert.ok(existsSync(zip)); unlinkSync(zip);
  rmdirSync(exportsDir);
  symlinkSync(outside, exportsDir, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => removeSyntheticExportArchive(jobID), /real owned directory/);
  assert.deepEqual(readFileSync(join(outside, "keep.zip")), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  unlinkSync(exportsDir); mkdirSync(exportsDir);
  try {
    symlinkSync(join(outside, "keep.zip"), zip, "file");
    assert.throws(() => removeSyntheticExportArchive(jobID), /regular owned file/);
    unlinkSync(zip);
  } catch (error) {
    if (error?.code !== "EPERM") throw error;
    fileSymlinkSkipped = true; // Windows may forbid file symlink creation; junction rejection above still ran.
  }
  writeFileSync(zip, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  writeFileSync(unrelated, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  assert.deepEqual(removeSyntheticExportArchive(jobID), { deleted: true });
  assert.equal(existsSync(zip), false);
  assert.ok(existsSync(unrelated));
  assert.throws(() => removeSyntheticExportArchive(jobID), /exactly one/);
  console.log(`Archive deletion isolation guard passed; file-symlink case skipped: ${fileSymlinkSkipped}`);
} finally {
  if (previous === undefined) delete process.env.HICHAT_E2E_RUN_ID;
  else process.env.HICHAT_E2E_RUN_ID = previous;
  // Explicit known fixture paths only; no recursive cleanup or directory glob.
  for (const path of [zip, unrelated, join(runDir, "owner.json"), join(runDir, "hichat-e2e.db"), join(outside, "keep.zip")]) {
    if (existsSync(path)) unlinkSync(path);
  }
  if (existsSync(fakeTmpRoot)) unlinkSync(fakeTmpRoot);
  for (const path of [exportsDir, fakeE2eRoot, runDir, outside]) if (existsSync(path)) rmdirSync(path);
}
