/**
 * Member Store — Per-server member list + presence state management.
 * Members are cached per server: `membersByServer[serverId] -> MemberWithRoles[]`.
 * Online user IDs are global (presence is cross-server).
 *
 * Also tracks active moderator timeouts (`timeoutsByServer`) so the
 * MemberCard + MemberItem can draw the muted-until banner/badge. The
 * server already filters expired rows on read, but to keep the UI
 * accurate without polling we also run a client-side setTimeout that
 * clears the local entry when expires_at passes — see the
 * timerHandles map below.
 */

import { create } from "zustand";
import * as memberApi from "../api/members";
import { getAuthGeneration } from "../api/client";
import {
  getAuthSessionOwner,
  subscribeAuthGenerationChanges,
  subscribeAuthOwnerChanges,
} from "../api/authSessionEvents";
import { useServerStore } from "./serverStore";
import type { MemberWithRoles, UserStatus, Role } from "../types";

export type ActiveTimeout = {
  expires_at: string;
  reason?: string;
  applied_by?: string;
};

type MemberState = {
  /** Auth provenance for all account-scoped member/permission caches below. */
  ownerId: string | null;
  authGeneration: number;
  /** Only a successful current-scope fetch establishes a fresh roster. */
  statusByServer: Record<string, "loading" | "ready" | "error">;
  membersByServer: Record<string, MemberWithRoles[]>;
  onlineUserIds: Set<string>;
  loadingServers: Set<string>;
  /**
   * Active timeouts indexed by server, then user. Seeded from
   * member.timeout_expires_at on every fetch, kept up to date by the
   * member_timeout / member_timeout_remove WS events, and auto-cleared
   * by the client-side expiry timer scheduled in scheduleExpiry().
   */
  timeoutsByServer: Record<string, Record<string, ActiveTimeout>>;

  // ─── Selectors ───
  /** Get members for a specific server (returns stable empty array if not loaded) */
  getMembersForServer: (serverId: string) => MemberWithRoles[];
  isLoading: boolean;

  // ─── Actions ───
  fetchMembers: (serverId?: string, force?: boolean) => Promise<void>;

  // ─── WS Event Handlers (all require serverId) ───
  handleReady: (onlineUserIds: string[]) => void;
  handlePresenceUpdate: (userId: string, status: UserStatus) => void;
  handleMemberJoin: (serverId: string, member: MemberWithRoles) => void;
  handleMemberLeave: (serverId: string, userId: string) => void;
  handleMemberUpdate: (serverId: string, member: MemberWithRoles) => void;
  handleProfileAudienceInvalidated: (userId: string) => void;
  handleRoleCreate: (serverId: string, role: Role) => void;
  handleRoleUpdate: (serverId: string, role: Role) => void;
  handleRoleDelete: (serverId: string, roleId: string) => void;
  handleRolesReorder: (serverId: string, roles: Role[]) => void;
  /** WS: member_timeout — moderator applied or extended a timeout. */
  handleMemberTimeout: (
    serverId: string,
    data: { user_id: string; expires_at: string; reason?: string; applied_by?: string },
  ) => void;
  /** WS: member_timeout_remove — moderator lifted (or it expired). */
  handleMemberTimeoutRemove: (serverId: string, userId: string) => void;
  /** Remove cache for a specific server (e.g. on leave/delete) */
  clearServer: (serverId: string) => void;
};

/** Stable empty ref for selectors */
const EMPTY_MEMBERS: MemberWithRoles[] = [];

/** Tracks in-flight fetches to prevent duplicate requests */
const fetchingServers = new Set<string>();
const fetchVersions = new Map<string, number>();
const privacyRefreshServers = new Set<string>();
const privacyRefreshDirtyServers = new Set<string>();

/**
 * Pending expiry timers, keyed by `${serverId}:${userId}`. Lives in
 * module scope (not Zustand state) so scheduling/cancelling doesn't
 * trigger re-renders of timeout selectors. Always cancel-before-set
 * so an extended timeout doesn't fire prematurely.
 */
const timerHandles = new Map<string, ReturnType<typeof setTimeout>>();

function timerKey(serverId: string, userId: string): string {
  return `${serverId}:${userId}`;
}

function clearTimer(serverId: string, userId: string): void {
  const key = timerKey(serverId, userId);
  const handle = timerHandles.get(key);
  if (handle !== undefined) {
    clearTimeout(handle);
    timerHandles.delete(key);
  }
}

