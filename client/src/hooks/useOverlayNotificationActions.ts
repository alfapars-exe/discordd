import { useEffect, useMemo } from "react";
import { getAuthGeneration } from "../api/client";
import { useAuthStore } from "../stores/authStore";
import { useVoiceStore } from "../stores/voiceStore";
import { useUIStore } from "../stores/uiStore";
import { getLiveOverlayNotificationItems } from "../utils/overlayNotificationAccess";
import i18n from "../i18n";

/** Generic inbox entry only; never trusts a native notification target or marks a row read. */
export function useOverlayNotificationActions(connected: boolean, hasVisibleNotifications: boolean) {
  const owner = useAuthStore((s) => s.user?.id ?? null);
  const generation = useAuthStore(() => getAuthGeneration());
  const enabled = useVoiceStore((s) => s.voiceOverlayEnabled && s.voiceOverlayNotifications && s.voiceOverlayNotificationActions);
  const eligible = enabled && connected && hasVisibleNotifications && !!owner;
  const session = useMemo(() => eligible && owner ? `${generation}:${crypto.randomUUID()}` : null, [eligible, generation, owner]);
  useEffect(() => {
    if (!session || !owner) return;
    let disposed = false;
    let busy = false;
    const current = () => {
      const voice = useVoiceStore.getState();
      return !disposed && connected && useAuthStore.getState().user?.id === owner && getAuthGeneration() === generation
        && voice.voiceOverlayEnabled && voice.voiceOverlayNotifications && voice.voiceOverlayNotificationActions
        && getLiveOverlayNotificationItems().length > 0;
    };
    const unsubscribe = window.electronAPI?.onOverlayOpenInbox?.((value) => {
      if (busy || value.session !== session || !current()) return;
      busy = true;
      void (async () => {
        try {
          // Native confirmation consumes a fresh exact-hit intent and focuses only
          // after this main-renderer account check. Recheck again across the await.
          if (await window.electronAPI?.confirmOverlayOpenInbox?.(session) !== true || !current()) return;
          useUIStore.getState().navigate({ type: "inbox", channelId: "inbox", label: i18n.t("common:inbox") });
        } finally { busy = false; }
      })().catch(() => undefined);
    });
    return () => { disposed = true; unsubscribe?.(); };
  }, [session, owner, generation, connected]);
  return session;
}
