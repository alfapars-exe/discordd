/** Acquire listeners with rollback and attempt every owned disposer.
 * Legacy bridges returning void remain supported. Retire ownership before
 * invoking cleanup so repeated or reentrant disposal cannot repeat a callback.
 */
export function ownSubscriptions(subscribe: readonly (() => void | (() => void))[]): () => void {
  let stops: (void | (() => void))[] = [];
  const dispose = () => {
    const owned = stops; stops = [];
    let failed = false, failure: unknown;
    for (const stop of owned) {
      try { stop?.(); }
      catch (error) { if (!failed) { failed = true; failure = error; } }
    }
    if (failed) throw failure;
  };
  try { for (const acquire of subscribe) stops.push(acquire()); }
  catch (error) {
    try { dispose(); } catch { /* Preserve the original acquisition failure. */ }
    throw error;
  }
  return dispose;
}