function clearAllTimersForServer(serverId: string): void {
  const prefix = `${serverId}:`;
  for (const key of timerHandles.keys()) {
    if (key.startsWith(prefix)) {
      const handle = timerHandles.get(key);
      if (handle !== undefined) clearTimeout(handle);
      timerHandles.delete(key);
    }
  }
}

function clearAllTimers(): void {
  for (const handle of timerHandles.values()) clearTimeout(handle);
  timerHandles.clear();
}

function finishPrivacyRefresh(serverId: string): void {
  if (!privacyRefreshServers.has(serverId)) return;
  privacyRefreshServers.delete(serverId);
  privacyRefreshDirtyServers.delete(serverId);
}

/**
 * Drop every account-owned cache synchronously when identity or token
 * generation changes. In-flight responses are invalidated by the per-server
 * version bump before the state is cleared.
 */
function synchronizeAuthScope(): void {
  const ownerId = getAuthSessionOwner();
  const authGeneration = getAuthGeneration();
  const current = useMemberStore.getState();
  if (current.ownerId === ownerId && current.authGeneration === authGeneration) return;

  const serverIds = new Set([
    ...Object.keys(current.membersByServer),
    ...Object.keys(current.timeoutsByServer),
    ...Object.keys(current.statusByServer),
    ...current.loadingServers,
    ...fetchingServers,
    ...fetchVersions.keys(),
  ]);
  for (const serverId of serverIds) fetchVersions.set(serverId, (fetchVersions.get(serverId) ?? 0) + 1);
  fetchingServers.clear();
  privacyRefreshServers.clear();
  privacyRefreshDirtyServers.clear();
  clearAllTimers();
  useMemberStore.setState({
    ownerId,
    authGeneration,
    statusByServer: {},
    membersByServer: {},
    loadingServers: new Set(),
    onlineUserIds: new Set(),
    timeoutsByServer: {},
  });
}

/**
 * Schedule a local auto-clear when the timeout passes. The server's
 * repo already hides expired rows on the next read, but this keeps the
 * UI honest in the meantime so muted badges don't linger after expiry.
 * Negative/zero delays fire immediately (Date.parse on a past date).
 */
function scheduleExpiry(serverId: string, userId: string, expiresAtIso: string): void {
  clearTimer(serverId, userId);
  const ms = Date.parse(expiresAtIso) - Date.now();
  if (Number.isNaN(ms)) return; // bad ISO → leave it; refresh will fix
  // setTimeout caps at ~24.8 days in browsers; for our 28-day max we
  // still need a clean schedule. If the duration is past the cap we
  // just schedule at the cap and re-evaluate; the WS event or next
  // fetch will refresh the entry well before then.
  const SAFE_MAX = 2_147_483_647; // ~24.8 days
  const delay = Math.max(0, Math.min(ms, SAFE_MAX));
  const handle = setTimeout(() => {
    timerHandles.delete(timerKey(serverId, userId));
    useMemberStore.getState().handleMemberTimeoutRemove(serverId, userId);
  }, delay);
  timerHandles.set(timerKey(serverId, userId), handle);
}

