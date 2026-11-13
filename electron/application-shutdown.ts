/** Coordinate one bounded app quit without letting a repeated quit bypass native cleanup. */
type ShutdownOperations = {
  prepare: () => void;
  flushCookies: () => Promise<void>;
  resources: Array<{ name: string; stop: () => Promise<void> | void | null }>;
  quit: () => void;
  report: (scope: string, reason: "failed" | "timeout") => void;
  schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
};

export function createApplicationShutdown(operations: ShutdownOperations) {
  let state: "idle" | "waiting" | "finished" = "idle";
  const schedule = operations.schedule ?? setTimeout;
  const cancel = operations.cancel ?? clearTimeout;
  const report = (scope: string, reason: "failed" | "timeout") => {
    try { operations.report(scope, reason); } catch { /* Diagnostics cannot block quit. */ }
  };
  return (event: { preventDefault(): void }): void => {
    if (state === "finished") return;
    event.preventDefault();
    if (state === "waiting") return;
    state = "waiting";
    try { operations.prepare(); } catch { report("prepare", "failed"); }
    // Retain best-effort cookie persistence without allowing it to hold native shutdown open.
    void Promise.resolve().then(operations.flushCookies).catch(() => report("cookies", "failed"));
    let finished = false;
    const pending = new Set(operations.resources.map(resource => resource.name));
    const finish = () => {
      if (finished) return;
      finished = true;
      state = "finished";
      cancel(timer);
      operations.quit();
    };
    const timer = schedule(() => {
      for (const name of pending) report(name, "timeout");
      finish();
    }, 5000);
    void Promise.all(operations.resources.map(async resource => {
      try { await resource.stop(); } catch { report(resource.name, "failed"); }
      finally { pending.delete(resource.name); }
    })).then(finish);
  };
}
