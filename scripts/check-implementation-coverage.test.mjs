import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const validatorURL = new URL("./check-implementation-coverage.mjs", import.meta.url);
const ledgerPath = path.join(root, "implementation", "coverage.json");
const originalLedgerText = fs.readFileSync(ledgerPath, "utf8");
const originalLedger = JSON.parse(originalLedgerText);
const originalValidator = fs.readFileSync(validatorURL, "utf8");

// Run the production implementation, not a duplicate of its validation rules.
// Node's standard VM does not evaluate ESM imports; inject precisely these
// three read-only dependencies and replace import.meta.url with its real URL.
const imports = [
  'import fs from "node:fs";',
  'import path from "node:path";',
  'import { fileURLToPath } from "node:url";',
];
let validatorSource = originalValidator.replace(/^#![^\r\n]*\r?\n/, "");
for (const declaration of imports) {
  assert.equal(validatorSource.split(declaration).length, 2, "Validator import contract changed: " + declaration);
  validatorSource = validatorSource.replace(declaration, "");
}
assert.equal(validatorSource.split("import.meta.url").length, 2, "Validator module URL contract changed");
validatorSource = validatorSource.replace("import.meta.url", JSON.stringify(validatorURL.href));
const validatorScript = new vm.Script(validatorSource, { filename: fileURLToPath(validatorURL) });

class CapturedExit extends Error {}

function runValidator(mutate = () => {}, args = [], rawText) {
  const fixture = structuredClone(originalLedger);
  mutate(fixture);
  const output = [];
  const errors = [];
  const processStub = {
    argv: [process.execPath, fileURLToPath(validatorURL), "--json", ...args],
    exitCode: 0,
    exit(code) {
      this.exitCode = code;
      throw new CapturedExit("process.exit");
    },
  };
  const fsStub = Object.freeze({
    readFileSync(file, encoding) {
      assert.equal(path.resolve(file), ledgerPath, "Validator attempted an unexpected file read");
      assert.equal(encoding, "utf8");
      return rawText ?? JSON.stringify(fixture);
    },
    // Keep existence checks honest without exposing any filesystem mutations.
    statSync: (file) => fs.statSync(file),
  });
  try {
    validatorScript.runInNewContext({
      fs: fsStub,
      path,
      fileURLToPath,
      process: processStub,
      console: {
        log: (...parts) => output.push(parts.join(" ")),
        error: (...parts) => errors.push(parts.join(" ")),
      },
    }, { timeout: 5000 });
  } catch (error) {
    if (!(error instanceof CapturedExit)) throw error;
  }
  return {
    exitCode: processStub.exitCode,
    result: output.length ? JSON.parse(output.join("\n")) : null,
    stderr: errors.join("\n"),
  };
}

function expectInvalid(mutate, messagePattern) {
  const outcome = runValidator(mutate);
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.result.valid, false);
  assert.equal(outcome.result.complete, false);
  assert.ok(outcome.result.errors.some((message) => messagePattern.test(message)),
    "Expected " + messagePattern + " in " + JSON.stringify(outcome.result.errors));
}

// Synthetic evidence exercises the metadata/path contract only. It is never
// written to the ledger and does not claim acceptance of product features.
function fixtureEvidence() {
  return {
    kind: "test",
    path: "scripts/check-implementation-coverage.test.mjs",
    result: "passed",
    verified_at: "2026-10-23T00:00:00.000Z",
    summary: "Synthetic validator fixture, not product acceptance evidence.",
  };
}

test("real ledger passes structural validation with accurate counts and package totals", () => {
  const { exitCode, result } = runValidator();
  assert.equal(exitCode, 0, JSON.stringify(result.errors));
  assert.equal(result.valid, true);
  assert.equal(result.references, 33);
  assert.equal(result.behaviors, originalLedger.items.length);
  assert.deepEqual(result.packages.map((entry) => entry.phase), Array.from({ length: 12 }, (_, i) => "P" + i));
  assert.equal(Object.values(result.counts).reduce((sum, value) => sum + value, 0), result.behaviors);
  const pending = originalLedger.items.filter((item) => !["accepted", "excluded"].includes(item.status));
  assert.deepEqual(result.pending_item_ids, pending.map((item) => item.id));
  assert.equal(result.packages.reduce((sum, entry) => sum + entry.pending, 0), pending.length);
  assert.equal(result.complete, pending.length === 0);
});

test("rejects a missing original screenshot", () => {
  expectInvalid((ledger) => ledger.references.pop(), /original screenshot attachment is missing/);
});

test("rejects replacing an original screenshot while keeping the reference count", () => {
  expectInvalid((ledger) => {
    ledger.references[0].basename = "codex-clipboard-00000000-0000-0000-0000-000000000000.png";
  }, /attachment not supplied in this chat/);
});

test("rejects duplicate stable item IDs", () => {
  expectInvalid((ledger) => ledger.items.push(structuredClone(ledger.items[0])), /Item IDs must be nonempty and unique/);
});

test("rejects a screenshot with no mapped behaviors", () => {
  expectInvalid((ledger) => {
    const reference = ledger.references[0].id;
    for (const item of ledger.items) item.sources = item.sources.filter((source) => source !== reference);
  }, /screenshot has no mapped behavior/);
});