export const useMemberStore = create<MemberState>((set, get) => ({
  ownerId: getAuthSessionOwner(),
  authGeneration: getAuthGeneration(),
  statusByServer: {},
  membersByServer: {},
  onlineUserIds: new Set<string>(),
  loadingServers: new Set(),
  timeoutsByServer: {},

  // ─── Selectors ───

  isLoading: false,

  getMembersForServer: (serverId) => {
    return get().membersByServer[serverId] ?? EMPTY_MEMBERS;
  },

  fetchMembers: async (explicitServerId?, force = false) => {
    synchronizeAuthScope();
    const ownerId = getAuthSessionOwner();
    if (!ownerId) return;
    const serverId = explicitServerId ?? useServerStore.getState().activeServerId;
    if (!serverId) return;
    if (!force && fetchingServers.has(serverId)) return;

    const version = (fetchVersions.get(serverId) ?? 0) + 1;
    fetchVersions.set(serverId, version);
    const generation = getAuthGeneration();
    if (get().ownerId !== ownerId || get().authGeneration !== generation) return;

    fetchingServers.add(serverId);
    set((state) => ({
      loadingServers: new Set([...state.loadingServers, serverId]),
      statusByServer: { ...state.statusByServer, [serverId]: "loading" },
    }));

    // A post-ownership refresh must supersede an older in-flight role list.
    const res = await memberApi.getMembers(serverId).catch(() => ({ success: false, data: undefined }));

    if (fetchVersions.get(serverId) !== version) return;

    // A second privacy invalidation during this read means its snapshot may
    // predate the revocation. Discard it and perform one coalesced fresh read
    // instead of ever installing that older profile data.
    if (privacyRefreshServers.has(serverId) && privacyRefreshDirtyServers.delete(serverId)) {
      fetchingServers.delete(serverId);
      void get().fetchMembers(serverId, true);
      return;
    }

    fetchingServers.delete(serverId);
    if (getAuthSessionOwner() !== ownerId || getAuthGeneration() !== generation
      || get().ownerId !== ownerId || get().authGeneration !== generation) {
      synchronizeAuthScope();
      return;
    }

    if (res.success && Array.isArray(res.data)) {
      // Refresh timer state from the freshly-fetched member list.
      // Cancel any timers that no longer have a backing entry, then
      // reschedule for everyone the server still flagged as timed out.
      clearAllTimersForServer(serverId);
      const seededTimeouts: Record<string, ActiveTimeout> = {};
      for (const m of res.data) {
        if (m.timeout_expires_at) {
          seededTimeouts[m.id] = { expires_at: m.timeout_expires_at };
          scheduleExpiry(serverId, m.id, m.timeout_expires_at);
        }
      }

      set((state) => {
        // Merge member statuses into onlineUserIds
        const merged = new Set(state.onlineUserIds);
        for (const m of res.data!) {
          if (m.status && m.status !== "offline") {
            merged.add(m.id);
          }
        }
        const newLoading = new Set(state.loadingServers);
        newLoading.delete(serverId);
        return {
          membersByServer: { ...state.membersByServer, [serverId]: res.data! },
          onlineUserIds: merged,
          loadingServers: newLoading,
          statusByServer: { ...state.statusByServer, [serverId]: "ready" },
          timeoutsByServer: {
            ...state.timeoutsByServer,
            [serverId]: seededTimeouts,
          },
        };
      });
      finishPrivacyRefresh(serverId);
    } else {
      set((state) => {
        const newLoading = new Set(state.loadingServers);
        newLoading.delete(serverId);
        return {
          loadingServers: newLoading,
          statusByServer: { ...state.statusByServer, [serverId]: "error" },
        };
      });
      finishPrivacyRefresh(serverId);
    }
  },

  // ─── WS Event Handlers ───

  handleReady: (onlineUserIds) => {
    synchronizeAuthScope();
    set({ onlineUserIds: new Set(onlineUserIds) });
    // Fetch members for active server on ready
    const serverId = useServerStore.getState().activeServerId;
    if (serverId) useMemberStore.getState().fetchMembers(serverId);
  },

  handlePresenceUpdate: (userId, status) => {
    synchronizeAuthScope();
    set((state) => {
      const newOnline = new Set(state.onlineUserIds);
      if (status === "offline") {
        newOnline.delete(userId);
      } else {
        newOnline.add(userId);
      }

      // Update status across all cached servers. Offline transitions also
      // stamp last_seen_at locally so the member list can render a live
      // "last seen X ago" label without waiting for a full refetch.
      const updated: Record<string, MemberWithRoles[]> = {};
      let changed = false;
      for (const [sid, members] of Object.entries(state.membersByServer)) {
        const idx = members.findIndex((m) => m.id === userId);
        if (idx >= 0) {
          changed = true;
          updated[sid] = members.map((m) => {
            if (m.id !== userId) return m;
            if (status === "offline") {
              return { ...m, status, last_seen_at: new Date().toISOString() };
            }
            return { ...m, status };
          });
        }
      }

      return {
        onlineUserIds: newOnline,
        membersByServer: changed
          ? { ...state.membersByServer, ...updated }
          : state.membersByServer,
      };
    });
  },

  handleMemberJoin: (serverId, member) => {
    synchronizeAuthScope();
    set((state) => {
      const current = state.membersByServer[serverId];
      if (!current) return state;
      if (current.some((m) => m.id === member.id)) return state;
      return {
        membersByServer: {
          ...state.membersByServer,
          [serverId]: [...current, member],
        },
      };
    });
  },

  handleMemberLeave: (serverId, userId) => {
    synchronizeAuthScope();
    set((state) => {
      const current = state.membersByServer[serverId];
      if (!current) return state;
      const newOnline = new Set(state.onlineUserIds);
      newOnline.delete(userId);
      return {
        membersByServer: {
          ...state.membersByServer,
          [serverId]: current.filter((m) => m.id !== userId),
        },
        onlineUserIds: newOnline,
      };
    });
  },

  handleMemberUpdate: (serverId, updated) => {
    synchronizeAuthScope();
    set((state) => {
      const current = state.membersByServer[serverId];
      if (!current) return state;
      return {
        membersByServer: {
          ...state.membersByServer,
          [serverId]: current.map((m) => {
            if (m.id !== updated.id) return m;
            // Profile update (BroadcastToAll) sends empty roles since it's server-agnostic.
            // Preserve existing roles/permissions in that case.
            const hasRoles = updated.roles && updated.roles.length > 0;
            return {
              ...m,
              ...updated,
              profile_fields_redacted: updated.profile_fields_redacted ?? false,
              ...(updated.profile_fields_redacted ? {
                avatar_animated_url: null,
                banner_url: null,
                banner_animated_url: null,
                bio: null,
                pronouns: null,
                accent_color: null,
              } : {}),
              roles: hasRoles ? updated.roles : m.roles,
              effective_permissions: hasRoles
                ? updated.effective_permissions
                : m.effective_permissions,
            };
          }),
        },
      };
    });
  },

  handleProfileAudienceInvalidated: (userId) => {
    synchronizeAuthScope();
    set((state) => {
      const updated: Record<string, MemberWithRoles[]> = {};
      for (const [serverId, members] of Object.entries(state.membersByServer)) {
        if (!members.some((member) => member.id === userId)) continue;
        updated[serverId] = members.map((member) => member.id === userId
          ? {
              ...member,
              avatar_animated_url: null,
              banner_url: null,
              banner_animated_url: null,
              bio: null,
              pronouns: null,
              accent_color: null,
              profile_fields_redacted: true,
            }
          : member);
      }
      return Object.keys(updated).length > 0
        ? { membersByServer: { ...state.membersByServer, ...updated } }
        : state;
    });
    for (const serverId of new Set([...Object.keys(get().membersByServer), ...fetchingServers])) {
      invalidateMemberRosterFetch(serverId);
    }
  },

  handleRoleCreate: (_serverId, _role) => {
    // Handled by roleStore — member role assignment comes via member_update
  },

  handleRoleUpdate: (serverId, role) => {
    synchronizeAuthScope();
    set((state) => {
      const current = state.membersByServer[serverId];
      if (!current) return state;
      return {
        membersByServer: {
          ...state.membersByServer,
          [serverId]: current.map((m) => {
            const updatedRoles = m.roles.map((r) => (r.id === role.id ? role : r));
            const effectivePerms = updatedRoles.reduce(
              (acc, r) => acc | r.permissions,
              0
            );
            return { ...m, roles: updatedRoles, effective_permissions: effectivePerms };
          }),
        },
      };
    });
  },

  handleRoleDelete: (serverId, roleId) => {
    synchronizeAuthScope();
    set((state) => {
      const current = state.membersByServer[serverId];
      if (!current) return state;
      return {
        membersByServer: {
          ...state.membersByServer,
          [serverId]: current.map((m) => {
            const filteredRoles = m.roles.filter((r) => r.id !== roleId);
            const effectivePerms = filteredRoles.reduce(
              (acc, r) => acc | r.permissions,
              0
            );
            return { ...m, roles: filteredRoles, effective_permissions: effectivePerms };
          }),
        },
      };
    });
  },

  handleRolesReorder: (serverId, roles) => {
    synchronizeAuthScope();
    const roleMap = new Map(roles.map((r) => [r.id, r]));
    set((state) => {
      const current = state.membersByServer[serverId];
      if (!current) return state;
      return {
        membersByServer: {
          ...state.membersByServer,
          [serverId]: current.map((m) => ({
            ...m,
            roles: m.roles.map((r) => roleMap.get(r.id) ?? r),
          })),
        },
      };
    });
  },

  handleMemberTimeout: (serverId, data) => {
    synchronizeAuthScope();
    // (Re-)schedule the local expiry timer first; if the moderator
    // EXTENDED an existing timeout, the existing handle would otherwise
    // fire at the old (earlier) time and prematurely clear the badge.
    scheduleExpiry(serverId, data.user_id, data.expires_at);
    set((state) => {
      const forServer = state.timeoutsByServer[serverId] ?? {};
      return {
        timeoutsByServer: {
          ...state.timeoutsByServer,
          [serverId]: {
            ...forServer,
            [data.user_id]: {
              expires_at: data.expires_at,
              reason: data.reason,
              applied_by: data.applied_by,
            },
          },
        },
      };
    });
  },

  handleMemberTimeoutRemove: (serverId, userId) => {
    synchronizeAuthScope();
    clearTimer(serverId, userId);
    set((state) => {
      const forServer = state.timeoutsByServer[serverId];
      if (!forServer || !(userId in forServer)) return state;
      const { [userId]: _, ...rest } = forServer;
      return {
        timeoutsByServer: {
          ...state.timeoutsByServer,
          [serverId]: rest,
        },
      };
    });
  },

  clearServer: (serverId) => {
    fetchVersions.set(serverId, (fetchVersions.get(serverId) ?? 0) + 1);
    fetchingServers.delete(serverId);
    clearAllTimersForServer(serverId);
    set((state) => {
      const { [serverId]: _members, ...restMembers } = state.membersByServer;
      const { [serverId]: _timeouts, ...restTimeouts } = state.timeoutsByServer;
      const { [serverId]: _status, ...restStatus } = state.statusByServer;
      const loadingServers = new Set(state.loadingServers);
      loadingServers.delete(serverId);
      return {
        loadingServers,
        membersByServer: restMembers,
        timeoutsByServer: restTimeouts,
        statusByServer: restStatus,
      };
    });
  },
}));

