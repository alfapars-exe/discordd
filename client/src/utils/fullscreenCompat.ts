/**
 * Cross-environment fullscreen helpers that fall back to vendor-prefixed APIs
 * (e.g. webkitRequestFullscreen in Electron WebViews / Safari) and no-op
 * gracefully when the Fullscreen API is unavailable altogether.
 *
 * The vendor-prefixed variants predate the promise-returning spec: on the
 * engines that still need them they return `undefined` and report failure by
 * throwing synchronously. Every call therefore goes through `settle()` so that
 * callers can always chain `.catch()` without risking a TypeError on exactly
 * the legacy path these helpers exist to support.
 */

type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => void | Promise<void>;
};

type FullscreenDocument = Document & {
  webkitExitFullscreen?: () => void | Promise<void>;
  webkitFullscreenElement?: Element | null;
};

/** Normalises a fullscreen call that may return a promise, `undefined`, or throw. */
function settle(invoke: () => void | Promise<void>): Promise<void> {
  try {
    return Promise.resolve(invoke()).then(() => undefined);
  } catch (err: unknown) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
}

export function requestFullscreenCompat(el: HTMLElement): Promise<void> {
  const element = el as FullscreenElement;
  const request = element.requestFullscreen ?? element.webkitRequestFullscreen;
  if (typeof request !== "function") {
    console.warn("[fullscreenCompat] Fullscreen API not available on this element.");
    return Promise.resolve();
  }
  return settle(() => request.call(element));
}

export function exitFullscreenCompat(): Promise<void> {
  const doc = document as FullscreenDocument;
  const exit = doc.exitFullscreen ?? doc.webkitExitFullscreen;
  if (typeof exit !== "function") {
    console.warn("[fullscreenCompat] exitFullscreen API not available.");
    return Promise.resolve();
  }
  return settle(() => exit.call(doc));
}

export function getFullscreenElement(): Element | null {
  const doc = document as FullscreenDocument;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}
