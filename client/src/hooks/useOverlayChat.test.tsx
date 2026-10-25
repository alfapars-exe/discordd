import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const permissions = vi.hoisted(() => ({ resolved: true, allowed: true }));
vi.mock("./useChannelPermissions", () => ({ useChannelPermissions: () => ({ authorizationResolved: permissions.resolved, hasChannelPerm: () => permissions.allowed }) }));
import { useOverlayChat } from "./useOverlayChat";
import { setTokens, getAuthGeneration } from "../api/client";
import { useAuthStore } from "../stores/authStore";
import { useUIStore } from "../stores/uiStore";
import { useServerStore } from "../stores/serverStore";
import { useChannelStore } from "../stores/channelStore";
import { useMessageStore } from "../stores/messageStore";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useBlockStore } from "../stores/blockStore";
import { useE2EEStore } from "../stores/e2eeStore";
import { useSpamDecisionStore } from "../stores/spamDecisionStore";
import { useThreadStore } from "../stores/threadStore";
import { useDMStore } from "../stores/dmStore";
import { useGroupDMStore } from "../stores/groupDMStore";
import type { Message } from "../types";

beforeEach(() => {
  permissions.resolved = true; permissions.allowed = true;
  setTokens("test-token", "", "viewer");
  useAuthStore.setState({ user: { id: "viewer" } as never });
  useUIStore.setState({ destination: { type: "text", channelId: "channel", label: "Channel", serverInfo: { serverId: "server", serverName: "Server", serverIconUrl: null } } });
  useServerStore.setState({ servers: [{ id: "server" }] as never });
  useChannelStore.setState({ categoriesByServer: { server: [{ channels: [{ id: "channel", type: "text" }] }] as never } });
  usePreferencesStore.setState({ accountId: "viewer", isLoaded: true, data: { privacy: { spamFilter: "off" } } });
  useMessageStore.setState({ ownerId: "viewer", authGeneration: getAuthGeneration(), messagesByChannel: { channel: [{ id: "message", channel_id: "channel", user_id: "author", content: "Hello", author: { id: "author", username: "Author" } } as Message] }, isLoadingByChannel: {}, hasMoreAfterByChannel: {} });
  useBlockStore.setState({ ownerId: "viewer", authGeneration: getAuthGeneration(), snapshotReady: true, isLoading: false, blockedUserIds: [] });
  useE2EEStore.setState({ decryptionErrors: [] });
  useDMStore.setState({ ownerId: "viewer", authGeneration: getAuthGeneration(), channels: [], messagesByChannel: {}, hasMoreAfterByChannel: {}, isLoading: false });
  useGroupDMStore.setState({ ownerId: "viewer", authGeneration: getAuthGeneration(), groups: [], messages: {}, hasMoreAfterByGroup: {}, groupsReady: false });
  useSpamDecisionStore.setState({ accountId: "viewer", decisions: {} });
  vi.spyOn(useBlockStore.getState(), "fetchBlocked").mockResolvedValue(undefined);
});

it("projects only current loaded text and clears immediately on permission revocation", () => {
  const view = renderHook(() => useOverlayChat(true, true));
  expect(view.result.current).toEqual({ chatStatus: "ready", chatMessages: [{ id: "message", author: "Author", text: "Hello" }] });
  permissions.allowed = false;
  view.rerender();
  expect(view.result.current.chatMessages).toEqual([]);
});

it("tracks block, ignore and decryption error policy changes", () => {
  const view = renderHook(() => useOverlayChat(true, true));
  act(() => useBlockStore.setState({ blockedUserIds: ["author"] }));
  expect(view.result.current.chatMessages).toEqual([]);
  act(() => useBlockStore.setState({ blockedUserIds: [] }));
  expect(view.result.current.chatMessages).toHaveLength(1);
  act(() => usePreferencesStore.setState({ data: { privacy: { ignoredUsers: { author: true } } } }));
  expect(view.result.current.chatMessages).toEqual([]);
  act(() => usePreferencesStore.setState({ data: { privacy: { spamFilter: "off" } } }));
  act(() => useE2EEStore.setState({ decryptionErrors: [{ messageId: "message", channelId: "channel", timestamp: 0, error: "missing key" }] }));
  expect(view.result.current.chatMessages).toEqual([]);
});