/** Invalidate an in-flight roster read after a privacy-redacted WS update.
 * The sanitized event is already applied locally; a future normal fetch may
 * restore fields only after the server re-evaluates the current audience. */
export function invalidateMemberRosterFetch(serverId: string): void {
  if (!serverId || !fetchingServers.has(serverId)) return;
  if (privacyRefreshServers.has(serverId)) {
    privacyRefreshDirtyServers.add(serverId);
    return;
  }
  fetchVersions.set(serverId, (fetchVersions.get(serverId) ?? 0) + 1);
  fetchingServers.delete(serverId);
  privacyRefreshServers.add(serverId);
  useMemberStore.setState((state) => {
    const loadingServers = new Set(state.loadingServers);
    loadingServers.add(serverId);
    return {
      loadingServers,
      statusByServer: {
        ...state.statusByServer,
        [serverId]: "loading",
      },
    };
  });
  void useMemberStore.getState().fetchMembers(serverId, true);
}

// Auth state transitions are published through the cycle-free session bus,
// synchronously before scoped caches can be consumed under a new identity.
subscribeAuthOwnerChanges(() => synchronizeAuthScope());
subscribeAuthGenerationChanges(() => synchronizeAuthScope());

/**
 * Derived selector: members for the currently active server.
 * Use this in components that always show active server data.
 */
