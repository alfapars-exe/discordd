/**
 * systemEventHandlers — `ready` reconnect refetch tests.
 *
 * Bug being pinned: channel messages have no optimistic insert, so a
 * message bubble only appears via the WS `message_create` echo. If the
 * socket drops between POST and echo, that echo is lost — and because
 * messageStore guards refetch behind a module-level `fetchedChannels` set,
 * the channel is never fetched again for the life of the tab. The user sees
 * their message vanish and concludes the send failed.
 *
 * On a RE-connect `ready` (not the first one) we drop the fetched-flags so
 * the window can be rebuilt, and eagerly refetch what the user can actually
 * SEE: the active text tab of every panel (split view shows several channels
 * at once), each with its own serverId, plus the sidebar selection. Background
 * tabs heal lazily on next visit.
 *
 * Each test re-imports the module under test through vi.resetModules() so
 * the module-level "have we been ready before" flag starts clean.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AppNotification, WSMessage } from "../../types";
import type { WSHandlerContext } from "./types";
const shell = vi.hoisted(() => ({ enabled: false }));
vi.mock("../../utils/uiShell", () => ({ get UI_SHELL_V2() { return shell.enabled; } }));

vi.mock("../../stores/channelStore", () => ({
  useChannelStore: {
    getState: () => ({
      selectedChannelId: "ch-active",
      setMutedChannelsFromReady: vi.fn(),
      fetchChannels: vi.fn(),
    }),
  },
}));
vi.mock("../../stores/messageStore", () => ({
  useMessageStore: {
    getState: () => ({
      invalidateFetchedFlags: vi.fn(),
      fetchMessages: vi.fn(),
      handleAuthorUpdate: vi.fn(),
    }),
  },
}));
vi.mock("../../stores/memberStore", () => ({
  useMemberStore: { getState: () => ({ handleReady: vi.fn(), fetchMembers: vi.fn(), membersByServer: {}, handlePresenceUpdate: vi.fn(), handleMemberUpdate: vi.fn(), handleProfileAudienceInvalidated: vi.fn(), handleRoleUpdate: vi.fn(), handleRoleDelete: vi.fn() }) },
}));
vi.mock("../../stores/presenceStore", () => ({
  usePresenceStore: { getState: () => ({ handleReady: vi.fn(), handlePresenceUpdate: vi.fn() }) },
}));
vi.mock("../../stores/roleStore", () => ({ useRoleStore: { getState: () => ({ handleRoleUpdate: vi.fn(), handleRoleDelete: vi.fn() }) } }));
vi.mock("../../stores/voiceStore", () => ({
  useVoiceStore: {
    getState: () => ({ currentVoiceChannelId: null, currentVoiceServerId: null, livekitToken: null, handleForceDisconnect: vi.fn(), updateUserInfo: vi.fn(), setVoiceEpoch: vi.fn() }),
  },
}));
vi.mock("../../stores/serverStore", () => ({
  useServerStore: {
    getState: () => ({
      setServersFromReady: vi.fn(),
      setMutedServersFromReady: vi.fn(),
      handleServerDelete: vi.fn(),
      handleServerUpdate: vi.fn(),
    }),
  },
}));
vi.mock("../../stores/readStateStore", () => ({
  useReadStateStore: { getState: () => ({ fetchAllUnreadCounts: vi.fn() }) },
}));
vi.mock("../../stores/authStore", () => ({
  useAuthStore: { getState: () => ({ setManualStatus: vi.fn(), user: { id: "me" } }) },
}));
vi.mock("../../stores/dmStore", () => ({
  useDMStore: {
    getState: () => ({ fetchChannels: vi.fn(), fetchDMSettings: vi.fn(), handleDMAuthorUpdate: vi.fn() }),
  },
}));
vi.mock("../../stores/groupDMStore", () => ({
  useGroupDMStore: { getState: () => ({ fetchGroups: vi.fn(), groups: [] }) },
}));
vi.mock("../../stores/friendStore", () => ({
  useFriendStore: { getState: () => ({ fetchFriends: vi.fn(), fetchRequests: vi.fn() }) },
}));
vi.mock("../../stores/blockStore", () => ({
  useBlockStore: { getState: () => ({ fetchBlocked: vi.fn() }) },
}));
vi.mock("../../stores/p2pCallStore", () => ({ useP2PCallStore: { getState: () => ({}) } }));
vi.mock("../../stores/e2eeStore", () => ({ useE2EEStore: { getState: () => ({}) } }));
vi.mock("../../stores/badgeStore", () => ({ useBadgeStore: { getState: () => ({}) } }));
vi.mock("../../stores/soundboardStore", () => ({
  useSoundboardStore: { getState: () => ({}) },
}));
vi.mock("../../stores/auditStore", () => ({ useAuditStore: { getState: () => ({}) } }));
vi.mock("../../stores/notificationStore", () => ({
  useNotificationStore: { getState: () => ({ fetchCount: vi.fn() }) },
}));
vi.mock("../../stores/toastStore", () => ({
  useToastStore: { getState: () => ({ addToast: vi.fn() }) },
}));
vi.mock("../../i18n", () => ({ default: { t: (key: string) => key, language: "en" } }));
vi.mock("../../utils/sounds", () => ({ playNotificationSound: vi.fn() }));
vi.mock("../../utils/notifications", () => ({ showNotification: vi.fn() }));
// Two panels: panel-1's ACTIVE tab is a cross-server channel (its own
// serverId), with a background tab that must NOT be eagerly healed; panel-2's
// active tab shows the sidebar-selected channel.
vi.mock("../../stores/uiStore", () => ({
  useUIStore: {
    getState: () => ({
      destination: { type: "text", channelId: "single-channel", label: "Single", serverInfo: { serverId: "single-server" } },
      panels: {
        "panel-1": {
          id: "panel-1",
          activeTabId: "tab-1",
          tabs: [
            {
              id: "tab-1",
              channelId: "ch-tab-1",
              type: "text",
              label: "genel",
              serverInfo: { serverId: "srv-9", serverName: "Other", serverIconUrl: null },
            },
            { id: "tab-bg", channelId: "ch-bg", type: "text", label: "arka-plan" },
          ],
        },
        "panel-2": {
          id: "panel-2",
          activeTabId: "tab-2",
          tabs: [
            {
              id: "tab-2",
              channelId: "ch-active",
              type: "text",
              label: "aktif",
              serverInfo: { serverId: "srv-1", serverName: "Main", serverIconUrl: null },
            },
          ],
        },
      },
    }),
  },
}));

const ctx: WSHandlerContext = { sendVoiceJoin: vi.fn() };

const readyMsg: WSMessage = {
  op: "ready",
  d: {
    online_user_ids: [],
    servers: [],
    muted_server_ids: [],
    muted_channel_ids: [],
    pref_status: "",
  },
};

/**
 * Fresh module graph per test so the module-level "seen ready before" flag
 * resets. Returns the handler plus the mocked messageStore spies, which are
 * re-created by the mock factory on every reset.
 */
