import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { getAuthSessionSnapshot } from "../api/authSessionEvents";
import { useAuthStore } from "../stores/authStore";
import { useVoiceStore } from "../stores/voiceStore";
import { useNotificationStore } from "../stores/notificationStore";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useBlockStore } from "../stores/blockStore";
import { useChannelStore } from "../stores/channelStore";
import { useMemberStore } from "../stores/memberStore";
import { useChannelPermissionStore } from "../stores/channelPermissionStore";
import { useThreadStore } from "../stores/threadStore";
import { useMessageStore } from "../stores/messageStore";
import { useGroupDMStore } from "../stores/groupDMStore";
import { useDMStore } from "../stores/dmStore";
import { useE2EEStore } from "../stores/e2eeStore";
import { useSpamDecisionStore } from "../stores/spamDecisionStore";
import { useFriendStore } from "../stores/friendStore";
import { useToastStore } from "../stores/toastStore";
import { useOpenAtMessage } from "./useOpenAtMessage";
import { notificationReplyBinding, prepareOverlayNotificationReply, primeOverlayNotificationReplyAccess, resolveOverlayNotificationReplySource } from "../utils/overlayNotificationReply";
import type { OverlayNotification } from "../utils/overlayNotifications";
import i18n from "../i18n";

export function useOverlayNotificationReply(connected: boolean, notifications: readonly OverlayNotification[]) {
  const owner = useAuthStore(s => s.user?.id);
  const generation = useAuthStore(() => getAuthSessionSnapshot().generation);
  const enabled = useVoiceStore(s => s.voiceOverlayEnabled && s.voiceOverlayNotifications && s.voiceOverlayNotificationActions);
  useNotificationStore(); usePreferencesStore(); useBlockStore(); useChannelStore(); useMemberStore();
  useChannelPermissionStore(); useThreadStore(); useMessageStore(); useDMStore(); useGroupDMStore(); useE2EEStore(); useSpamDecisionStore(); useFriendStore();
  const { openAtMessage, openAtDMMessage, openAtGroupMessage } = useOpenAtMessage();
  const groupOpenRef = useRef(openAtGroupMessage);
  const dmOpenRef = useRef(openAtDMMessage);
  const openRef = useRef(openAtMessage), connectedRef = useRef(connected);
  useLayoutEffect(() => { openRef.current = openAtMessage; dmOpenRef.current = openAtDMMessage; groupOpenRef.current = openAtGroupMessage; connectedRef.current = connected; }, [openAtMessage, openAtDMMessage, openAtGroupMessage, connected]);
  const bridge = window.electronAPI;
  const supported = !!bridge?.onOverlayPrepareNotificationReply && !!bridge.confirmOverlayPrepareNotificationReply;
  const ids = notifications.slice(0, 3).map(item => item.id), idsKey = JSON.stringify(ids);
  useEffect(() => {
    if (!enabled || !connected || !owner || !supported) return;
    void useBlockStore.getState().fetchBlocked().catch(() => {});
    void primeOverlayNotificationReplyAccess(JSON.parse(idsKey) as string[]);
  }, [enabled, connected, owner, generation, supported, idsKey]);
  const sources = enabled && connected && supported ? ids.map(id => resolveOverlayNotificationReplySource(id)).filter(source => source !== null) : [];
  const binding = JSON.stringify(sources.map(notificationReplyBinding));
  const session = useMemo(() => binding !== "[]" ? `${generation}:${crypto.randomUUID()}` : undefined, [binding, generation]);
  useEffect(() => {
    if (!session || !owner) return;
    let disposed = false, busy = false;
    const sourceMap = new Map(sources.map(source => [source.notificationId, source]));
    const current = () => {
      const auth = getAuthSessionSnapshot(), voice = useVoiceStore.getState();
      return !disposed && connectedRef.current && auth.ownerId === owner && auth.generation === generation
        && voice.voiceOverlayEnabled && voice.voiceOverlayNotifications && voice.voiceOverlayNotificationActions;
    };
    const stop = bridge?.onOverlayPrepareNotificationReply?.(value => {
      if (busy || value?.session !== session || !current()) return;
      const source = sourceMap.get(value.notificationId);
      const live = source && resolveOverlayNotificationReplySource(source.notificationId);
      if (!source || !live || notificationReplyBinding(live) !== notificationReplyBinding(source)) return;
      busy = true;
      void (async () => {
        if (await bridge.confirmOverlayPrepareNotificationReply!({ session, notificationId: source.notificationId }) !== true || !current()) return;
        const result = await prepareOverlayNotificationReply(source, (...args) => openRef.current(...args), current, (...args) => dmOpenRef.current(...args), (...args) => groupOpenRef.current(...args));
        if (current() && result !== "prepared") useToastStore.getState().addToast("info", i18n.t(result === "conflict" ? "common:overlayReplyDraftConflict" : "common:overlayReplyUnavailable"));
      })().catch(() => { if (current()) useToastStore.getState().addToast("error", i18n.t("common:overlayReplyUnavailable")); })
        .finally(() => { busy = false; });
    });
    return () => { disposed = true; stop?.(); };
  // Sources are immutable descriptors fully represented by binding.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, owner, generation, bridge, binding]);
  const idBinding = JSON.stringify(sources.map(source => source.notificationId));
  const notificationReplyIds = useMemo(() => JSON.parse(idBinding) as string[], [idBinding]);
  return { notificationReplySession: session, notificationReplyIds };
}
