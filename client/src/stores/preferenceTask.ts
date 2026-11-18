import { capturePreferenceScope } from "./preferenceScope";

/** Observe detached preference work without importing stores or loggers.
 * The initiating binding owns diagnostics even when the work settles later.
 */
export function startPreferenceTask(run: () => Promise<unknown>, report: () => void): void {
  const isCurrent = capturePreferenceScope();
  const reportCurrent = () => { if (isCurrent()) report(); };
  // Async invocation keeps factory execution immediate while converting both
  // factory throws and rejected work into the same observed rejection path.
  const invoke = async () => { await run(); };
  void invoke().catch(reportCurrent);
}
