import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/notifications", () => ({
  listNotifications: vi.fn(),
  getNotificationCount: vi.fn(),
  markNotificationRead: vi.fn(),
  markAllNotificationsRead: vi.fn(),
}));

import * as notificationsApi from "../api/notifications";
import { clearTokens, getAuthGeneration, setTokens } from "../api/client";
import { useAuthStore } from "../stores/authStore";
import { useDMStore } from "../stores/dmStore";
import { useGroupDMStore } from "../stores/groupDMStore";
import { useNotificationStore } from "../stores/notificationStore";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useReadStateStore } from "../stores/readStateStore";
import { useServerStore } from "../stores/serverStore";
import type { AppNotification, DMChannelWithUser, User } from "../types";
import { useNotificationBadge } from "./useNotificationBadge";

const owner = "badge-owner";
const setBadgeCount = vi.fn();

function user(id: string): User {
  return {
    id, username: id, display_name: null, avatar_url: null, status: "offline",
    custom_status: null, created_at: "2026-10-25T00:00:00Z", email: null,
    language: "tr", dm_privacy: "everyone", is_platform_admin: false,
    has_seen_download_prompt: true, has_seen_welcome: true,
  };
}

function dm(id: string, muted = false): DMChannelWithUser {
  return {
    id, other_user: user(`peer-${id}`), e2ee_enabled: true, status: "accepted",
    initiated_by: null, created_at: "2026-10-25T00:00:00Z", last_message_at: null,
    is_pinned: false, is_muted: muted, unread_count: 0, last_message: null,
  };
}

function notice(id: string, overrides: Partial<AppNotification> = {}): AppNotification {
  return {
    id, user_id: owner, kind: "mention", actor_id: "peer", actor: null,
    server_id: "server", channel_id: "channel", message_id: `message-${id}`,
    dm_channel_id: null, payload: {}, read_at: null, created_at: "2026-10-25T00:00:00Z",
    ...overrides,
  };
}

function dmNotice(id: string, channelId: string): AppNotification {
  return notice(id, {
    kind: "system", server_id: null, channel_id: null, dm_channel_id: channelId,
    payload: { action: "incoming_message", source: "dm" },
  });
}

