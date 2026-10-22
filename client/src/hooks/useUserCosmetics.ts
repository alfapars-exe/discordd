/**
 * useUserCosmetics — the slots to render for `userId` (Faz G).
 *
 *   scope = server id → that server's resolved slots (override > global,
 *           "plain here" already applied server-side). Until the server map
 *           is loaded, falls back to the user's GLOBAL slots.
 *   scope = null      → GLOBAL slots (DM / friends context), lazily fetched
 *           through the store's batched lookup.
 *
 * Viewer "plain view" hides everyone's cosmetics except your own. The
 * selector returns only this user's value, so rows re-render only when
 * their own slots change (references are kept stable by the store).
 */

import { useEffect } from "react";
import { useAuthStore } from "../stores/authStore";
import { useCosmeticsStore } from "../stores/cosmeticsStore";
import { useCosmeticsPlainView } from "./useCosmeticsViewPrefs";
import { EMPTY_SLOTS } from "../utils/cosmetics";
import type { CosmeticSlots } from "../types/cosmetics";

export function useUserCosmetics(userId: string | null | undefined, scope: string | null): CosmeticSlots {
  const myId = useAuthStore((s) => s.user?.id);
  const plainView = useCosmeticsPlainView();
  const hidden = plainView && !!userId && userId !== myId;

  const serverLoaded = useCosmeticsStore((s) => (scope ? !!s.loadedServers[scope] : false));
  const slots = useCosmeticsStore((s) => {
    if (!userId) return EMPTY_SLOTS;
    if (scope && s.loadedServers[scope]) return s.byServer[scope]?.[userId] ?? EMPTY_SLOTS;
    return s.global[userId] ?? EMPTY_SLOTS;
  });
  const requestGlobal = useCosmeticsStore((s) => s.requestGlobal);

  const needGlobal = !!userId && !hidden && !serverLoaded;
  useEffect(() => {
    // The store skips ids that are fresh (5 min TTL) or already in flight.
    if (needGlobal && userId) requestGlobal([userId]);
  }, [needGlobal, userId, requestGlobal]);

  return hidden ? EMPTY_SLOTS : slots;
}
