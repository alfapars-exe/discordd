import { useMemo } from "react";
import { getAuthGeneration } from "../api/client";
import { useAuthStore } from "../stores/authStore";
import { useBlockStore } from "../stores/blockStore";
import { useFriendStore } from "../stores/friendStore";
import { useGameActivityStore } from "../stores/gameActivityStore";
import { usePresenceStore } from "../stores/presenceStore";
import { projectOverlayActivity } from "../utils/overlayActivity";
const EMPTY: ReturnType<typeof projectOverlayActivity> = [];

export function useOverlayActivity(enabled = true, connected = true) {
  const currentOwnerId = useAuthStore((state) => state.user?.id ?? null);
  const currentAuthGeneration = useAuthStore(() => getAuthGeneration());
  const activity = useGameActivityStore();
  const friends = useFriendStore((state) => state.friends);
  const blockedUserIds = useBlockStore((state) => state.blockedUserIds);
  const statusByUserId = usePresenceStore((state) => state.statusByUserId);
  return useMemo(() => enabled && connected ? projectOverlayActivity({ ...activity, currentOwnerId, currentAuthGeneration, friends, blockedUserIds, statusByUserId }) : EMPTY, [enabled, connected, activity, currentOwnerId, currentAuthGeneration, friends, blockedUserIds, statusByUserId]);
}
