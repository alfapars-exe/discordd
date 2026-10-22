/**
 * useUserProfile — lazily fetch a user's public profile (banner, bio,
 * pronouns, accent colour, animated avatar) for the MemberCard when only a
 * PublicUser is at hand (DM, friends, inbox). Server-context cards already
 * get these fields on MemberWithRoles and pass enabled=false.
 *
 * Deliberately local state, no global cache: nothing per-user survives the
 * component, so logout needs no reset (trap #226). A stale response from a
 * previous userId (or after unmount) is dropped via a cancel flag.
 */

import { useEffect, useState } from "react";
import { getUserProfile } from "../api/profile";
import type { UserProfile } from "../types";

/** The settled result of the last fetch, keyed by the userId it was for. */
type State = { userId: string; profile: UserProfile | null };

export function useUserProfile(
  userId: string,
  enabled: boolean,
): { profile: UserProfile | null; loading: boolean } {
  const [state, setState] = useState<State>({ userId: "", profile: null });

  useEffect(() => {
    if (!enabled || !userId) return;
    let cancelled = false;
    getUserProfile(userId)
      .then((res) => {
        if (cancelled) return;
        setState({ userId, profile: res.success && res.data ? res.data : null });
      })
      .catch(() => {
        if (!cancelled) setState({ userId, profile: null });
      });
    return () => {
      cancelled = true;
    };
  }, [userId, enabled]);

  if (!enabled || !userId) return { profile: null, loading: false };
  // Until the fetch for THIS userId settles we are loading — and never
  // surface a profile that was fetched for a previous userId.
  if (state.userId !== userId) return { profile: null, loading: true };
  return { profile: state.profile, loading: false };
}
