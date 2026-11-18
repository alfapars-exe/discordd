/** Keep workload, cleanup and report failures observable without skipping cleanup.
 * Callers own resource identity checks and must join every cleanup operation.
 */
export async function runProfileWithReport({ run, cleanup, writeReport, report }) {
  const failures = [], failurePhases = [];
  let result;
  const attempt = async (phase, action) => {
    try { return await action(); }
    catch (error) { failures.push(error); failurePhases.push(phase); }
  };
  result = await attempt("workload", run);
  await attempt("cleanup", cleanup);
  report.finishedAt = new Date().toISOString();
  report.failurePhases = [...failurePhases];
  report.resultStatus = failures.length ? "failed" : "completed";
  await attempt("report", () => writeReport(report));
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, `Profile failed during: ${failurePhases.join(", ")}`);
  }
  return result;
}
