/** Zustand commits state before invoking synchronous observers. Complete
 * owned cache/queue work even when an observer throws, then preserve the error.
 * Callers must still fence ownership and inspect the committed current values.
 */
export function completePreferenceMutation(update: () => void, complete: () => void): void {
  let failed = false, failure: unknown;
  try { update(); } catch (error) { failed = true; failure = error; }
  try { complete(); }
  catch (error) {
    if (failed) throw new AggregateError([failure, error], "preference_notification_and_completion_failed", { cause: error });
    throw error;
  }
  if (failed) throw failure;
}
