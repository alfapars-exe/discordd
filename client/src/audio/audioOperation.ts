/** Bound browser audio promises that may never settle after a device/renderer failure. */
export function awaitAudioStep<T>(operation: Promise<T>, label: string, signal?: AbortSignal, timeoutMs = 10000): Promise<T> {
  return new Promise((resolve, reject) => {
    const finish = (complete: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      complete();
    };
    const abort = () => finish(() => reject(new DOMException("Audio operation cancelled", "AbortError")));
    const timer = setTimeout(() => finish(() => reject(new Error(`${label} timed out`))), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    operation.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    if (signal?.aborted) abort();
  });
}

export async function closeAudioContext(context: AudioContext | null | undefined): Promise<void> {
  if (!context || context.state === "closed") return;
  // close() is still requested even if the browser's audio thread cannot ack it.
  await awaitAudioStep(context.close(), "Audio context shutdown", undefined, 2000).catch(() => {});
}
