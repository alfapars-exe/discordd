type RestartOperations = {
  isCurrent: () => boolean;
  isStreaming: () => boolean;
  getChannelId: () => string | null;
  setRestarting: (restarting: boolean) => void;
  beforeRestart: () => void;
  stop: () => Promise<void>;
  start: (shouldCancel: () => boolean) => Promise<void>;
  failed: (error: unknown) => void;
};

/** Restart only the current capture owner, preserving newer restarts' suppression. */
export async function runScreenShareRestart(operations: RestartOperations): Promise<void> {
  if (!operations.isCurrent() || !operations.isStreaming()) return;
  const channelId = operations.getChannelId();
  const shouldCancel = () => !operations.isCurrent() || !operations.isStreaming() || operations.getChannelId() !== channelId;
  operations.setRestarting(true);
  try {
    operations.beforeRestart();
    await operations.stop();
    if (shouldCancel()) return;
    await operations.start(shouldCancel);
  } catch (error: unknown) {
    if (!shouldCancel()) operations.failed(error);
  } finally {
    if (operations.isCurrent()) operations.setRestarting(false);
  }
}
