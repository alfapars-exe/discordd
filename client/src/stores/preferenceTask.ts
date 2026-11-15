import { capturePreferenceScope } from "./preferenceScope";

/** Observe detached preference work without importing stores or loggers.
 * The initiating binding owns diagnostics even when the work settles later.
 */
export function startPreferenceTask(run: () => Promise<unknown>, report: () => void): void {
  const isCurrent = capturePreferenceScope();
  const reportCurrent = () => { if (isCurrent()) report(); };
  let task: Promise<unknown>;
  try { task = run(); }
  catch { reportCurrent(); return; }
  void Promise.resolve(task).catch(reportCurrent);
}
