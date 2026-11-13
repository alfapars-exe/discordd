type ShareTransition = {
  streaming: boolean;
  start: (isCancelled: () => boolean) => Promise<void>;
  stop: () => Promise<void>;
  failed: (error: unknown) => void;
};

/** Serializes capture transitions so an old picker cannot be reused by a new start. */
export class ScreenShareLifecycleController {
  private tail: Promise<void> = Promise.resolve();

  transition(operations: ShareTransition): { cancel: () => void; settled: Promise<void> } {
    let cancelled = false;
    const task = this.tail.catch(() => {}).then(async () => {
      // Stops must drain even after their UI owner is replaced.
      if (operations.streaming) {
        if (!cancelled) await operations.start(() => cancelled);
      } else {
        await operations.stop();
      }
    });
    this.tail = task;
    const settled = task.catch(error => {
      if (!cancelled) operations.failed(error);
    });
    return { cancel: () => { cancelled = true; }, settled };
  }
}
