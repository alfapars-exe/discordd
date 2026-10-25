import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userId: "u1" as string | null,
  generation: 7,
  feedOwner: "u1" as string | null,
  feedGeneration: 7,
  blockedUserIds: [] as string[],
  channelTree: [] as { channels: { id: string }[] }[],
  dmChannels: [] as { id: string; status: string; is_muted: boolean; other_user: { id: string } }[],
  groups: [] as { id: string; name: string; members: { id: string }[] }[],
  markRead: vi.fn(),
  openServerEvents: vi.fn(),
  openServer: vi.fn(),
  openTab: vi.fn(),
  openAtMessage: vi.fn(),
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
  }), { getState: () => ({ servers: [{ id: "server-1", name: "Team", icon_url: null }], activeServerId: "server-1" }) }),
}));
vi.mock("../stores/channelStore", () => ({
  useChannelStore: Object.assign((pick: (state: unknown) => unknown) => pick({ selectChannel: mocks.selectChannel, categoriesByServer: { "server-1": mocks.channelTree } }), {
    getState: () => ({ selectChannel: mocks.selectChannel, categoriesByServer: { "server-1": mocks.channelTree } }),
  }),
}));
vi.mock("../stores/authStore", () => ({
  useAuthStore: Object.assign((pick: (state: unknown) => unknown) => pick({ user: { id: mocks.userId } }), {
    getState: () => ({ user: mocks.userId ? { id: mocks.userId } : null }),
  }),
}));
vi.mock("../stores/dmStore", () => ({
  useDMStore: Object.assign((pick: (state: unknown) => unknown) => pick({
    selectDM: mocks.selectDM, fetchMessages: mocks.fetchDMMessages, clearDMUnread: mocks.clearDMUnread,
    channels: mocks.dmChannels,
  }), { getState: () => ({ selectDM: mocks.selectDM, fetchMessages: mocks.fetchDMMessages, clearDMUnread: mocks.clearDMUnread, channels: mocks.dmChannels }) }),
}));
vi.mock("../stores/groupDMStore", () => ({ useGroupDMStore: { getState: () => ({ groups: mocks.groups, fetchMessages: vi.fn() }) } }));
vi.mock("../stores/blockStore", () => ({ useBlockStore: { getState: () => ({ blockedUserIds: mocks.blockedUserIds }) } }));
vi.mock("../stores/mobileStore", () => ({
  useMobileStore: (pick: (state: unknown) => unknown) => pick({ closeAllDrawers: mocks.closeAllDrawers }),
}));
vi.mock("./useOpenAtMessage", () => ({ useOpenAtMessage: () => ({ openAtMessage: mocks.openAtMessage }) }));

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
    mocks.channelTree = [];
    mocks.dmChannels = [];
    mocks.groups = [];
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
