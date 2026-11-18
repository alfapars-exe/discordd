import assert from "node:assert/strict";
import test from "node:test";
import { runProfileWithReport } from "./profile-lifecycle.mjs";

test("negative control: an unguarded finally report write masks the workload error", async () => {
  const workload = new Error("workload");
  const enospc = Object.assign(new Error("disk full"), { code: "ENOSPC" });
  await assert.rejects((async () => {
    try { throw workload; }
    finally { throw enospc; }
  })(), error => error === enospc);
});

test("joins workload, cleanup and report in order before returning", async () => {
  const order = [], report = {};
  const value = await runProfileWithReport({ report,
    run: async () => { order.push("workload"); return 42; },
    cleanup: async () => { await Promise.resolve(); order.push("cleanup"); },
    writeReport: async value => {
      order.push("report");
      assert.equal(value, report);
      assert.equal(value.resultStatus, "completed");
      assert.deepEqual(value.failurePhases, []);
      assert.ok(Number.isFinite(Date.parse(value.finishedAt)));
    },
  });
  assert.equal(value, 42);
  assert.deepEqual(order, ["workload", "cleanup", "report"]);
});

test("ENOSPC cannot mask the original workload or cleanup error", async () => {
  const workload = new Error("workload"), cleanup = new Error("cleanup");
  const enospc = Object.assign(new Error("disk full"), { code: "ENOSPC" });
  const order = [];
  await assert.rejects(runProfileWithReport({ report: {},
    run: () => { order.push("workload"); throw workload; },
    cleanup: async () => { order.push("cleanup"); throw cleanup; },
    writeReport: report => {
      order.push("report");
      assert.equal(report.resultStatus, "failed");
      assert.deepEqual(report.failurePhases, ["workload", "cleanup"]);
      throw enospc;
    },
  }), error => error instanceof AggregateError &&
    error.errors[0] === workload && error.errors[1] === cleanup && error.errors[2] === enospc);
  assert.deepEqual(order, ["workload", "cleanup", "report"]);
});

for (const phase of ["workload", "cleanup", "report"]) {
  test(`a single ${phase} failure keeps its identity and still attempts later phases`, async () => {
    const failure = new Error(phase), seen = [];
    const action = name => async () => { seen.push(name); if (phase === name) throw failure; };
    await assert.rejects(runProfileWithReport({ report: {}, run: action("workload"),
      cleanup: action("cleanup"), writeReport: action("report"),
    }), error => error === failure);
    assert.deepEqual(seen, ["workload", "cleanup", "report"]);
  });
}