it("does not expose detached history, stale account data or unknown block state", () => {
  const view = renderHook(() => useOverlayChat(true, true));
  act(() => useMessageStore.setState({ hasMoreAfterByChannel: { channel: true } }));
  expect(view.result.current.chatStatus).toBe("unavailable");
  act(() => useMessageStore.setState({ hasMoreAfterByChannel: {}, ownerId: "other" }));
  expect(view.result.current.chatMessages).toEqual([]);
  act(() => useMessageStore.setState({ ownerId: "viewer" }));
  act(() => useBlockStore.setState({ snapshotReady: false }));
  expect(view.result.current.chatMessages).toEqual([]);
});

it("clears on disconnect, disable, destination change and same-user reauthentication", () => {
  const view = renderHook(({ enabled, connected }) => useOverlayChat(enabled, connected), { initialProps: { enabled: true, connected: true } });
  view.rerender({ enabled: true, connected: false });
  expect(view.result.current.chatMessages).toEqual([]);
  view.rerender({ enabled: false, connected: true });
  expect(view.result.current.chatMessages).toEqual([]);
  view.rerender({ enabled: true, connected: true });
  act(() => useUIStore.setState({ destination: { type: "friends", channelId: "friends", label: "" } }));
  expect(view.result.current.chatMessages).toEqual([]);
  act(() => setTokens("new-token", "", "viewer"));
  expect(view.result.current.chatMessages).toEqual([]);
});

it("tracks current-revision spam restoration without revealing ignored content", () => {
  const original = useMessageStore.getState().messagesByChannel.channel![0]!;
  useMessageStore.setState({ messagesByChannel: { channel: [{ ...original, content: "https://example.com ".repeat(6) }] } });
  usePreferencesStore.setState({ data: { privacy: { spamFilter: "all" } } });
  const view = renderHook(() => useOverlayChat(true, true));
  expect(view.result.current.chatMessages).toEqual([]);
  act(() => useSpamDecisionStore.setState({ decisions: { "channel:message": { user_id: "viewer", source_kind: "channel", message_id: "message", revision: "original", status: "restored" } } }));
  expect(view.result.current.chatMessages).toHaveLength(1);
  act(() => usePreferencesStore.setState({ data: { privacy: { spamFilter: "all", ignoredUsers: { author: true } } } }));
  expect(view.result.current.chatMessages).toEqual([]);
});

it("projects an owned thread and clears when its parent metadata becomes unavailable", () => {
  const message = useMessageStore.getState().messagesByChannel.channel![0]!;
  useThreadStore.setState({ ownerId: "viewer", authGeneration: getAuthGeneration(),
    byID: { thread: { id: "thread", name: "Topic", type: "thread", parent_channel_id: "channel" } as never },
    serverIdByThread: { thread: "server" }, statusByParent: {} });
  useUIStore.setState({ destination: { ...useUIStore.getState().destination, channelId: "thread", type: "text" } });
  useMessageStore.setState({ messagesByChannel: { thread: [{ ...message, channel_id: "thread" }] } });
  const view = renderHook(() => useOverlayChat(true, true));
  expect(view.result.current.chatMessages).toHaveLength(1);
  act(() => useThreadStore.setState({ statusByParent: { [JSON.stringify(["server", "channel"])]: "error" } }));
  expect(view.result.current.chatMessages).toEqual([]);
});

