import { useEffect, useState, useSyncExternalStore } from "react";
import { getAuthGeneration } from "../api/client";
import { getAuthSessionOwner, subscribeAuthGenerationChanges } from "../api/authSessionEvents";
import { getUserProfileShowcase, type ProfileShowcase } from "../api/profile";

type ShowcaseState = { key: string; value: ProfileShowcase | null };

/** Audience-filtered showcase data is scoped to identity, account and server. */
export function useUserProfileShowcase(userId: string, serverId: string | null): ProfileShowcase | null {
  const ownerId = getAuthSessionOwner();
  const authGeneration = useSyncExternalStore(
    (notify) => subscribeAuthGenerationChanges(() => notify()),
    getAuthGeneration,
    getAuthGeneration,
  );
  const [invalidationVersion, setInvalidationVersion] = useState(0);
  const key = `${userId}\u0000${serverId ?? ""}\u0000${ownerId ?? ""}\u0000${authGeneration}\u0000${invalidationVersion}`;
  const [state, setState] = useState<ShowcaseState>({ key: "", value: null });

  useEffect(() => {
    if (!userId) return;
    const onInvalidated = (event: Event) => {
      const detail = (event as CustomEvent<{ userId?: string }>).detail;
      if (detail?.userId === userId) setInvalidationVersion((current) => current + 1);
    };
    window.addEventListener("hichat:profile-invalidated", onInvalidated);
    let active = true;
    void getUserProfileShowcase(userId, serverId).then((res) => {
      if (!active || getAuthSessionOwner() !== ownerId || getAuthGeneration() !== authGeneration) return;
      setState({ key, value: res.success && res.data ? res.data : null });
    }).catch(() => {
      if (active && getAuthSessionOwner() === ownerId && getAuthGeneration() === authGeneration) {
        setState({ key, value: null });
      }
    });
    return () => {
      active = false;
      window.removeEventListener("hichat:profile-invalidated", onInvalidated);
    };
  }, [userId, serverId, ownerId, authGeneration, invalidationVersion, key]);

  return state.key === key ? state.value : null;
}
