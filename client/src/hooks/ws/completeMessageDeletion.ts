/** Notification failure must not skip the remaining owned deletion effects.
 * Run synchronous publications in order, then await scoped cache cleanup.
 * Retain failures for delivery retry without touching a replacement session.
 */
export async function completeMessageDeletion(
  publications: readonly (() => void)[],
  cleanup: () => Promise<void>,
  isCurrent: () => boolean,
): Promise<void> {
  const failures: unknown[] = [];
  for (const publish of publications) {
    if (!isCurrent()) break;
    try { publish(); } catch (error) { failures.push(error); }
  }
  if (isCurrent()) {
    try { await cleanup(); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "message_deletion_effects_failed", { cause: failures.at(-1) });
  }
}
