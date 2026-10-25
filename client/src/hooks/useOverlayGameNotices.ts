import { useEffect, useState } from "react";
import { getAuthGeneration } from "../api/client";
import { subscribeAuthGenerationChanges, subscribeAuthOwnerChanges } from "../api/authSessionEvents";
import { useAuthStore } from "../stores/authStore";
import { useBlockStore } from "../stores/blockStore";
import { useFriendStore } from "../stores/friendStore";
import { useGameActivityStore, gameActivityKey } from "../stores/gameActivityStore";
import { usePreferencesStore } from "../stores/preferencesStore";
import { usePresenceStore } from "../stores/presenceStore";
import { useVoiceStore } from "../stores/voiceStore";
import { useAccessibilityStore } from "../stores/accessibilityStore";
import { projectAuthorizedOverlayActivity } from "../utils/overlayActivity";
import { OverlayGameNoticeTracker, type OverlayGameNotice, type OverlayGameTransition } from "../utils/overlayGameNotices";
import { isGameActivitySourceBlocked, subscribeGameActivityMutations } from "../utils/gameActivityMutation";

const EMPTY: OverlayGameNotice[] = [];
let liveProjection: (() => OverlayGameNotice[]) | null = null;
/** Revalidate immediately before native publication, not against a React closure. */
export function getLiveOverlayGameNotices(): OverlayGameNotice[] { return liveProjection?.() ?? EMPTY; }

