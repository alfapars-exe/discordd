/**
 * Cross-environment fullscreen helpers that fall back to vendor-prefixed APIs
 * (e.g. webkitRequestFullscreen in Electron WebViews / Safari) and no-op
 * gracefully when the Fullscreen API is unavailable altogether.
 */

type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void>;
};

type FullscreenDocument = Document & {
  webkitExitFullscreen?: () => Promise<void>;
  webkitFullscreenElement?: Element | null;
};

export function requestFullscreenCompat(el: HTMLElement): Promise<void> {
  const element = el as FullscreenElement;
  if (typeof element.requestFullscreen === "function") {
    return element.requestFullscreen();
  }
  if (typeof element.webkitRequestFullscreen === "function") {
    return element.webkitRequestFullscreen();
  }
  console.warn("[fullscreenCompat] Fullscreen API not available on this element.");
  return Promise.resolve();
}

export function exitFullscreenCompat(): Promise<void> {
  const doc = document as FullscreenDocument;
  if (typeof doc.exitFullscreen === "function") {
    return doc.exitFullscreen();
  }
  if (typeof doc.webkitExitFullscreen === "function") {
    return doc.webkitExitFullscreen();
  }
  console.warn("[fullscreenCompat] exitFullscreen API not available.");
  return Promise.resolve();
}

export function getFullscreenElement(): Element | null {
  const doc = document as FullscreenDocument;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}