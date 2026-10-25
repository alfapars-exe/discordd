#!/usr/bin/env node
/**
 * Mechanical reference/requirement coverage check, not proof of feature correctness.
 * node scripts/check-implementation-coverage.mjs [--strict] [--json]
 * --strict additionally fails while any in-scope acceptance is outstanding.
 * An accepted item's evidence must be a real repository-local verification artifact:
 * { kind: "test"|"integration"|"browser"|"manual", path, result: "passed",
 *   verified_at: ISO timestamp, summary: "What the acceptance run verified" }.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ledgerPath = path.join(root, "implementation", "coverage.json");
const args = new Set(process.argv.slice(2));
const allowedArgs = new Set(["--strict", "--json"]);
const requiredAttachmentBasenames = new Set([
  "codex-clipboard-fb82f69a-7879-4661-94bd-ecb3167b5e38.png",
  "codex-clipboard-0d93f5e5-2dad-4ccc-bae3-a5ffd5353a87.png",
  "codex-clipboard-651bdd21-053d-4439-94c3-362f825ad65a.png",
  "codex-clipboard-892ec55f-31db-4b66-9d4b-f3c3c0a979a1.png",
  "codex-clipboard-3a96d852-6cb8-41c2-8dd1-3a26090f13bb.png",
  "codex-clipboard-f30f1458-f468-40bc-8bbb-e8456a484e98.png",
  "codex-clipboard-90991371-0565-4b65-981a-8a2b67daed2d.png",
  "codex-clipboard-bcb79aaf-290e-45c0-a3bb-a6f62a6b0dc9.png",
  "codex-clipboard-59c48822-15f6-4e73-ae61-953100bd10c3.png",
  "codex-clipboard-7e10aef1-dd9b-400b-9134-157739827d5d.png",
  "codex-clipboard-b180583d-5db8-4499-be67-86a10221f5f7.png",
  "codex-clipboard-fc16f0ef-6eaa-44a5-8383-ab9adfc8439f.png",
  "codex-clipboard-a1b4224e-63a2-4b33-ac49-2e9f72ac5708.png",
  "codex-clipboard-fde5177f-f0fd-4425-a69d-8cc8a86d5509.png",
  "codex-clipboard-cf9aa4d6-5be7-4a60-b6f2-836e70f3b851.png",
  "codex-clipboard-4aafc73a-3021-41d5-b225-a48e148134e5.png",
  "codex-clipboard-bdb48667-edcb-4a6b-97f1-931efb6fe879.png",
  "codex-clipboard-31b91223-1aae-4275-b6c9-d317b8c058b9.png",
  "codex-clipboard-3c2ae2e4-2e6c-4b1e-92f3-9c15d29f1f8d.png",
  "codex-clipboard-c3ece509-c38d-4e5f-b2ea-72b14f52db09.png",
  "codex-clipboard-236607de-b6bd-47ca-ba29-bdf4c240df0c.png",
  "codex-clipboard-03973089-e2e1-4353-b69e-3cdf6b6891bc.png",
  "codex-clipboard-516b570c-0532-440d-abec-e990e2492027.png",
  "codex-clipboard-bc90ff1d-8598-4f33-8d1c-5599fa9b9ebf.png",
  "codex-clipboard-537cec9e-7f85-4f2f-a764-5b9b79e572cd.png",
  "codex-clipboard-92d1ad22-02f1-405b-888c-f25b9c648000.png",
  "codex-clipboard-0aa16286-0bad-4b89-beae-27ceb98aff2c.png",
  "codex-clipboard-f38cb3fa-82e9-4821-9e59-d9fb6a604d32.png",
  "codex-clipboard-53c5936d-3210-4eb0-a4e7-29144efea3dc.png",
  "codex-clipboard-491219bf-84a0-4aaa-b3a1-4088d11a6b9a.png",
  "codex-clipboard-19475dbd-1158-4dc3-8e8f-dba793314afc.png",
  "codex-clipboard-d4f5e4c8-2c03-4d80-b3ae-0de961ceb982.png",
  "codex-clipboard-96f37014-8e0b-4cf9-982e-185b0f8415ce.png"
]);
const errors = [];
for (const arg of args) if (!allowedArgs.has(arg)) errors.push("Unknown argument: " + arg);
let ledger;
try {
  ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
} catch (error) {
  console.error("Coverage ledger could not be read: " + error.message);
  process.exit(1);
}
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
const unique = (array) => new Set(array).size === array.length;
const list = (value) => Array.isArray(value) ? value : [];
function assert(condition, message) { if (!condition) errors.push(message); }
function localFile(value) {
  if (!nonempty(value) || path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
  const target = path.resolve(root, value);
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return false;
  try { return fs.statSync(target).isFile(); } catch { return false; }
}

assert(ledger.schema_version === 1, "Unsupported schema_version");
const refs = list(ledger.references);
const phases = list(ledger.phases);
const items = list(ledger.items);
const expectedPhases = Array.from({ length: 12 }, (_, i) => "P" + i);
const validStatuses = new Set(["existing", "missing", "implemented_unverified", "accepted", "excluded"]);
const validPlatforms = new Set(["windows", "web"]);
assert(ledger.scope?.reference_count === 33 && refs.length === 33, "Exactly 33 screenshot references are required");
assert(unique(refs.map((r) => r.id)), "Reference IDs must be unique");
assert(unique(refs.map((r) => r.basename)), "Reference basenames must be unique");
assert(refs.every((r) => requiredAttachmentBasenames.has(r.basename)), "Reference list contains an attachment not supplied in this chat");
assert([...requiredAttachmentBasenames].every((basename) => refs.some((r) => r.basename === basename)), "An original screenshot attachment is missing");
assert(unique(phases.map((p) => p.id)), "Phase IDs must be unique");
assert(phases.length === 12 && expectedPhases.every((id) => phases.some((p) => p.id === id)), "Phases must cover P0 through P11 exactly");
assert(items.length > 0 && unique(items.map((i) => i.id)), "Item IDs must be nonempty and unique");
const refById = new Map(refs.map((r) => [r.id, r]));
const itemById = new Map(items.map((i) => [i.id, i]));
for (const phase of phases) {
  assert(nonempty(phase.title), phase.id + ": phase title required");
  assert(Array.isArray(phase.depends_on) && unique(phase.depends_on), phase.id + ": unique dependency list required");
  for (const dep of list(phase.depends_on)) assert(expectedPhases.includes(dep) && dep !== phase.id, phase.id + ": invalid dependency " + dep);
  assert(items.some((i) => i.phase === phase.id), phase.id + ": no coverage items");
}
const visiting = new Set(), visited = new Set();
function visitPhase(id) {
  if (visiting.has(id)) { errors.push("Cyclic phase dependency: " + id); return; }
  if (visited.has(id)) return;
  visiting.add(id);
  for (const dependency of list(phases.find((p) => p.id === id)?.depends_on)) visitPhase(dependency);
  visiting.delete(id); visited.add(id);
}
for (const id of expectedPhases) visitPhase(id);
for (let index = 0; index < refs.length; index++) {
  const ref = refs[index];
  assert(ref.id === "R" + String(index + 1).padStart(2, "0"), "References must be ordered R01 through R33");
  assert(/^codex-clipboard-[a-f0-9-]{36}\.png$/.test(ref.basename ?? ""), ref.id + ": reference must use attachment basename only");
  assert(nonempty(ref.section), ref.id + ": human-readable section required");
  assert(Array.isArray(ref.required_item_ids) && ref.required_item_ids.length > 0 && unique(ref.required_item_ids), ref.id + ": unique required_item_ids needed");
  for (const id of list(ref.required_item_ids)) {
    assert(itemById.has(id), ref.id + ": missing required behavior " + id);
    assert(list(itemById.get(id)?.sources).includes(ref.id), ref.id + ": required behavior source mismatch " + id);
  }
  assert(items.some((i) => list(i.sources).includes(ref.id)), ref.id + ": screenshot has no mapped behavior");
}
for (const item of items) {
  const tag = item.id ?? "(unnamed item)";
  assert(/^p(?:[0-9]|1[01])\.[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tag), tag + ": invalid stable ID");
  assert(expectedPhases.includes(item.phase), tag + ": invalid phase");
  assert(tag.startsWith((item.phase ?? "").toLowerCase() + "."), tag + ": ID/phase mismatch");
  assert(validStatuses.has(item.status), tag + ": invalid status");
  for (const field of ["title", "persistence", "authorization"]) assert(nonempty(item[field]), tag + ": required field " + field);
  assert(Array.isArray(item.platforms) && item.platforms.length > 0 && unique(item.platforms) && item.platforms.every((p) => validPlatforms.has(p)), tag + ": invalid platforms");
  assert(Array.isArray(item.sources) && item.sources.length > 0 && unique(item.sources), tag + ": sources required");
  for (const source of list(item.sources)) {
    assert(source === "user-plan" || refById.has(source), tag + ": unknown source " + source);
    if (refById.has(source)) assert(list(refById.get(source).required_item_ids).includes(tag), tag + ": reference reverse mapping missing for " + source);
  }
  assert(Array.isArray(item.acceptance) && item.acceptance.length > 0 && item.acceptance.every(nonempty), tag + ": acceptance scenario required");
  assert(Array.isArray(item.code), tag + ": code array required");
  for (const file of list(item.code)) assert(localFile(file), tag + ": code path missing or outside repository: " + file);
  assert(Array.isArray(item.evidence), tag + ": evidence array required");
  if (item.status === "excluded") assert(nonempty(item.reason), tag + ": explicit exclusion reason required");
  if (item.status === "implemented_unverified") assert(list(item.code).length > 0, tag + ": implementation requires source references");
  if (item.actions !== undefined) assert(Array.isArray(item.actions) && item.actions.length > 0 && item.actions.every(nonempty), tag + ": action list must be nonempty");
  if (item.status === "accepted") {
    assert(list(item.evidence).length > 0, tag + ": accepted without verification evidence");
    for (const evidence of list(item.evidence)) {
      assert(["test", "integration", "browser", "manual"].includes(evidence.kind), tag + ": evidence kind invalid");
      assert(evidence.result === "passed", tag + ": accepted evidence must be passed");
      assert(nonempty(evidence.verified_at) && /^\d{4}-\d{2}-\d{2}T/.test(evidence.verified_at) && Number.isFinite(Date.parse(evidence.verified_at)), tag + ": evidence timestamp required");
      assert(nonempty(evidence.summary), tag + ": evidence summary required");
      assert(localFile(evidence.path), tag + ": evidence artifact missing or outside repository");
    }
  }
}
assert(items.some((i) => list(i.sources).includes("user-plan")), "Accepted plan requirements beyond screenshots must be represented");
const counts = Object.fromEntries([...validStatuses].map((s) => [s, items.filter((i) => i.status === s).length]));
const pending = items.filter((i) => !["accepted", "excluded"].includes(i.status));
const packages = phases.map((p) => ({
  phase: p.id,
  title: p.title,
  total: items.filter((i) => i.phase === p.id).length,
  pending: pending.filter((i) => i.phase === p.id).length,
  accepted: items.filter((i) => i.phase === p.id && i.status === "accepted").length,
  excluded: items.filter((i) => i.phase === p.id && i.status === "excluded").length,
}));
const result = {
  valid: errors.length === 0,
  complete: errors.length === 0 && pending.length === 0,
  references: refs.length,
  behaviors: items.length,
  counts,
  packages,
  pending_item_ids: pending.map((i) => i.id),
  errors,
};
if (args.has("--json")) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log("Coverage structure: " + (result.valid ? "VALID" : "INVALID"));
  console.log("References: " + refs.length + "/33; behaviors: " + items.length);
  console.log("Statuses: " + Object.entries(counts).map(([k, v]) => k + "=" + v).join(", "));
  console.log("Acceptance complete: " + (result.complete ? "YES" : "NO"));
  console.log("Pending packages:");
  for (const pkg of packages.filter((p) => p.pending > 0)) {
    console.log("  " + pkg.phase + ": " + pkg.pending + "/" + pkg.total + " pending — " + pkg.title);
  }
  for (const error of errors) console.error("ERROR: " + error);
  if (args.has("--strict") && pending.length) console.error("Completion gate failed: " + pending.length + " behaviors still require acceptance.");
}
process.exitCode = errors.length > 0 || (args.has("--strict") && pending.length > 0) ? 1 : 0;

