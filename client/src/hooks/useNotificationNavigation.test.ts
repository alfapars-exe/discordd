import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel } from "../types";

const mocks = vi.hoisted(() => ({
  userId: "u1" as string | null,
  generation: 7,
  feedOwner: "u1" as string | null,
  feedGeneration: 7,
  blockedUserIds: [] as string[],
  channelNotificationsEnabled: false,
  ignoredUsers: {} as Record<string, boolean>,
  mutedChannels: new Set<string>(),
  mutedServers: new Set<string>(),
  channelMemberState: { ownerId: "u1" as string | null, authGeneration: 7, statusByServer: { "server-1": "ready" }, loadingServers: new Set<string>(), membersByServer: { "server-1": [{ id: "u1", roles: [{ id: "role" }], effective_permissions: 6144 }] } } as { ownerId: string | null; authGeneration: number; statusByServer: Record<string, string>; loadingServers: Set<string>; membersByServer: Record<string, { id: string; roles: { id: string }[]; effective_permissions: number }[]> },
  channelOverridesState: { overridesByChannel: { "channel-1": [] }, statusByChannel: { "channel-1": { serverId: "server-1", ownerId: "u1", authGeneration: 7, status: "ready" } } } as { overridesByChannel: Record<string, { role_id: string; allow: number; deny: number }[]>; statusByChannel: Record<string, { serverId: string; ownerId: string; authGeneration: number; status: string }> },
  channelTree: [] as { channels: { id: string; type?: string }[] }[],
  threadState: { ownerId: "u1" as string | null, authGeneration: 7, byID: {} as Record<string, Partial<Channel>>, serverIdByThread: {} as Record<string, string>, statusByParent: {} as Record<string, "loading" | "ready" | "error">, statusByThread: {} as Record<string, "loading" | "ready" | "error"> },
  dmChannels: [] as { id: string; status: string; is_muted: boolean; other_user: { id: string } }[],
  groups: [] as { id: string; name: string; key_epoch?:number;read_key_epoch?:number;is_muted?:boolean; members: { id: string }[] }[],
  markRead: vi.fn(),
  openServerEvents: vi.fn(),
  openServer: vi.fn(),
  openTab: vi.fn(),
  openAtMessage: vi.fn(),
  openAtGroupMessage:vi.fn(),listGroups:vi.fn(), openAtDMMessage: vi.fn(), listDMs: vi.fn(),
  selectChannel: vi.fn(),
  selectDM: vi.fn(),
  fetchDMMessages: vi.fn(),
  clearDMUnread: vi.fn(),
  closeAllDrawers: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
vi.mock("../api/client", () => ({ getAuthGeneration: () => mocks.generation }));
vi.mock("../api/authSessionEvents",()=>({getAuthSessionSnapshot:()=>({ownerId:mocks.userId,generation:mocks.generation})}));
vi.mock("../api/groupDM",()=>({listGroupDMs:mocks.listGroups}));
vi.mock("../stores/e2eeStore",()=>({useE2EEStore:{getState:()=>({localDeviceId:"device",initStatus:"ready",decryptionErrors:[]})}}));
vi.mock("../utils/messageSpamPolicy",()=>({shouldSuppressMessagePreview:()=>false}));
vi.mock("../api/dm", () => ({ listDMChannels: mocks.listDMs }));
vi.mock("../stores/preferencesStore", () => ({ usePreferencesStore: {getState:()=>({accountId:mocks.userId,isLoaded:true,get:(namespace:string)=>namespace==="notifications"?{channelMessageNotifications:mocks.channelNotificationsEnabled}:{ignoredUsers:mocks.ignoredUsers}}) } }));
vi.mock("../stores/notificationStore", () => ({
  useNotificationStore: Object.assign((pick: (state: unknown) => unknown) => pick({ markRead: mocks.markRead, ownerId: mocks.feedOwner, authGeneration: mocks.feedGeneration }), {
    getState: () => ({ markRead: mocks.markRead, ownerId: mocks.feedOwner, authGeneration: mocks.feedGeneration }),
  }),
}));
vi.mock("../stores/uiStore", () => ({
  useUIStore: Object.assign((pick: (state: unknown) => unknown) => pick({ openTab: mocks.openTab }), {
    getState: () => ({ openTab: mocks.openTab, openServer: mocks.openServer, openServerEvents: mocks.openServerEvents }),
  }),
}));
vi.mock("../stores/serverStore", () => ({
  useServerStore: Object.assign((pick: (state: unknown) => unknown) => pick({
    servers: [{ id: "server-1", name: "Team", icon_url: null }],
    activeServerId: "server-1",
  }), { getState: () => ({ servers: [{ id: "server-1", name: "Team", icon_url: null }], activeServerId: "server-1", mutedServerIds: mocks.mutedServers }) }),
}));
vi.mock("../stores/channelStore", () => ({
  useChannelStore: Object.assign((pick: (state: unknown) => unknown) => pick({ selectChannel: mocks.selectChannel, categoriesByServer: { "server-1": mocks.channelTree } }), {
    getState: () => ({ selectChannel: mocks.selectChannel, categoriesByServer: { "server-1": mocks.channelTree }, mutedChannelIds: mocks.mutedChannels }),
  }),
}));
vi.mock("../stores/threadStore", () => ({ useThreadStore: { getState: () => mocks.threadState } }));
vi.mock("../stores/memberStore", () => ({ useMemberStore: { getState: () => mocks.channelMemberState } }));
vi.mock("../stores/channelPermissionStore", () => ({ useChannelPermissionStore: { getState: () => mocks.channelOverridesState } }));
vi.mock("../stores/authStore", () => ({
  useAuthStore: Object.assign((pick: (state: unknown) => unknown) => pick({ user: { id: mocks.userId } }), {
    getState: () => ({ user: mocks.userId ? { id: mocks.userId } : null }),
  }),
}));
vi.mock("../stores/dmStore", () => ({
  useDMStore: Object.assign((pick: (state: unknown) => unknown) => pick({
    selectDM: mocks.selectDM, fetchMessages: mocks.fetchDMMessages, clearDMUnread: mocks.clearDMUnread,
    channels: mocks.dmChannels,
  }), { getState: () => ({ ownerId:mocks.userId,authGeneration:mocks.generation,isLoading:false,selectDM: mocks.selectDM, fetchMessages: mocks.fetchDMMessages, clearDMUnread: mocks.clearDMUnread, channels: mocks.dmChannels }) }),
}));
vi.mock("../stores/groupDMStore", () => ({ useGroupDMStore: { getState: () => ({ ownerId:mocks.userId,authGeneration:mocks.generation,groupsReady:true,loading:false,messages:{group:[{id:"source",group_id:"group",user_id:"actor",content:"hello",encryption_version:1}]},groups: mocks.groups, fetchMessages: vi.fn() }) } }));
vi.mock("../stores/blockStore", () => ({ useBlockStore: { getState: () => ({ ownerId:mocks.userId,authGeneration:mocks.generation,snapshotReady:true,isLoading:false,blockedUserIds: mocks.blockedUserIds }) } }));
vi.mock("../stores/mobileStore", () => ({
  useMobileStore: (pick: (state: unknown) => unknown) => pick({ closeAllDrawers: mocks.closeAllDrawers }),
}));
vi.mock("./useOpenAtMessage", () => ({ useOpenAtMessage: () => ({ openAtMessage: mocks.openAtMessage,openAtDMMessage:mocks.openAtDMMessage,openAtGroupMessage:mocks.openAtGroupMessage }) }));

import { useNotificationNavigation } from "./useNotificationNavigation";

const eventNotice = (userId = "u1") => ({
  id: "notification-1", user_id: userId, kind: "system" as const,
  actor_id: null, actor: null, server_id: "server-1", channel_id: null,
  message_id: null, dm_channel_id: null,
  payload: { title: "Event starts soon", event_id: "event-1" },
  read_at: null, created_at: "2026-10-24T00:00:00Z",
});

describe("useNotificationNavigation server event notices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userId = "u1";
    mocks.generation = 7;
    mocks.feedOwner = "u1";
    mocks.feedGeneration = 7;
    mocks.blockedUserIds = [];
    mocks.channelNotificationsEnabled = false;
    mocks.ignoredUsers = {};
    mocks.mutedChannels = new Set();
    mocks.mutedServers = new Set();
    mocks.channelMemberState = { ownerId: "u1", authGeneration: 7, statusByServer: { "server-1": "ready" }, loadingServers: new Set(), membersByServer: { "server-1": [{ id: "u1", roles: [{ id: "role" }], effective_permissions: 6144 }] } };
    mocks.channelOverridesState = { overridesByChannel: { "channel-1": [] }, statusByChannel: { "channel-1": { serverId: "server-1", ownerId: "u1", authGeneration: 7, status: "ready" } } };
    mocks.channelTree = [];
    mocks.threadState = { ownerId: "u1", authGeneration: 7, byID: {}, serverIdByThread: {}, statusByParent: {}, statusByThread: {} };
    mocks.dmChannels = [];
    mocks.groups = [];
  });

  it("opens an accepted incoming DM at its exact source before acknowledging, without generic request navigation",async()=>{
    const dm={id:"dm-1",status:"accepted",is_muted:false,other_user:{id:"actor"}};mocks.dmChannels=[dm];mocks.listDMs.mockResolvedValueOnce({success:true,data:[dm]});
    let finish!:(value:boolean)=>void;mocks.openAtDMMessage.mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
    const {result}=renderHook(()=>useNotificationNavigation());
    const n={...eventNotice(),server_id:null,actor_id:"actor",dm_channel_id:"dm-1",message_id:"message-1",payload:{action:"incoming_message",source:"dm"}};
    await act(async()=>{result.current(n);});
    expect(mocks.openAtDMMessage).toHaveBeenCalledWith("dm-1","message-1",expect.objectContaining({isCurrent:expect.any(Function)}));
    expect(mocks.markRead).not.toHaveBeenCalled();expect(mocks.clearDMUnread).not.toHaveBeenCalled();
    await act(async()=>{finish(true);});expect(mocks.markRead).toHaveBeenCalledExactlyOnceWith(n.id);
  });
  it("does not acknowledge an incoming DM when fresh access is denied",async()=>{
    mocks.dmChannels=[{id:"dm-1",status:"accepted",is_muted:false,other_user:{id:"actor"}}];mocks.listDMs.mockResolvedValueOnce({success:true,data:[]});
    const {result}=renderHook(()=>useNotificationNavigation());
    await act(async()=>{result.current({...eventNotice(),server_id:null,actor_id:"actor",dm_channel_id:"dm-1",message_id:"message-1",payload:{action:"incoming_message",source:"dm"}});});
    expect(mocks.openAtDMMessage).not.toHaveBeenCalled();expect(mocks.markRead).not.toHaveBeenCalled();
  });

  it("requires opt-in and opens an allowed channel source before acknowledging it", async () => {
    mocks.channelTree = [{ channels: [{ id: "channel-1" }] }];
    const { result } = renderHook(() => useNotificationNavigation());
    const n = { ...eventNotice(), actor_id: "actor", channel_id: "channel-1", message_id: "source",
      payload: { action: "incoming_message", source: "channel" } };
    await act(async () => { result.current(n); });
    expect(mocks.openAtMessage).not.toHaveBeenCalled();
    expect(mocks.markRead).not.toHaveBeenCalled();
    mocks.channelNotificationsEnabled = true;
    mocks.openAtMessage.mockResolvedValueOnce(true);
    await act(async () => { result.current(n); await Promise.resolve(); });
    expect(mocks.openAtMessage).toHaveBeenCalledWith("server-1", "channel-1", "source", "", expect.objectContaining({ isCurrent: expect.any(Function) }));
    expect(mocks.markRead).toHaveBeenCalledWith(n.id);
  });

  it.each(["opt-out", "ignore", "block", "server-mute", "parent-mute", "ACL-revoke"] as const)(
    "cancels channel notification navigation if %s changes during message fetch", async change => {
      mocks.channelNotificationsEnabled = true;
      const parentId = "channel-1";
      mocks.channelTree = [{ channels: [{ id: parentId, type: "text" }] }];
      const useThread = change === "parent-mute" || change === "ACL-revoke";
      const channelId = useThread ? "thread-1" : parentId;
      if (useThread) {
        const parentKey = JSON.stringify(["server-1", parentId]);
        mocks.threadState = {
          ownerId: "u1", authGeneration: 7,
          byID: { [channelId]: { id: channelId, type: "thread", name: "Thread", parent_channel_id: parentId } },
          serverIdByThread: { [channelId]: "server-1" },
          statusByParent: { [parentKey]: "ready" }, statusByThread: { [channelId]: "ready" },
        };
        mocks.channelOverridesState = { overridesByChannel: { [parentId]: [] }, statusByChannel: { [parentId]: { serverId: "server-1", ownerId: "u1", authGeneration: 7, status: "ready" } } };
      }
      let finish!: () => void;
      let stillCurrent: boolean | undefined;
      mocks.openAtMessage.mockImplementationOnce((_server, _channel, _message, _label, context) =>
        new Promise<boolean>(resolve => { finish = () => { stillCurrent = context.isCurrent(); resolve(stillCurrent!); }; }));
      const { result } = renderHook(() => useNotificationNavigation());
      const n = { ...eventNotice(), actor_id: "actor", channel_id: channelId, message_id: "source",
        payload: { action: "incoming_message", source: "channel" } };
      act(() => result.current(n));
      expect(mocks.openAtMessage).toHaveBeenCalledOnce();

      if (change === "opt-out") mocks.channelNotificationsEnabled = false;
      if (change === "ignore") mocks.ignoredUsers.actor = true;
      if (change === "block") mocks.blockedUserIds = ["actor"];
      if (change === "server-mute") mocks.mutedServers = new Set(["server-1"]);
      if (change === "parent-mute") mocks.mutedChannels = new Set([parentId]);
      if (change === "ACL-revoke") mocks.channelOverridesState.overridesByChannel[parentId] = [{ role_id: "role", allow: 0, deny: 6144 }];

      await act(async () => { finish(); });
      expect(stillCurrent).toBe(false);
      expect(mocks.markRead).not.toHaveBeenCalled();
    },
  );

  it("routes a loaded thread notification to the thread and rejects an unresolved parent ACL target", async () => {
    mocks.channelNotificationsEnabled = true;
    mocks.channelTree = [{ channels: [{ id: "parent-1", type: "text" }] }];
    const parentKey = JSON.stringify(["server-1", "parent-1"]);
    mocks.threadState = {
      ownerId: "u1", authGeneration: 7,
      byID: { "thread-1": { id: "thread-1", type: "thread", name: "Thread", parent_channel_id: "parent-1" } },
      serverIdByThread: { "thread-1": "server-1" }, statusByParent: { [parentKey]: "ready" }, statusByThread: { "thread-1": "ready" },
    };
    mocks.channelOverridesState = { overridesByChannel: { "parent-1": [] }, statusByChannel: { "parent-1": { serverId: "server-1", ownerId: "u1", authGeneration: 7, status: "ready" } } };
    mocks.openAtMessage.mockResolvedValueOnce(true);
    const { result } = renderHook(() => useNotificationNavigation());
    const n = { ...eventNotice(), actor_id: "actor", channel_id: "thread-1", message_id: "source",
      payload: { action: "incoming_message", source: "channel" } };
    await act(async () => { result.current(n); await Promise.resolve(); });
    expect(mocks.openAtMessage).toHaveBeenCalledWith("server-1", "thread-1", "source", "", expect.any(Object));
    expect(mocks.markRead).toHaveBeenCalledWith(n.id);

    vi.clearAllMocks();
    mocks.threadState.statusByParent[parentKey] = "loading";
    await act(async () => { result.current(n); });
    expect(mocks.openAtMessage).not.toHaveBeenCalled();
    expect(mocks.markRead).not.toHaveBeenCalled();
  });

  it("requests the event modal with the notification's server and original account", () => {
    const { result } = renderHook(() => useNotificationNavigation());
    act(() => result.current(eventNotice()));

    expect(mocks.markRead).toHaveBeenCalledWith("notification-1");
    expect(mocks.openServer).toHaveBeenCalledWith("server-1");
    expect(mocks.openServerEvents).toHaveBeenCalledWith({
      serverId: "server-1", serverName: "Team", eventId: "event-1", expectedUserId: "u1", authGeneration: 7,
    });
    expect(mocks.openTab).not.toHaveBeenCalled();
  });

  it("does not route a notification retained from an earlier account", () => {
    mocks.userId = "u2";
    const { result } = renderHook(() => useNotificationNavigation());
    act(() => result.current(eventNotice("u1")));

    expect(mocks.openServerEvents).not.toHaveBeenCalled();
    expect(mocks.openTab).not.toHaveBeenCalled();
    expect(mocks.markRead).not.toHaveBeenCalled();
  });

  it("rejects stale feed ownership or auth generation before marking any kind read", () => {
    const { result } = renderHook(() => useNotificationNavigation());
    mocks.feedOwner = "u2";
    act(() => result.current(eventNotice()));
    mocks.feedOwner = "u1";
    mocks.feedGeneration = 6;
    act(() => result.current({ ...eventNotice(), kind: "friend_request" }));
    expect(mocks.markRead).not.toHaveBeenCalled();
    expect(mocks.openServerEvents).not.toHaveBeenCalled();
    expect(mocks.openTab).not.toHaveBeenCalled();
  });

  it("blocks actor notifications and rejects deleted or uncached server channels", () => {
    const { result } = renderHook(() => useNotificationNavigation());
    mocks.blockedUserIds = ["blocked-actor"];
    act(() => result.current({ ...eventNotice(), actor_id: "blocked-actor" }));
    expect(mocks.markRead).not.toHaveBeenCalled();

    act(() => result.current({ ...eventNotice(), kind: "mention", channel_id: "deleted", message_id: "msg" }));
    expect(mocks.markRead).not.toHaveBeenCalled();
    expect(mocks.openAtMessage).not.toHaveBeenCalled();

    mocks.channelTree = [{ channels: [{ id: "live" }] }];
    act(() => result.current({ ...eventNotice(), kind: "reply", channel_id: "live", message_id: "msg" }));
    expect(mocks.markRead).toHaveBeenCalledWith("notification-1");
    expect(mocks.openAtMessage).toHaveBeenCalledWith("server-1", "live", "msg", "");
  });

  it("allows only an existing accepted DM or pending request destination", () => {
    const { result } = renderHook(() => useNotificationNavigation());
    const request = { id: "dm-1", status: "pending", is_muted: false, other_user: { id: "actor" } };
    mocks.dmChannels = [request];
    act(() => result.current({ ...eventNotice(), kind: "dm_request", server_id: null, dm_channel_id: "dm-1" }));
    expect(mocks.markRead).toHaveBeenCalledWith("notification-1");
    expect(mocks.selectDM).toHaveBeenCalledWith("dm-1");

    vi.clearAllMocks();
    mocks.dmChannels = [{ ...request, status: "pending" }];
    act(() => result.current({ ...eventNotice(), kind: "mention", server_id: null, channel_id: null, dm_channel_id: "dm-1" }));
    expect(mocks.markRead).not.toHaveBeenCalled();
    expect(mocks.selectDM).not.toHaveBeenCalled();

    mocks.dmChannels = [{ ...request, status: "accepted" }];
    act(() => result.current({ ...eventNotice(), kind: "dm_request", server_id: null, dm_channel_id: "dm-1" }));
    expect(mocks.markRead).toHaveBeenCalledWith("notification-1");
  });

  it("requires current group membership before opening a group reaction", () => {
    const { result } = renderHook(() => useNotificationNavigation());
    const reaction = { ...eventNotice(), payload: { subtype: "reaction", group_id: "group-1" } };
    act(() => result.current(reaction));
    expect(mocks.markRead).not.toHaveBeenCalled();
    mocks.groups = [{ id: "group-1", name: "Group", members: [{ id: "u1" }] }];
    act(() => result.current(reaction));
    expect(mocks.markRead).toHaveBeenCalledWith("notification-1");
    expect(mocks.openTab).toHaveBeenCalledWith("group-1", "group-dm", "Group");
  });
});

