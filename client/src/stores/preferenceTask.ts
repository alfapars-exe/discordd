import { capturePreferenceScope } from "./preferenceScope";

/** Observe detached preference work without importing stores or loggers.
 * The initiating binding owns diagnostics even when the work settles later.
 */
export function startPreferenceTask(run: () => Promise<unknown>, report: () => void): void {
  const isCurrent = capturePreferenceScope();
  const reportCurrent = () => { if (isCurrent()) report(); };
  try { void Promise.resolve(run()).catch(reportCurrent); }
  catch { reportCurrent(); }
}