async function loadFresh() {
  vi.resetModules();
  const { handleSystemEvent } = await import("./systemEventHandlers");
  const { useMessageStore } = await import("../../stores/messageStore");
  // getState() is a factory in the mock — capture one instance and pin it so
  // the handler and the assertions observe the same spies.
  const storeState = useMessageStore.getState();
  vi.spyOn(useMessageStore, "getState").mockReturnValue(storeState);
  return {
    handleSystemEvent,
    invalidateFetchedFlags: storeState.invalidateFetchedFlags,
    fetchMessages: storeState.fetchMessages,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  shell.enabled = false;
});

describe("handleSystemEvent — ready reconnect refetch", () => {
  it("syncs self manual status only when presence explicitly says it is not automatic", async () => {
    const { handleSystemEvent } = await loadFresh();
    const { useAuthStore } = await import("../../stores/authStore");
    const setManualStatus = vi.fn();
    const updateUser = vi.fn();
    const state = {
      ...useAuthStore.getState(),
      user: { id: "me" },
      setManualStatus,
      updateUser,
    } as unknown as ReturnType<typeof useAuthStore.getState>;
    vi.spyOn(useAuthStore, "getState").mockReturnValue(state);

    await handleSystemEvent({ op: "presence_update", d: { user_id: "me", status: "dnd", is_auto: false } } as WSMessage, ctx, vi.fn());
    expect(setManualStatus).toHaveBeenCalledExactlyOnceWith("dnd");
    expect(updateUser).toHaveBeenCalledExactlyOnceWith({ status: "dnd" });

    setManualStatus.mockClear();
    updateUser.mockClear();
    await handleSystemEvent({ op: "presence_update", d: { user_id: "me", status: "idle", is_auto: true } } as WSMessage, ctx, vi.fn());
    expect(setManualStatus).not.toHaveBeenCalled();
    expect(updateUser).toHaveBeenCalledExactlyOnceWith({ status: "idle" });

    setManualStatus.mockClear();
    await handleSystemEvent({ op: "presence_update", d: { user_id: "me", status: "online" } } as WSMessage, ctx, vi.fn());
    expect(setManualStatus).not.toHaveBeenCalled();
  });

  it("routes private media invalidations and refreshes mounted labels on ready", async () => {
    const { handleSystemEvent } = await loadFresh();
    const sync = await import("../../utils/mediaLabelSync");
    const reference = {source_kind:"dm" as const,channel_id:"private",message_id:"message",revision:"original",fingerprint:"a".repeat(64)};
    const notify = vi.fn();
    const unsubscribe = sync.subscribeMediaLabelChanges("me",reference,notify);
    try {
      await handleSystemEvent({op:"media_label_changed",d:{...reference,user_id:"foreign"}},ctx,vi.fn());
      expect(notify).not.toHaveBeenCalled();
      await handleSystemEvent({op:"media_label_changed",d:{...reference,user_id:"me"}},ctx,vi.fn());
      expect(notify).toHaveBeenCalledOnce();
      await handleSystemEvent(readyMsg,ctx,vi.fn());
      expect(notify).toHaveBeenCalledTimes(2);
    } finally { unsubscribe(); }
  });
  it.each(["reaction", "anniversary", "stream"] as const)("plays a %s cue only on the first persistent delivery", async (kind) => {
    const { handleSystemEvent } = await loadFresh();
    const { useNotificationStore } = await import("../../stores/notificationStore");
    const { playNotificationSound } = await import("../../utils/sounds");
    const items: AppNotification[] = [];
    vi.spyOn(useNotificationStore, "getState").mockReturnValue({
      ...useNotificationStore.getState(), items,
      handleCreate: (n: AppNotification) => { if (!items.some((item) => item.id === n.id)) items.push(n); },
    });
    const n: AppNotification = { id: kind, user_id: "me", kind: "system", actor_id: "other", actor: null, server_id: null, channel_id: null, message_id: "message", dm_channel_id: "private", payload: kind === "reaction" ? { subtype: "reaction", emoji: "👍" } : kind === "anniversary" ? { action: "friend_anniversary", years: 2 } : { action: "stream_start" }, read_at: null, created_at: "2026-10-24T00:00:00Z" };
    await handleSystemEvent({ op: "notification_create", d: n }, ctx, vi.fn());
    await handleSystemEvent({ op: "notification_create", d: n }, ctx, vi.fn());
    expect(playNotificationSound).toHaveBeenCalledTimes(1);
    expect(items).toHaveLength(1);
  });
  it("suppresses a delayed group-DM reaction toast after membership is no longer available", async () => {
    const { handleSystemEvent } = await loadFresh();
    const { useNotificationStore } = await import("../../stores/notificationStore");
    const { showNotification } = await import("../../utils/notifications");
    const items: AppNotification[] = [];
    vi.spyOn(useNotificationStore, "getState").mockReturnValue({
      ...useNotificationStore.getState(), items,
      handleCreate: (n: AppNotification) => { if (!items.some((item) => item.id === n.id)) items.push(n); },
    });
    const notification: AppNotification = {
      id: "group-reaction", user_id: "me", kind: "system", actor_id: "other", actor: null,
      server_id: null, channel_id: null, message_id: "message", dm_channel_id: null,
      payload: { subtype: "reaction", group_id: "group-one", emoji: "👍" }, read_at: null,
      created_at: "2026-10-24T00:00:00Z",
    };
    await handleSystemEvent({ op: "notification_create", d: notification }, ctx, vi.fn());

    const options = vi.mocked(showNotification).mock.calls[0]?.[0];
    expect(options?.isStillEligible?.()).toBe(false);
  });
  it("suppresses a delayed group reaction when that member mutes the group",async()=>{
    const {handleSystemEvent}=await loadFresh();const {useGroupDMStore}=await import("../../stores/groupDMStore");
    const {showNotification}=await import("../../utils/notifications");const {useNotificationStore}=await import("../../stores/notificationStore");
    const {useBlockStore}=await import("../../stores/blockStore");vi.spyOn(useBlockStore,"getState").mockReturnValue({...useBlockStore.getState(),isBlocked:()=>false});
    const group={id:"group-one",members:[{id:"me"}],is_muted:false};
    vi.spyOn(useGroupDMStore,"getState").mockReturnValue({...useGroupDMStore.getState(),groups:[group as never]});
    const items:AppNotification[]=[];vi.spyOn(useNotificationStore,"getState").mockReturnValue({...useNotificationStore.getState(),items,handleCreate:n=>{items.push(n)}});
    const notice:AppNotification={id:"private-muted-group",user_id:"me",kind:"system",actor_id:"other",actor:null,server_id:null,channel_id:null,message_id:"message",dm_channel_id:null,payload:{subtype:"reaction",group_id:group.id,emoji:"ok"},read_at:null,created_at:"2026-01-01T00:00:00Z"};
    await handleSystemEvent({op:"notification_create",d:notice},ctx,vi.fn());
    const options=vi.mocked(showNotification).mock.calls[0]?.[0];expect(options?.isStillEligible?.()).toBe(true);
    group.is_muted=true;expect(options?.isStillEligible?.()).toBe(false);
  });
  it("server updates force a fresh role list for the originating server", async () => {
    const { handleSystemEvent } = await loadFresh();
    const { useMemberStore } = await import("../../stores/memberStore");
    const members = useMemberStore.getState();
    vi.spyOn(useMemberStore, "getState").mockReturnValue(members);
    await handleSystemEvent({ op: "server_update", d: { id: "background-server", owner_id: "new-owner", e2ee_enabled: false } } as WSMessage, ctx, vi.fn());
    expect(members.fetchMembers).toHaveBeenCalledExactlyOnceWith("background-server", true);
  });
  it("invalidates only an open profile card on a redacted member event", async () => {
    const { handleSystemEvent } = await loadFresh();
    const { useMemberStore } = await import("../../stores/memberStore");
    const members = useMemberStore.getState();
    vi.spyOn(useMemberStore, "getState").mockReturnValue(members);
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");

    await handleSystemEvent({
      op: "member_update",
      server_id: "background-server",
      d: { id: "target", profile_fields_redacted: true },
    } as WSMessage, ctx, vi.fn());
    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: "hichat:profile-invalidated",
      detail: { userId: "target" },
    }));
  });
  it("invalidates an open DM/friend profile on the privacy-safe global signal", async () => {
    const { handleSystemEvent } = await loadFresh();
    const { useMemberStore } = await import("../../stores/memberStore");
    const members = useMemberStore.getState();
    vi.spyOn(useMemberStore, "getState").mockReturnValue(members);
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");

    await handleSystemEvent({
      op: "profile_audience_invalidated",
      d: { user_id: "target" },
    } as WSMessage, ctx, vi.fn());

    expect(members.handleProfileAudienceInvalidated).toHaveBeenCalledExactlyOnceWith("target");
    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: "hichat:profile-invalidated",
      detail: { userId: "target" },
    }));
  });
  it.each(["role_update", "role_delete", "member_update"] as const)("%s refreshes the originating server rather than the currently browsed one", async (op) => {
    const { handleSystemEvent } = await loadFresh();
    const { useChannelStore } = await import("../../stores/channelStore");
    const channels = useChannelStore.getState();
    vi.spyOn(useChannelStore, "getState").mockReturnValue(channels);

    await handleSystemEvent({ op, server_id: "background-server", d: { id: "me", roles: [] } } as WSMessage, ctx, vi.fn());

    expect(channels.fetchChannels).toHaveBeenCalledExactlyOnceWith("background-server");
  });
  it("delegates server removal without forcing an unrelated voice session to disconnect", async () => {
    const { handleSystemEvent } = await loadFresh();
    const { useVoiceStore } = await import("../../stores/voiceStore");
    const { useServerStore } = await import("../../stores/serverStore");
    const voice = { ...useVoiceStore.getState(), currentVoiceChannelId: "voice-one", currentVoiceServerId: "one" };
    vi.spyOn(useVoiceStore, "getState").mockReturnValue(voice);
    const servers = useServerStore.getState();
    vi.spyOn(useServerStore, "getState").mockReturnValue(servers);

    await handleSystemEvent({ op: "server_delete", d: { id: "two" } }, ctx, vi.fn());

    expect(servers.handleServerDelete).toHaveBeenCalledExactlyOnceWith("two");
    expect(voice.handleForceDisconnect).not.toHaveBeenCalled();
  });
  it("heals only the visible V2 destination, not rollback tabs or stale sidebar selections", async () => {
    shell.enabled = true;
    const { handleSystemEvent, fetchMessages } = await loadFresh();
    await handleSystemEvent(readyMsg, ctx, vi.fn());
    await handleSystemEvent(readyMsg, ctx, vi.fn());
    expect(fetchMessages).toHaveBeenCalledExactlyOnceWith("single-channel", "single-server");
  });
  it("does NOT invalidate or refetch on the first ready (initial connect)", async () => {
    const { handleSystemEvent, invalidateFetchedFlags, fetchMessages } = await loadFresh();

    await handleSystemEvent(readyMsg, ctx, vi.fn());

    expect(invalidateFetchedFlags).not.toHaveBeenCalled();
    expect(fetchMessages).not.toHaveBeenCalled();
  });

  it("invalidates fetched flags and refetches every panel's ACTIVE tab (own serverId) on a re-connect ready", async () => {
    const { handleSystemEvent, invalidateFetchedFlags, fetchMessages } = await loadFresh();

    await handleSystemEvent(readyMsg, ctx, vi.fn());
    await handleSystemEvent(readyMsg, ctx, vi.fn());

    expect(invalidateFetchedFlags).toHaveBeenCalledTimes(1);
    // panel-1 active tab (cross-server, explicit serverId) + panel-2 active
    // tab (which also covers the sidebar selection — no duplicate fetch).
    expect(fetchMessages).toHaveBeenCalledTimes(2);
    expect(fetchMessages).toHaveBeenCalledWith("ch-tab-1", "srv-9");
    expect(fetchMessages).toHaveBeenCalledWith("ch-active", "srv-1");
    // Background tabs heal lazily — never eagerly fetched.
    expect(fetchMessages).not.toHaveBeenCalledWith("ch-bg", undefined);
  });

  it("keeps invalidating on every subsequent reconnect", async () => {
    const { handleSystemEvent, invalidateFetchedFlags } = await loadFresh();

    await handleSystemEvent(readyMsg, ctx, vi.fn());
    await handleSystemEvent(readyMsg, ctx, vi.fn());
    await handleSystemEvent(readyMsg, ctx, vi.fn());

    expect(invalidateFetchedFlags).toHaveBeenCalledTimes(2);
  });
});
