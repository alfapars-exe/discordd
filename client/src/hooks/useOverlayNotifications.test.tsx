import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearTokens, getAuthGeneration, setTokens } from "../api/client";
import { useOverlayNotifications } from "./useOverlayNotifications";
import { useAuthStore } from "../stores/authStore";
import { useNotificationStore } from "../stores/notificationStore";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useServerStore } from "../stores/serverStore";
import { useChannelStore } from "../stores/channelStore";
import { useDMStore } from "../stores/dmStore";
import { useGroupDMStore } from "../stores/groupDMStore";
import { useThreadStore } from "../stores/threadStore";
import { useBlockStore } from "../stores/blockStore";
import type { AppNotification } from "../types/notification";
import { getLiveOverlayNotificationItems } from "../utils/overlayNotificationAccess";

const owner = "overlay-owner";

function notification(overrides: Partial<AppNotification> = {}): AppNotification {
  return {
    id: "notice-1", user_id: owner, kind: "mention", actor_id: "actor-1", actor: null,
    server_id: null, channel_id: null, message_id: null, dm_channel_id: null,
    payload: {}, read_at: null, created_at: "2026-10-25T00:00:00Z", ...overrides,
  };
}

function makeReadyFeed(items: AppNotification[] = [notification()]) {
  useNotificationStore.setState({
    items, ownerId: owner, authGeneration: getAuthGeneration(), hasLoaded: true,
    fetchError: false, unreadCount: items.length, hasMore: false, isLoading: false,
  });
}

beforeEach(() => {
  clearTokens();
  setTokens("overlay-test-token", "", owner);
  useAuthStore.setState({ user: { id: owner } as never, manualStatus: "online" });
  usePreferencesStore.setState({ accountId: owner, isLoaded: true, data: {} });
  useNotificationStore.setState({
    items: [], ownerId: owner, authGeneration: getAuthGeneration(), hasLoaded: false,
    fetchError: false, unreadCount: 0, hasMore: false, isLoading: false,
  });
  useServerStore.setState({ servers: [], mutedServerIds: new Set() });
  useChannelStore.setState({ categoriesByServer: {}, mutedChannelIds: new Set() });
  useDMStore.setState({ channels: [] });
  useGroupDMStore.setState({ groups: [] });
  useBlockStore.setState({ blockedUserIds: [] });
  vi.spyOn(useNotificationStore.getState(), "fetchInitial").mockResolvedValue(undefined);
});

