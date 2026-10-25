/**
 * useChannelPermissions — Effective channel permission hook.
 *
 * Combines user's base permissions, role IDs, and channel overrides
 * using resolveChannelPermissions (Discord algorithm: (base & ~deny) | allow).
 */

import { useMemo } from "react";
import { getAuthGeneration } from "../api/client";
import { useAuthStore } from "../stores/authStore";
import { useMemberStore } from "../stores/memberStore";
import { useServerStore } from "../stores/serverStore";
import { useChannelPermissionStore } from "../stores/channelPermissionStore";
import { useChannelStore } from "../stores/channelStore";
import { useThreadStore } from "../stores/threadStore";
import { resolveChatChannel } from "../utils/resolveChatChannel";
import {
  resolveChannelPermissions,
  Permissions,
  type Permission,
} from "../utils/permissions";
import type { ChannelPermissionOverride, MemberWithRoles } from "../types";

const EMPTY_MEMBERS: MemberWithRoles[] = [];
const EMPTY_OVERRIDES: ChannelPermissionOverride[] = [];

export function useChannelPermissions(channelID: string | null, explicitServerId?: string, aclSourceChannelID?: string) {
  const currentUser = useAuthStore((s) => s.user);
  const activeServerId = useServerStore((s) => s.activeServerId);
  const serverId = explicitServerId ?? activeServerId;
  const categories = useChannelStore((s) => serverId ? s.categoriesByServer[serverId] : undefined);
  const threadOwnerId = useThreadStore((s) => s.ownerId);
  const threadAuthGeneration = useThreadStore((s) => s.authGeneration);
  const threadsByID = useThreadStore((s) => s.byID);
  const threadServers = useThreadStore((s) => s.serverIdByThread);
  const threadStatusByParent = useThreadStore((s) => s.statusByParent);
  const resolvedChannel = resolveChatChannel(channelID ?? null, serverId ?? undefined, {
    categoriesByServer: serverId ? { [serverId]: categories } : {},
    threads: { ownerId: threadOwnerId, authGeneration: threadAuthGeneration, byID: threadsByID, serverIdByThread: threadServers, statusByParent: threadStatusByParent },
    currentOwnerId: currentUser?.id ?? null,
    currentAuthGeneration: getAuthGeneration(),
  });
  // Threads inherit the parent text channel's ACL. `channelID` remains the
  // actual destination identity; only the override source is redirected.
  const isThread = threadsByID[channelID ?? ""]?.type === "thread";
  const permissionChannelID = isThread
    ? (resolvedChannel?.permissionChannelId && (!aclSourceChannelID || aclSourceChannelID === resolvedChannel.permissionChannelId)
        ? resolvedChannel.permissionChannelId : null)
    : aclSourceChannelID ?? channelID;
  const members = useMemberStore((s) => serverId ? s.membersByServer[serverId] ?? EMPTY_MEMBERS : EMPTY_MEMBERS);
  // Subscribe to the data, not the stable getter: live revocations must render immediately.
  const overrides = useChannelPermissionStore((s) => permissionChannelID ? s.overridesByChannel[permissionChannelID] ?? EMPTY_OVERRIDES : EMPTY_OVERRIDES);

  const currentMember = useMemo(
    () => members.find((m) => m.id === currentUser?.id),
    [members, currentUser?.id]
  );

  const roleIds = useMemo(
    () => currentMember?.roles.map((r) => r.id) ?? [],
    [currentMember?.roles]
  );

  const channelPerms = useMemo(() => {
    const base = currentMember?.effective_permissions ?? 0;
    if (!permissionChannelID || overrides.length === 0) return base;
    return resolveChannelPermissions(base, roleIds, overrides);
  }, [currentMember?.effective_permissions, permissionChannelID, roleIds, overrides]);

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
    if (!serverId) return false;
    if (s.loadingServers.has(serverId)) return false;
    return s.membersByServer[serverId] !== undefined;
  });

  // Sensitive projections (for example a second native overlay surface) must
  // not infer access from cached/optimistic composer permissions. Both source
  // snapshots must have succeeded for this exact account, session and target.
  const memberSnapshotReady = useMemberStore((s) => !!serverId && !!currentUser?.id
    && s.ownerId === currentUser.id && s.authGeneration === getAuthGeneration()
    && s.statusByServer?.[serverId] === "ready" && !s.loadingServers.has(serverId));
  const overrideSnapshotReady = useChannelPermissionStore((s) => {
    if (!permissionChannelID || !serverId || !currentUser?.id) return false;
    const status = s.statusByChannel?.[permissionChannelID];
    return status?.status === "ready" && status.serverId === serverId
      && status.ownerId === currentUser.id && status.authGeneration === getAuthGeneration()
      && Array.isArray(s.overridesByChannel[permissionChannelID]);
  });
  const authorizationResolved = memberSnapshotReady && overrideSnapshotReady && !!currentMember;

  return { channelPerms, hasChannelPerm, permsResolved, authorizationResolved };
}