export function attachOverlayGameNotices(connected: boolean, onChange: (notices: OverlayGameNotice[]) => void): () => void {
  const tracker = new OverlayGameNoticeTracker();
  let disposed = false, last = EMPTY, localGame: { id: string; canonicalGameId?: "steam:730" } | null = null;
  let localAt = 0, pollRevision = 0, inFlight = false;
  const input = () => {
    const auth = useAuthStore.getState(), owner = auth.user?.id ?? null, generation = getAuthGeneration();
    const activity = useGameActivityStore.getState(), friends = useFriendStore.getState(), block = useBlockStore.getState();
    const prefs = usePreferencesStore.getState(), voice = useVoiceStore.getState();
    const owned = !!owner && activity.ownerId === owner && activity.authGeneration === generation;
    const ready = !disposed && connected && !!window.electronAPI && owned && !!activity.epoch && voice.voiceOverlayEnabled
      && prefs.accountId === owner && prefs.isLoaded && block.ownerId === owner && block.authGeneration === generation && block.snapshotReady
      && auth.manualStatus !== "dnd" && auth.manualStatus !== "offline";
    return {
      scope: owned && activity.epoch ? JSON.stringify([owner, generation, activity.epoch]) : null,
      ready, gameEnabled: voice.voiceOverlayGameActivityNotifications === true, nowPlayingEnabled: voice.voiceOverlayNowPlayingNotifications === true,
      selfCanonicalGameId: localGame && Date.now() - localAt < 10_000 && !isGameActivitySourceBlocked(localGame.id) ? localGame.canonicalGameId : undefined,
      now: Date.now(), durationMs: useAccessibilityStore.getState().notificationDuration * 1000,
      activities: projectAuthorizedOverlayActivity({ ...activity, currentOwnerId: owner, currentAuthGeneration: generation,
        friends: friends.friends, friendOwnerId: friends.ownerId, friendAuthGeneration: friends.authGeneration, friendsStatus: friends.friendsStatus,
        blockedUserIds: block.blockedUserIds, statusByUserId: usePresenceStore.getState().statusByUserId,
        ignoredUsers: prefs.get<{ ignoredUsers?: Record<string, boolean> }>("privacy")?.ignoredUsers }),
    };
  };
  const project = () => tracker.reconcile(input());
  liveProjection = project;
  const update = (live: OverlayGameTransition[] = []) => {
    if (disposed) return;
    let next = tracker.reconcile(input(), live);
    if (JSON.stringify(next) === JSON.stringify(last)) return;
    // Retire native labels immediately from direct store callbacks, before
    // React can publish a fresh full snapshot. Never resend stale participants.
    const removed = last.filter(item => item.expiresAt > Date.now() && !next.some(current => current.noticeId === item.noticeId)).map(item => item.noticeId);
    if (removed.length) {
      void window.electronAPI?.clearOverlayGameNotices?.().catch(() => undefined);
      next = tracker.remintRetainedNoticeIds();
    }
    last = next; onChange(next);
  };
  onChange(EMPTY);
  update(); // Seeds baseline; existing stored transition markers never replay.
  const subscriptions = [
    useGameActivityStore.subscribe((next, previous) => {
      const live: OverlayGameTransition[] = [];
      for (const friend of useFriendStore.getState().friends) {
        const key = gameActivityKey(friend.user_id), entry = next.entries[key];
        if (entry?.transition && entry.game && entry !== previous.entries[key] && entry.revision > (previous.entries[key]?.revision ?? 0)) live.push({ userId: friend.user_id, game: entry.game });
      }
      update(live);
    }),
    ...[useAuthStore, useBlockStore, useFriendStore, usePreferencesStore, usePresenceStore, useAccessibilityStore].map(store => store.subscribe(() => update())),
    useVoiceStore.subscribe((next, previous) => {
      if (next.voiceOverlayEnabled !== previous.voiceOverlayEnabled || next.voiceOverlayGameActivityNotifications !== previous.voiceOverlayGameActivityNotifications || next.voiceOverlayNowPlayingNotifications !== previous.voiceOverlayNowPlayingNotifications) update();
    }),
    subscribeAuthGenerationChanges(() => { localGame = null; ++pollRevision; update(); }),
    subscribeAuthOwnerChanges(() => { localGame = null; ++pollRevision; update(); }),
  ];
  async function poll() {
    const voice = useVoiceStore.getState(), auth = useAuthStore.getState(), owner = auth.user?.id, generation = getAuthGeneration();
    if (!connected || !owner || !voice.voiceOverlayEnabled || !voice.voiceOverlayNowPlayingNotifications || !window.electronAPI?.getRegisteredGameActivity) {
      localGame = null; ++pollRevision; update(); return;
    }
    if (inFlight || disposed) return;
    inFlight = true;
    const revision = ++pollRevision, epoch = useGameActivityStore.getState().epoch;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([window.electronAPI.getRegisteredGameActivity(), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 4500); })]);
      if (disposed || revision !== pollRevision || owner !== useAuthStore.getState().user?.id || generation !== getAuthGeneration() || epoch !== useGameActivityStore.getState().epoch) return;
      localGame = result?.enabled && result.game && !isGameActivitySourceBlocked(result.game.id) ? { id: result.game.id, ...(result.game.canonicalGameId === "steam:730" ? { canonicalGameId: "steam:730" } : {}) } : null;
      localAt = Date.now();
    } catch { if (revision === pollRevision) localGame = null; }
    finally { if (timer) clearTimeout(timer); inFlight = false; update(); }
  }
  subscriptions.push(subscribeGameActivityMutations((id, blocked) => {
    if (blocked && localGame?.id === id) { localGame = null; ++pollRevision; update(); }
    if (!blocked) void poll();
  }));
  void poll();
  const refresh = setInterval(() => { update(); void poll(); }, 5000);
  const expire = setInterval(() => update(), 250);
  return () => {
    disposed = true; ++pollRevision; localGame = null;
    subscriptions.forEach(unsubscribe => unsubscribe()); clearInterval(refresh); clearInterval(expire);
    if (liveProjection === project) { liveProjection = null; void window.electronAPI?.clearOverlayGameNotices?.().catch(() => undefined); }
  };
}

export function useOverlayGameNotices(connected: boolean) {
  const [notices, setNotices] = useState(EMPTY);
  useEffect(() => attachOverlayGameNotices(connected, setNotices), [connected]);
  return notices;
}