function expectBadge(total: number, label: string): void {
  expect(setBadgeCount).toHaveBeenLastCalledWith(total, total === 0 ? null : "");
  expect(document.title).toBe(label);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(notificationsApi.listNotifications).mockResolvedValue({
    success: true, data: { notifications: [], has_more: false },
  });
  vi.mocked(notificationsApi.getNotificationCount).mockResolvedValue({
    success: true, data: { unread_count: 0, badge_unread_count: 0 },
  });
  clearTokens();
  useAuthStore.setState({ user: null });
  setTokens("badge-test-access", "", owner);
  useAuthStore.setState({ user: user(owner) });
  useNotificationStore.setState({
    items: [], unreadCount: 0, badgeUnreadCount: 0, hasMore: false, hasLoaded: false,
    isLoading: false, fetchError: false, unreadOnly: false,
    ownerId: owner, authGeneration: getAuthGeneration(),
  });
  useDMStore.setState({ channels: [], dmUnreadCounts: {} });
  useGroupDMStore.setState({ownerId:owner,authGeneration:getAuthGeneration(),groups:[],groupsReady:true});
  useReadStateStore.setState({ unreadCounts: {}, unreadRevisions: {}, channelServerMap: {}, seenMentions: {} });
  useServerStore.setState({ activeServerId: "server", mutedServerIds: new Set() });
  usePreferencesStore.setState({ accountId: owner, isLoaded: true, data: {} });
  vi.stubGlobal("electronAPI", { setBadgeCount });
  // Count aggregation is observed at the actual IPC boundary; rendering pixels
  // belongs to the separate badge formatting/visual contract.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  clearTokens();
  useAuthStore.setState({ user: null });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("includes authoritative cold group unread only once, excluding private muted and stale-owner groups",()=>{
  const group={id:"group",owner_id:owner,name:"Group",key_epoch:1,call_room_key:"room",icon_url:null,created_at:"2026-01-01T00:00:00Z",updated_at:"2026-01-01T00:00:00Z",members:[user(owner)],unread_count:3,read_revision:4,is_muted:false,settings_revision:0};
  useGroupDMStore.setState({groups:[group,{...group,id:"muted",unread_count:20,is_muted:true}]});renderHook(()=>useNotificationBadge());expectBadge(3,"(3+) HiChat!");
  act(()=>useGroupDMStore.getState().handleReadState({group_id:"group",last_read_message_id:null,unread_count:3,revision:4,is_muted:true,settings_revision:1}));expectBadge(0,"HiChat!");
  act(()=>useGroupDMStore.getState().handleReadState({group_id:"group",last_read_message_id:null,unread_count:2,revision:5,is_muted:false,settings_revision:2}));expectBadge(2,"(2+) HiChat!");
  act(()=>useGroupDMStore.setState({authGeneration:getAuthGeneration()-1}));expectBadge(0,"HiChat!");
});

describe("useNotificationBadge aggregate integration", () => {
  it("combines channels, unmuted DMs and non-message feed items without double-counting ordinary DM feed", () => {
    useReadStateStore.setState({ unreadCounts: { channel: 2 } });
    useDMStore.setState({ channels: [dm("direct"), dm("muted", true)], dmUnreadCounts: { direct: 3, muted: 5 } });
    useNotificationStore.getState().handleCreate(dmNotice("ordinary-dm", "direct"));
    useNotificationStore.getState().handleCreate(notice("mention"));

    renderHook(() => useNotificationBadge());

    expect(useNotificationStore.getState().unreadCount).toBe(2);
    expect(useNotificationStore.getState().badgeUnreadCount).toBe(1);
    expectBadge(6, "(6+) HiChat!");

    act(() => useDMStore.setState({ channels: [dm("direct"), dm("muted")] }));
    expectBadge(11, "(9+) HiChat!");
    act(() => useDMStore.setState({ channels: [dm("direct"), dm("muted", true)] }));
    expectBadge(6, "(6+) HiChat!");
  });

  it("keeps a persisted muted DM feed item unread while excluding it from the app badge", async () => {
    const persisted = dmNotice("persisted-muted-message", "muted");
    useDMStore.setState({ channels: [dm("muted", true)], dmUnreadCounts: { muted: 4 } });
    vi.mocked(notificationsApi.listNotifications).mockResolvedValue({
      success: true, data: { notifications: [persisted], has_more: false },
    });
    vi.mocked(notificationsApi.getNotificationCount).mockResolvedValue({
      success: true, data: { unread_count: 1, badge_unread_count: 0 },
    });
    renderHook(() => useNotificationBadge());

    await act(async () => {
      await useNotificationStore.getState().fetchInitial();
      await useNotificationStore.getState().fetchCount();
    });

    expect(useNotificationStore.getState().items).toEqual([persisted]);
    expect(useNotificationStore.getState().unreadCount).toBe(1);
    expect(useNotificationStore.getState().items[0].read_at).toBeNull();
    expectBadge(0, "HiChat!");
  });

  it("uses the authoritative badge count before loading and after a partial feed page", async () => {
    useReadStateStore.setState({ unreadCounts: { channel: 1 } });
    useDMStore.setState({ channels: [dm("direct")], dmUnreadCounts: { direct: 2 } });
    vi.mocked(notificationsApi.getNotificationCount).mockResolvedValue({
      success: true, data: { unread_count: 87, badge_unread_count: 4 },
    });
    vi.mocked(notificationsApi.listNotifications).mockResolvedValue({
      success: true, data: { notifications: [dmNotice("partial-page-message", "direct")], has_more: true },
    });
    renderHook(() => useNotificationBadge());

    await act(async () => { await useNotificationStore.getState().fetchCount(); });
    expect(useNotificationStore.getState().items).toEqual([]);
    expectBadge(7, "(7+) HiChat!");

    await act(async () => { await useNotificationStore.getState().fetchInitial(); });
    expect(useNotificationStore.getState().items).toHaveLength(1);
    expect(useNotificationStore.getState().hasMore).toBe(true);
    expect(useNotificationStore.getState().unreadCount).toBe(87);
    expectBadge(7, "(7+) HiChat!");

    vi.mocked(notificationsApi.getNotificationCount).mockResolvedValue({
      success: true, data: { unread_count: 86, badge_unread_count: 3 },
    });
    await act(async () => { await useNotificationStore.getState().fetchCount(); });
    expectBadge(6, "(6+) HiChat!");
  });

  it("clears real DM and feed contributions across an authenticated owner transition", () => {
    useDMStore.setState({ channels: [dm("direct")], dmUnreadCounts: { direct: 2 } });
    for (const id of ["mention-a", "mention-b", "mention-c"]) useNotificationStore.getState().handleCreate(notice(id));
    renderHook(() => useNotificationBadge());
    expectBadge(5, "(5+) HiChat!");

    act(() => {
      setTokens("next-owner-access", "", "next-owner");
      useAuthStore.setState({ user: user("next-owner") });
    });

    expect(useDMStore.getState().dmUnreadCounts).toEqual({});
    expect(useNotificationStore.getState().items).toEqual([]);
    expect(useNotificationStore.getState().badgeUnreadCount).toBe(0);
    expectBadge(0, "HiChat!");

    act(() => useNotificationStore.getState().handleCreate(notice("late-previous-owner")));
    expectBadge(0, "HiChat!");
    act(() => useNotificationStore.getState().handleCreate(notice("new-owner", { user_id: "next-owner" })));
    expectBadge(1, "(1+) HiChat!");
  });
});
