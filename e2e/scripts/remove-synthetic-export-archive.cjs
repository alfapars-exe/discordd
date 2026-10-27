const { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, unlinkSync } = require("node:fs");
const { isAbsolute, join, relative, resolve, sep } = require("node:path");

const e2eRoot = resolve(__dirname, "..");
const hex48 = /^[a-f0-9]{48}$/;
const runPattern = /^run-(\d+)-\d+-[a-f0-9]{16}$/;

function realChild(parent, child) {
  const rel = relative(realpathSync(parent), realpathSync(child));
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error("archive deletion refused a path outside the disposable run");
  }
}
function realDirectory(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("archive deletion requires a real owned directory");
}
function regularChild(parent, path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("archive deletion requires a regular owned file");
  realChild(parent, path);
  return stat;
}

/** Delete one immutable ZIP from this fresh Playwright-owned fixture only. */
function removeSyntheticExportArchive(jobID) {
  if (!hex48.test(jobID)) throw new Error("archive deletion requires the exact 48-hex job ID");
  const runID = process.env.HICHAT_E2E_RUN_ID ?? "";
  const match = runPattern.exec(runID);
  const stamp = match ? Number(match[1]) : NaN;
  if (!match || !Number.isSafeInteger(stamp) || stamp > Date.now() + 60_000 || Date.now() - stamp > 30 * 60_000) {
    throw new Error("archive deletion requires a fresh disposable run identity");
  }
  const tmpRoot = join(e2eRoot, ".tmp");
  const runDir = join(tmpRoot, runID);
  const exportsDir = join(runDir, "exports");
  for (const path of [e2eRoot, tmpRoot, runDir, exportsDir]) realDirectory(path);
  realChild(e2eRoot, tmpRoot);
  realChild(tmpRoot, runDir);
  realChild(runDir, exportsDir);
  const marker = join(runDir, "owner.json");
  regularChild(runDir, marker);
  const owner = JSON.parse(readFileSync(marker, "utf8"));
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error("archive deletion requires a live fixture owner");
  process.kill(owner.pid, 0);
  const db = join(runDir, "hichat-e2e.db");
  if (regularChild(runDir, db).size < 4096) throw new Error("archive deletion requires the initialized disposable database");
  const matching = readdirSync(exportsDir).filter(name => name.length === 101 && name.startsWith(`${jobID}-`) && name.endsWith(".zip") && hex48.test(name.slice(49, -4)));
  if (matching.length !== 1) throw new Error("archive deletion requires exactly one matching synthetic ZIP");
  const path = join(exportsDir, matching[0]);
  const before = regularChild(exportsDir, path);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    const prefix = Buffer.alloc(4);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        readSync(fd, prefix, 0, 4, 0) !== 4 || !prefix.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
      throw new Error("archive deletion refused a changed or non-ZIP file");
    }
    realChild(runDir, exportsDir);
    const final = regularChild(exportsDir, path);
    if (final.dev !== opened.dev || final.ino !== opened.ino) throw new Error("archive deletion refused a replaced file");
  } finally { closeSync(fd); }
  // No directory deletion, glob removal, recursive flag, or caller-supplied path.
  unlinkSync(path);
  return { deleted: true };
}

exports.removeSyntheticExportArchive = removeSyntheticExportArchive;
