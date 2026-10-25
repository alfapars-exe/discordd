import { create } from "zustand";

/** Transient projection owned by one actual SDK room; never persisted. */
export const useOverlayGoLiveStore = create<{ eligible: boolean; session: string | null }>(() => ({ eligible: false, session: null }));
let currentLease: object | null = null;

export function acquireOverlayGoLiveLease() {
  const lease = {};
  const session = crypto.randomUUID();
  currentLease = lease;
  useOverlayGoLiveStore.setState({ eligible: false, session: null });
  return {
    publish(eligible: boolean) {
      if (currentLease === lease && useOverlayGoLiveStore.getState().eligible !== eligible) useOverlayGoLiveStore.setState({ eligible, session: eligible ? session : null });
    },
    release() {
      if (currentLease === lease) { currentLease = null; useOverlayGoLiveStore.setState({ eligible: false, session: null }); }
    },
  };
}