it("projects only accepted loaded DM plaintext with DM spam and privacy policy", () => {
  const generation = getAuthGeneration();
  useUIStore.setState({ destination: { type: "dm", channelId: "dm-1", label: "DM" } });
  useDMStore.setState({
    ownerId: "viewer", authGeneration: generation,
    channels: [{ id: "dm-1", status: "accepted", e2ee_enabled: false, other_user: { id: "peer" } } as never],
    messagesByChannel: { "dm-1": [
      { id: "dm-msg", dm_channel_id: "dm-1", user_id: "peer", content: "private text", edited_at: null, author: { id: "peer", username: "Peer" }, encryption_version: 0 },
    ] as never }, hasMoreAfterByChannel: {},
  });
  const view = renderHook(() => useOverlayChat(true, true));
  expect(view.result.current).toEqual({ chatStatus: "ready", chatMessages: [{ id: "dm-msg", author: "Peer", text: "private text" }] });
  act(() => usePreferencesStore.setState({ data: { privacy: { ignoredUsers: { peer: true } } } }));
  expect(view.result.current.chatMessages).toEqual([]);
  act(() => usePreferencesStore.setState({ data: { privacy: { spamFilter: "off" } } }));
  act(() => useDMStore.setState({ channels: [{ id: "dm-1", status: "pending", e2ee_enabled: false, other_user: { id: "peer" } } as never] }));
  expect(view.result.current.chatStatus).toBe("unavailable");
});

it("projects group DM only for a current member with decrypted group-source rows", () => {
  const generation = getAuthGeneration();
  useUIStore.setState({ destination: { type: "group-dm", channelId: "group-1", label: "Group" } });
  useE2EEStore.setState({ initStatus: "ready", decryptionErrors: [] });
  useGroupDMStore.setState({
    ownerId: "viewer", authGeneration: generation, groupsReady: true,
    groups: [{ id: "group-1", members: [{ id: "viewer" }, { id: "peer" }] } as never],
    messages: { "group-1": [
      { id: "group-msg", group_id: "group-1", user_id: "peer", content: "decrypted group text", user: { id: "peer", username: "Peer" }, encryption_version: 1, ciphertext: "secret" },
      { id: "group-undecrypted", group_id: "group-1", user_id: "peer", content: null, decryption_error: "version_unavailable", user: { id: "peer", username: "Peer" }, encryption_version: 1, ciphertext: "secret" },
    ] as never }, hasMoreAfterByGroup: {},
  });
  const view = renderHook(() => useOverlayChat(true, true));
  expect(view.result.current).toEqual({ chatStatus: "ready", chatMessages: [{ id: "group-msg", author: "Peer", text: "decrypted group text" }] });
  act(() => useGroupDMStore.setState({ groups: [{ id: "group-1", members: [{ id: "peer" }] } as never] }));
  expect(view.result.current.chatStatus).toBe("unavailable");
});

it("recomputes on private destination changes and E2EE readiness transitions", () => {
  const generation = getAuthGeneration();
  useUIStore.setState({ destination: { type: "dm", channelId: "dm-1", label: "DM 1" } });
  const channel = (id: string) => ({ id, status: "accepted", e2ee_enabled: true, other_user: { id: `peer-${id}`, username: `Peer ${id}` } });
  const message = (id: string) => ({ id: `message-${id}`, dm_channel_id: id, user_id: `peer-${id}`, content: `text ${id}`, edited_at: null, author: { id: `peer-${id}`, username: `Peer ${id}` }, encryption_version: 1 });
  useDMStore.setState({ ownerId: "viewer", authGeneration: generation, channels: [channel("dm-1"), channel("dm-2")] as never,
    messagesByChannel: { "dm-1": [message("dm-1")] as never, "dm-2": [message("dm-2")] as never } });
  useE2EEStore.setState({ initStatus: "initializing" });
  const view = renderHook(() => useOverlayChat(true, true));
  expect(view.result.current.chatStatus).toBe("unavailable");
  act(() => useE2EEStore.setState({ initStatus: "ready" }));
  expect(view.result.current.chatMessages.map((row) => row.text)).toEqual(["text dm-1"]);
  act(() => useUIStore.setState({ destination: { type: "dm", channelId: "dm-2", label: "DM 2" } }));
  expect(view.result.current.chatMessages.map((row) => row.text)).toEqual(["text dm-2"]);
});