it("opens and acknowledges exact group source only after fresh current membership and actual source load",async()=>{
 mocks.groups=[{id:"group",name:"Group",key_epoch:3,read_key_epoch:3,members:[{id:"u1"},{id:"actor"}]}];
 mocks.listGroups.mockResolvedValue({success:true,data:{group_dms:mocks.groups}});mocks.openAtGroupMessage.mockResolvedValue(true);
 const {result}=renderHook(()=>useNotificationNavigation());const n={...eventNotice(),server_id:null,actor_id:"actor",group_dm_channel_id:"group",message_id:"source",payload:{action:"incoming_message",source:"group"}};
 await act(async()=>{result.current(n);});expect(mocks.openAtGroupMessage).toHaveBeenCalledWith("group","source",expect.objectContaining({isCurrent:expect.any(Function)}));expect(mocks.markRead).toHaveBeenCalledWith(n.id);
});
it("rejects group membership loss during authoritative refresh without read or navigation",async()=>{
 mocks.groups=[{id:"group",name:"Group",key_epoch:3,read_key_epoch:3,members:[{id:"u1"},{id:"actor"}]}];let finish!:(v:unknown)=>void;mocks.listGroups.mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
 const {result}=renderHook(()=>useNotificationNavigation());const n={...eventNotice(),server_id:null,actor_id:"actor",group_dm_channel_id:"group",message_id:"source",payload:{action:"incoming_message",source:"group"}};
 act(()=>{result.current(n);});mocks.groups=[];await act(async()=>{finish({success:true,data:{group_dms:[]}});});expect(mocks.openAtGroupMessage).not.toHaveBeenCalled();expect(mocks.markRead).not.toHaveBeenCalled();
});
