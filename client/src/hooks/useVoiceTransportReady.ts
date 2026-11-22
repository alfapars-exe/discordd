import { useEffect, useSyncExternalStore } from "react";
import { prepareWindowsVoiceTransport, subscribeWindowsVoiceTransport, windowsVoiceTransportReady } from "../audio/prepareWindowsVoiceTransport";

/** Readiness belongs to this renderer's capability cache, never to an account or room. */
export function useVoiceTransportReady() {
  const ready = useSyncExternalStore(subscribeWindowsVoiceTransport, windowsVoiceTransportReady, () => true);
  useEffect(() => { void prepareWindowsVoiceTransport(); }, []);
  return ready;
}
