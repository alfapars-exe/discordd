import { useEffect, useState } from "react";
import * as blockApi from "../api/block";
import { getAuthGeneration } from "../api/client";
import { useAuthStore } from "../stores/authStore";
import { useBlockStore } from "../stores/blockStore";
import type { FriendshipWithUser } from "../types";

/** Full blocked-user rows shared by friends and settings, scoped to the session. */
export function useBlockedUsers() {
  const ownerId = useAuthStore((state) => state.user?.id);
  const generation = useBlockStore((state) => state.authGeneration);
  const blockedIds = useBlockStore((state) => state.blockedUserIds);
  const [snapshot, setSnapshot] = useState<{
    ownerId: string | undefined;
    generation: number;
    blockedIds: string[];
    users: FriendshipWithUser[];
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const isCurrent = () => !cancelled && ownerId === useAuthStore.getState().user?.id && generation === getAuthGeneration();
    if (ownerId) {
      void blockApi.listBlocked({ expectedUserId: ownerId, isCurrent }).then((response) => {
        if (isCurrent()) {
          setSnapshot({ ownerId, generation, blockedIds, users: response.success && response.data ? response.data : [] });
        }
      }).catch(() => {
        if (isCurrent()) setSnapshot({ ownerId, generation, blockedIds, users: [] });
      });
    }
    return () => { cancelled = true; };
  }, [ownerId, generation, blockedIds]);

  // Hide the prior session or relationship revision immediately, before effects run.
  const current = snapshot?.ownerId === ownerId && snapshot?.generation === generation && snapshot?.blockedIds === blockedIds;
  return { blockedUsers: current && snapshot ? snapshot.users : [], isLoading: Boolean(ownerId) && !current };
}
