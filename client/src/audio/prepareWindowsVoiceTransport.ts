import { isElectron } from "../utils/constants";

export const VOICE_TRANSPORT_PREPARATION_TIMEOUT_MS = 2_000;
let preparation: Promise<void> | undefined;
let ready = false;
const listeners = new Set<() => void>();

function canPrepare() {
  // Match manualNativeVideo's Windows desktop policy without importing video/SDK code.
  return isElectron() && /Windows/i.test(navigator.userAgent)
    && typeof VideoEncoder !== "undefined" && typeof VideoEncoder.isConfigSupported === "function";
}

/** Query capability only: no encoder, frames, capture, PeerConnection or keys.
 * Windows' first native PC otherwise synchronously waits for this GPU profile
 * discovery. Starting its asynchronous query early keeps that wait off the UI.
 */
export function prepareWindowsVoiceTransport(): Promise<void> {
  if (preparation) return preparation;
  if (!canPrepare()) { ready = true; return preparation = Promise.resolve(); }
  preparation = new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ready = true;
      resolve();
      listeners.forEach(changed => changed());
    };
    const timer = setTimeout(finish, VOICE_TRANSPORT_PREPARATION_TIMEOUT_MS);
    try {
      // The support boolean is irrelevant: this primes discovery, never changes codec policy.
      void VideoEncoder.isConfigSupported({ codec: "avc1.42001E", width: 640, height: 480,
        hardwareAcceleration: "prefer-hardware" }).then(finish, finish);
    } catch { finish(); }
  });
  return preparation;
}

export const windowsVoiceTransportReady = () => ready || !canPrepare();
export function subscribeWindowsVoiceTransport(changed: () => void) {
  listeners.add(changed);
  return () => { listeners.delete(changed); };
}