test("rejects a missing reverse reference mapping", () => {
  expectInvalid((ledger) => ledger.references[0].required_item_ids.shift(), /reference reverse mapping missing/);
});

test("rejects a required behavior removed from the ledger", () => {
  expectInvalid((ledger) => {
    const required = ledger.references[0].required_item_ids[0];
    ledger.items = ledger.items.filter((item) => item.id !== required);
  }, /missing required behavior/);
});

test("rejects an unrecognized status", () => {
  expectInvalid((ledger) => { ledger.items[0].status = "done"; }, /invalid status/);
});

test("rejects accepted status without recorded evidence", () => {
  expectInvalid((ledger) => {
    ledger.items[0].status = "accepted";
    ledger.items[0].evidence = [];
  }, /accepted without verification evidence/);
});

test("rejects unknown item phases", () => {
  expectInvalid((ledger) => { ledger.items[0].phase = "P12"; }, /invalid phase/);
});

test("rejects missing phase packages", () => {
  expectInvalid((ledger) => ledger.phases.pop(), /Phases must cover P0 through P11 exactly/);
});

test("rejects cyclic phase dependencies", () => {
  expectInvalid((ledger) => {
    ledger.phases.find((phase) => phase.id === "P0").depends_on = ["P1"];
    ledger.phases.find((phase) => phase.id === "P1").depends_on = ["P0"];
  }, /Cyclic phase dependency/);
});

test("rejects exclusions without an explicit reason", () => {
  expectInvalid((ledger) => {
    ledger.items[0].status = "excluded";
    delete ledger.items[0].reason;
  }, /explicit exclusion reason required/);
});

test("rejects implemented status without source references", () => {
  expectInvalid((ledger) => {
    ledger.items[0].status = "implemented_unverified";
    ledger.items[0].code = [];
  }, /implementation requires source references/);
});

for (const outsidePath of ["../outside-repository.txt", "C:/outside-repository.txt", "/outside-repository.txt"]) {
  test("rejects out-of-repository code path: " + outsidePath, () => {
    expectInvalid((ledger) => { ledger.items[0].code = [outsidePath]; }, /code path missing or outside repository/);
  });
  test("rejects out-of-repository evidence path: " + outsidePath, () => {
    expectInvalid((ledger) => {
      ledger.items[0].status = "accepted";
      ledger.items[0].evidence = [{ ...fixtureEvidence(), path: outsidePath }];
    }, /evidence artifact missing or outside repository/);
  });
}

for (const [field, value, pattern] of [
  ["kind", "assumption", /evidence kind invalid/],
  ["result", "failed", /accepted evidence must be passed/],
  ["verified_at", "not-a-date", /evidence timestamp required/],
  ["summary", "", /evidence summary required/],
  ["path", "implementation/does-not-exist.acceptance-evidence", /evidence artifact missing or outside repository/],
]) {
  test("rejects invalid accepted-evidence field: " + field, () => {
    expectInvalid((ledger) => {
      ledger.items[0].status = "accepted";
      ledger.items[0].evidence = [{ ...fixtureEvidence(), [field]: value }];
    }, pattern);
  });
}

test("rejects acceptance scenarios that are empty", () => {
  expectInvalid((ledger) => { ledger.items[0].acceptance = []; }, /acceptance scenario required/);
});

test("rejects unsupported platforms", () => {
  expectInvalid((ledger) => { ledger.items[0].platforms = ["native-ios"]; }, /invalid platforms/);
});

test("rejects unknown command-line options", () => {
  const { exitCode, result } = runValidator(undefined, ["--allow-missing"]);
  assert.equal(exitCode, 1);
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("Unknown argument: --allow-missing"));
});

test("malformed ledger JSON exits cleanly without a misleading success result", () => {
  const { exitCode, result, stderr } = runValidator(undefined, [], "{invalid-json");
  assert.equal(exitCode, 1);
  assert.equal(result, null);
  assert.match(stderr, /Coverage ledger could not be read/);
});

test("strict completion gate fails structurally valid outstanding work", () => {
  const { exitCode, result } = runValidator((ledger) => {
    const item = ledger.items.find((entry) => entry.status !== "excluded");
    assert.ok(item, "The plan must have in-scope work");
    item.status = "missing";
  }, ["--strict"]);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.complete, false);
  assert.ok(result.pending_item_ids.length > 0);
  assert.equal(exitCode, 1);
});

test("strict completion gate passes a synthetic fully evidenced fixture", () => {
  const { exitCode, result } = runValidator((ledger) => {
    for (const item of ledger.items) {
      if (item.status === "excluded") continue;
      item.status = "accepted";
      item.evidence = [fixtureEvidence()];
    }
  }, ["--strict"]);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.complete, true);
  assert.deepEqual(result.pending_item_ids, []);
  assert.equal(exitCode, 0);
});

test("validator fixtures leave the real ledger byte-for-byte unchanged", () => {
  assert.equal(fs.readFileSync(ledgerPath, "utf8"), originalLedgerText);
});