export function useActiveMembers(): MemberWithRoles[] {
  const serverId = useServerStore((s) => s.activeServerId);
  const membersByServer = useMemberStore((s) => s.membersByServer);
  if (!serverId) return EMPTY_MEMBERS;
  return membersByServer[serverId] ?? EMPTY_MEMBERS;
}

/**
 * Derived selector: members for a specific server (falls back to active).
 * Use this in components that may show cross-server data (e.g. tabs).
 */
export function useMembersForServer(serverId?: string): MemberWithRoles[] {
  const activeServerId = useServerStore((s) => s.activeServerId);
  const membersByServer = useMemberStore((s) => s.membersByServer);
  const id = serverId ?? activeServerId;
  if (!id) return EMPTY_MEMBERS;
  return membersByServer[id] ?? EMPTY_MEMBERS;
}

/**
 * Derived selector: the active moderator timeout for a (server, user)
 * pair, or undefined when the user is not currently muted. Used by
 * MemberCard to render the "muted until X" banner and by MemberItem
 * to render the clock badge.
 */
export function useMemberTimeout(
  serverId: string | null | undefined,
  userId: string | null | undefined,
): ActiveTimeout | undefined {
  return useMemberStore((s) => {
    if (!serverId || !userId) return undefined;
    return s.timeoutsByServer[serverId]?.[userId];
  });
}
