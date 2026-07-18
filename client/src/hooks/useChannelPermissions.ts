/**
 * useChannelPermissions — Effective channel permission hook.
 *
 * Combines user's base permissions, role IDs, and channel overrides
 * using resolveChannelPermissions (Discord algorithm: (base & ~deny) | allow).
 */

import { useMemo } from "react";
import { useAuthStore } from "../stores/authStore";
import { useActiveMembers, useMemberStore } from "../stores/memberStore";
import { useServerStore } from "../stores/serverStore";
import { useChannelPermissionStore } from "../stores/channelPermissionStore";
import {
  resolveChannelPermissions,
  Permissions,
  type Permission,
} from "../utils/permissions";

export function useChannelPermissions(channelID: string | null) {
  const currentUser = useAuthStore((s) => s.user);
  const members = useActiveMembers();
  const activeServerId = useServerStore((s) => s.activeServerId);
  const getOverrides = useChannelPermissionStore((s) => s.getOverrides);

  const currentMember = useMemo(
    () => members.find((m) => m.id === currentUser?.id),
    [members, currentUser?.id]
  );

  // Wrap in useMemo — `channelID ? store(channelID) : []` would
  // otherwise allocate a fresh `[]` every render and bust the
  // downstream channelPerms memo.
  const overrides = useMemo(
    () => (channelID ? getOverrides(channelID) : []),
    [channelID, getOverrides]
  );

  const roleIds = useMemo(
    () => currentMember?.roles.map((r) => r.id) ?? [],
    [currentMember?.roles]
  );

  const channelPerms = useMemo(() => {
    const base = currentMember?.effective_permissions ?? 0;
    if (!channelID || overrides.length === 0) return base;
    return resolveChannelPermissions(base, roleIds, overrides);
  }, [currentMember?.effective_permissions, channelID, roleIds, overrides]);

  const hasChannelPerm = useMemo(() => {
    return (perm: Permission): boolean => {
      if ((channelPerms & Permissions.Admin) !== 0) return true;
      return (channelPerms & perm) !== 0;
    };
  }, [channelPerms]);

  /**
   * Whether the permission bits above are actually KNOWN, as opposed to
   * defaulted to 0 because the member list hasn't landed yet.
   *
   * `currentMember` is undefined during a channel/server switch and on a
   * cold start, which makes `channelPerms` 0 and every hasChannelPerm()
   * read false — indistinguishable from a real denial. Callers that gate a
   * user action on a permission must consult this before treating `false`
   * as "no": otherwise the action is silently dropped for the first few
   * hundred ms after a switch. (This is the "first Enter doesn't send" bug.)
   *
   * Resolved means: we know which server we're in, its member list is
   * present in the store, and it isn't mid-refetch.
   */
  const permsResolved = useMemberStore((s) => {
    if (!activeServerId) return false;
    if (s.loadingServers.has(activeServerId)) return false;
    return s.membersByServer[activeServerId] !== undefined;
  });

  return { channelPerms, hasChannelPerm, permsResolved };
}
