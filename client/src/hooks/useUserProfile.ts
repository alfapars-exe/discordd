/**
 * useUserProfile — lazily fetch a user's public profile (banner, bio,
 * pronouns, accent colour, animated avatar) for the MemberCard. It is used
 * for all other-user cards so profile audience changes are checked by the
 * server even when a server-member cache may be stale.
 *
 * Deliberately local state, no global cache: nothing per-user survives the
 * component, so logout needs no reset (trap #226). A stale response from a
 * previous userId (or after unmount) is dropped via a cancel flag.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { getAuthGeneration } from "../api/client";
import { getAuthSessionOwner, subscribeAuthGenerationChanges } from "../api/authSessionEvents";
import { getUserProfile } from "../api/profile";
import type { UserProfile } from "../types";

/** The settled result of the last fetch, keyed by the userId it was for. */
type State = { userId: string; ownerId: string | null; authGeneration: number; version: number; profile: UserProfile | null };

export function invalidateUserProfile(userId: string): void {
  if (!userId || typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("hichat:profile-invalidated", { detail: { userId } }));
}

export function useUserProfile(
  userId: string,
  enabled: boolean,
): { profile: UserProfile | null; loading: boolean } {
  const [state, setState] = useState<State>({
    userId: "", ownerId: null, authGeneration: -1, version: -1, profile: null,
  });
  const [version, setVersion] = useState(0);
  const ownerId = getAuthSessionOwner();
  const authGeneration = useSyncExternalStore(
    (notify) => subscribeAuthGenerationChanges(() => notify()),
    getAuthGeneration,
    getAuthGeneration,
  );

  useEffect(() => {
    if (!enabled || !userId) return;
    const onInvalidated = (event: Event) => {
      const detail = (event as CustomEvent<{ userId?: string }>).detail;
      if (detail?.userId === userId) setVersion((current) => current + 1);
    };
    window.addEventListener("hichat:profile-invalidated", onInvalidated);
    let cancelled = false;
    getUserProfile(userId)
      .then((res) => {
        if (cancelled) return;
        if (getAuthSessionOwner() !== ownerId || getAuthGeneration() !== authGeneration) return;
        setState({ userId, ownerId, authGeneration, version, profile: res.success && res.data ? res.data : null });
      })
      .catch(() => {
        if (!cancelled && getAuthSessionOwner() === ownerId && getAuthGeneration() === authGeneration) {
          setState({ userId, ownerId, authGeneration, version, profile: null });
        }
      });
    return () => {
      cancelled = true;
      window.removeEventListener("hichat:profile-invalidated", onInvalidated);
    };
  }, [userId, enabled, version, ownerId, authGeneration]);

  if (!enabled || !userId) return { profile: null, loading: false };
  // Until the fetch for THIS userId settles we are loading — and never
  // surface a profile that was fetched for a previous userId.
  if (state.userId !== userId || state.ownerId !== ownerId
    || state.authGeneration !== authGeneration || state.version !== version) {
    return { profile: null, loading: true };
  }
  return { profile: state.profile, loading: false };
}