describe("useOverlayNotifications", () => {
  it("revalidates current opt-outs and read state immediately, without relying on a rendered snapshot", () => {
    makeReadyFeed([notification({ kind: "system", payload: { event_id: "event" } })]);
    expect(getLiveOverlayNotificationItems()).toHaveLength(1);
    usePreferencesStore.setState({ data: { notifications: { upcomingEventNotifications: false } } });
    expect(getLiveOverlayNotificationItems()).toEqual([]);
    usePreferencesStore.setState({ data: {} });
    useBlockStore.setState({ blockedUserIds: ["actor-1"] });
    expect(getLiveOverlayNotificationItems()).toEqual([]);
    useBlockStore.setState({ blockedUserIds: [] });
    useNotificationStore.setState({ items: [notification({ read_at: "2026-10-25T01:00:00Z" })] });
    expect(getLiveOverlayNotificationItems()).toEqual([]);
  });
  it("fetches the existing feed only when overlay, connection, auth, and preferences are ready", async () => {
    const fetchInitial = useNotificationStore.getState().fetchInitial as ReturnType<typeof vi.fn>;
    const { rerender } = renderHook(({ enabled, connected }) => useOverlayNotifications(enabled, connected), {
      initialProps: { enabled: true, connected: false },
    });
    expect(fetchInitial).not.toHaveBeenCalled();

    rerender({ enabled: true, connected: true });
    expect(fetchInitial).toHaveBeenCalledTimes(1);

    rerender({ enabled: false, connected: true });
    expect(fetchInitial).toHaveBeenCalledTimes(1);
  });

  it("never projects private rows while disconnected or when the owner/session fence mismatches", () => {
    makeReadyFeed([notification()]);
    const disconnected = renderHook(() => useOverlayNotifications(true, false));
    expect(disconnected.result.current).toEqual({ notifications: [], notificationStatus: "unavailable" });
    disconnected.unmount();

    const ownerMismatch = renderHook(() => useOverlayNotifications(true, true));
    act(() => useNotificationStore.setState({ ownerId: "different-account" }));
    expect(ownerMismatch.result.current.notifications).toEqual([]);
    expect(ownerMismatch.result.current.notificationStatus).toBe("unavailable");
    ownerMismatch.unmount();

    act(() => useNotificationStore.setState({ ownerId: owner, authGeneration: getAuthGeneration() - 1 }));
    const generationMismatch = renderHook(() => useOverlayNotifications(true, true));
    expect(generationMismatch.result.current.notifications).toEqual([]);
    expect(generationMismatch.result.current.notificationStatus).toBe("unavailable");
  });

  it("suppresses muted-server, blocked-actor, deleted-channel, and inaccessible-group rows", () => {
    const validServer = { id: "server-1" } as never;
    useServerStore.setState({ servers: [validServer], mutedServerIds: new Set(["muted-server"]) });
    useChannelStore.setState({ categoriesByServer: {
      "server-1": [{ category: { id: "cat-1", name: "General", position: 0 }, channels: [{ id: "live-channel" } as never] }],
      "muted-server": [{ category: { id: "cat-2", name: "Muted", position: 0 }, channels: [{ id: "muted-channel" } as never] }],
    } });
    useBlockStore.setState({ blockedUserIds: ["blocked-actor"] });

    const rows = [
      notification({ id: "visible", server_id: "server-1", channel_id: "live-channel" }),
      notification({ id: "muted", server_id: "muted-server", channel_id: "muted-channel" }),
      notification({ id: "blocked", actor_id: "blocked-actor" }),
      notification({ id: "deleted-channel", server_id: "server-1", channel_id: "gone-channel" }),
      notification({ id: "inaccessible-group", payload: { group_id: "not-a-member" } }),
    ];
    makeReadyFeed(rows);

    const { result } = renderHook(() => useOverlayNotifications(true, true));
    expect(result.current.notifications).toEqual([{ id: "visible", category: "mention" }]);
    expect(result.current.notificationStatus).toBe("ready");
  });

  it("reports loading or unavailable until the current feed has a successful initial fetch", () => {
    makeReadyFeed([notification()]);
    act(() => useNotificationStore.setState({ hasLoaded: false, fetchError: false }));
    const { result, rerender } = renderHook(() => useOverlayNotifications(true, true));
    expect(result.current.notifications).toEqual([]);
    expect(result.current.notificationStatus).toBe("loading");

    act(() => useNotificationStore.setState({ hasLoaded: false, fetchError: true }));
    rerender();
    expect(result.current.notifications).toEqual([]);
    expect(result.current.notificationStatus).toBe("unavailable");
  });
});


it("uses current thread ownership, parent mute and ignored actors for both published and action-time rows", () => {
  useServerStore.setState({ servers: [{ id: "server" }] as never });
  useChannelStore.setState({ categoriesByServer: { server: [{ id: "category", channels: [{ id: "parent", type: "text", name: "Parent" }] }] } as never });
  useThreadStore.setState({ ownerId: owner, authGeneration: getAuthGeneration(), byID: { thread: { id: "thread", type: "thread", parent_channel_id: "parent" } } as never,
    serverIdByThread: { thread: "server" }, statusByParent: { '["server","parent"]': "ready" }, statusByThread: { thread: "ready" } });
  makeReadyFeed([notification({ server_id: "server", channel_id: "thread", message_id: "message" })]);
  const view = renderHook(() => useOverlayNotifications(true, true));
  expect(view.result.current.notifications).toHaveLength(1); expect(getLiveOverlayNotificationItems()).toHaveLength(1);
  act(() => useChannelStore.setState({ mutedChannelIds: new Set(["parent"]) }));
  expect(view.result.current.notifications).toEqual([]); expect(getLiveOverlayNotificationItems()).toEqual([]);
  act(() => useChannelStore.setState({ mutedChannelIds: new Set() }));
  act(() => usePreferencesStore.setState({ data: { privacy: { ignoredUsers: { "actor-1": true } } } }));
  expect(view.result.current.notifications).toEqual([]); expect(getLiveOverlayNotificationItems()).toEqual([]);
  act(() => usePreferencesStore.setState({ data: {} }));
  act(() => useThreadStore.setState({ authGeneration: getAuthGeneration() - 1 }));
  expect(view.result.current.notifications).toEqual([]); expect(getLiveOverlayNotificationItems()).toEqual([]);
});
