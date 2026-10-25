import { beforeEach, expect, it } from "vitest";
import { setTokens, getAuthGeneration } from "../api/client";
import { useAuthStore } from "../stores/authStore";
import { useUIStore } from "../stores/uiStore";
import { useServerStore } from "../stores/serverStore";
import { useChannelStore } from "../stores/channelStore";
import { useMemberStore } from "../stores/memberStore";
import { useChannelPermissionStore } from "../stores/channelPermissionStore";
import { useMessageStore } from "../stores/messageStore";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useBlockStore } from "../stores/blockStore";
import { useDMStore } from "../stores/dmStore";
import { useGroupDMStore } from "../stores/groupDMStore";
import { useE2EEStore } from "../stores/e2eeStore";
import { useThreadStore } from "../stores/threadStore";
import { Permissions } from "./permissions";
import { formatOverlayChatComposeLabel, getLiveOverlayChatTarget, getLiveOverlayPrivateChatTarget } from "./overlayChatAccess";

beforeEach(() => {
  setTokens("test", "", "viewer");
  useAuthStore.setState({ user: { id: "viewer" } as never });
  const generation = getAuthGeneration();
  useUIStore.setState({ destination: { type: "text", channelId: "channel", label: "untrusted old label", serverInfo: { serverId: "server", serverName: "old", serverIconUrl: null } } });
  useServerStore.setState({ servers: [{ id: "server", name: "Current server", icon_url: null }] });
  useChannelStore.setState({ categoriesByServer: { server: [{ channels: [{ id: "channel", name: "Current channel", type: "text" }] }] as never } });
  useMemberStore.setState({ ownerId: "viewer", authGeneration: generation, statusByServer: { server: "ready" }, loadingServers: new Set(), membersByServer: { server: [{ id: "viewer", roles: [{ id: "role" }], effective_permissions: Permissions.ViewChannel | Permissions.ReadMessages }] as never } });
  useChannelPermissionStore.setState({ overridesByChannel: { channel: [] }, statusByChannel: { channel: { serverId: "server", ownerId: "viewer", authGeneration: generation, status: "ready" } } });
  usePreferencesStore.setState({ accountId: "viewer", isLoaded: true });
  useBlockStore.setState({ ownerId: "viewer", authGeneration: generation, snapshotReady: true, isLoading: false });
  useMessageStore.setState({ ownerId: "viewer", authGeneration: generation, messagesByChannel: { channel: [] }, isLoadingByChannel: {}, hasMoreAfterByChannel: {} });
  useDMStore.setState({ ownerId: "viewer", authGeneration: generation, channels: [], messagesByChannel: {}, hasMoreAfterByChannel: {}, isLoading: false });
  useGroupDMStore.setState({ ownerId: "viewer", authGeneration: generation, groups: [], messages: {}, hasMoreAfterByGroup: {}, groupsReady: false });
  useE2EEStore.setState({ initStatus: "ready" });
});

it("uses current verified store labels rather than native or stale route metadata", () => {
  expect(getLiveOverlayChatTarget()).toEqual({ type: "text", channelId: "channel", label: "Current channel", serverInfo: { serverId: "server", serverName: "Current server", serverIconUrl: null } });
});

it("requires the separate live send permission for composition", () => {
  expect(getLiveOverlayChatTarget(true)).toBeNull();
  useMemberStore.setState({ membersByServer: { server: [{ id: "viewer", roles: [], effective_permissions: Permissions.ViewChannel | Permissions.ReadMessages | Permissions.SendMessages }] as never } });
  expect(getLiveOverlayChatTarget(true)?.channelId).toBe("channel");
});

it("bounds compose labels without control characters or split surrogate pairs", () => {
  expect(formatOverlayChatComposeLabel("A\nB\u202eC")).toBe("A B C");
  expect(formatOverlayChatComposeLabel("😀".repeat(100))).toBe("😀".repeat(64));
  expect(formatOverlayChatComposeLabel(undefined)).toBe("HiChat");
});

it("uses parent permissions for a thread and preserves archived read-only access", () => {
  useThreadStore.setState({ ownerId: "viewer", authGeneration: getAuthGeneration(),
    byID: { thread: { id: "thread", name: "Topic", type: "thread", parent_channel_id: "channel", archived_at: null } as never },
    serverIdByThread: { thread: "server" }, statusByParent: {} });
  useUIStore.setState({ destination: { ...useUIStore.getState().destination, channelId: "thread", type: "text" } });
  useMessageStore.setState({ messagesByChannel: { thread: [] } });
  useMemberStore.setState({ membersByServer: { server: [{ id: "viewer", roles: [{ id: "role" }], effective_permissions: Permissions.ViewChannel | Permissions.ReadMessages | Permissions.SendMessages }] as never } });
  expect(getLiveOverlayChatTarget(true)?.channelId).toBe("thread");
  const thread = useThreadStore.getState().byID.thread!;
  useThreadStore.setState({ byID: { thread: { ...thread, archived_at: "2026-10-25T00:00:00Z" } } });
  expect(getLiveOverlayChatTarget()?.channelId).toBe("thread");
  expect(getLiveOverlayChatTarget(true)).toBeNull();
  useChannelPermissionStore.setState({ overridesByChannel: { channel: [{ role_id: "role", allow: 0, deny: Permissions.ReadMessages }] as never } });
  expect(getLiveOverlayChatTarget()).toBeNull();
});

it("rejects live role denial and stale or failed permission provenance", () => {
  useChannelPermissionStore.setState({ overridesByChannel: { channel: [{ role_id: "role", allow: 0, deny: Permissions.ReadMessages }] as never } });
  expect(getLiveOverlayChatTarget()).toBeNull();
  useChannelPermissionStore.setState({ overridesByChannel: { channel: [] }, statusByChannel: {} });
  expect(getLiveOverlayChatTarget()).toBeNull();
});

it("does not reinterpret missing override data as an authorized empty override list", () => {
  useChannelPermissionStore.setState({ overridesByChannel: {} });
  expect(getLiveOverlayChatTarget()).toBeNull();
});

it("rejects detached history, pending privacy sources and lost server membership", () => {
  useMessageStore.setState({ hasMoreAfterByChannel: { channel: true } });
  expect(getLiveOverlayChatTarget()).toBeNull();
  useMessageStore.setState({ hasMoreAfterByChannel: {} });
  useBlockStore.setState({ snapshotReady: false });
  expect(getLiveOverlayChatTarget()).toBeNull();
  useBlockStore.setState({ snapshotReady: true });
  useServerStore.setState({ servers: [] });
  expect(getLiveOverlayChatTarget()).toBeNull();
});

it("rejects same-user reauthentication and a different destination immediately", () => {
  useUIStore.setState({ destination: { type: "friends", channelId: "friends", label: "" } });
  expect(getLiveOverlayChatTarget()).toBeNull();
  setTokens("new-test", "", "viewer");
  expect(getLiveOverlayChatTarget()).toBeNull();
});

it("resolves only an accepted, account-owned DM with its loaded current history", () => {
  useUIStore.setState({ destination: { type: "dm", channelId: "dm-1", label: "untrusted" } });
  useDMStore.setState({ channels: [{ id: "dm-1", status: "accepted", e2ee_enabled: false, other_user: { id: "peer", username: "Peer" } } as never], messagesByChannel: { "dm-1": [] } });
  expect(getLiveOverlayPrivateChatTarget()).toEqual({ type: "dm", channelId: "dm-1", label: "Peer" });
  expect(getLiveOverlayChatTarget()).toEqual({ type: "dm", channelId: "dm-1", label: "Peer" });
  useDMStore.setState({ channels: [{ id: "dm-1", status: "pending", e2ee_enabled: false, other_user: { id: "peer" } } as never] });
  expect(getLiveOverlayPrivateChatTarget()).toBeNull();
  useDMStore.setState({ channels: [{ id: "dm-1", status: "accepted", e2ee_enabled: false, other_user: { id: "peer" } } as never], hasMoreAfterByChannel: { "dm-1": true } });
  expect(getLiveOverlayPrivateChatTarget()).toBeNull();
  useDMStore.setState({ hasMoreAfterByChannel: {}, ownerId: "other" });
  expect(getLiveOverlayPrivateChatTarget()).toBeNull();
});

it("fails closed for encrypted DM until the local E2EE identity is ready", () => {
  useUIStore.setState({ destination: { type: "dm", channelId: "dm-1", label: "DM" } });
  useDMStore.setState({ channels: [{ id: "dm-1", status: "accepted", e2ee_enabled: true, other_user: { id: "peer" } } as never], messagesByChannel: { "dm-1": [] } });
  useE2EEStore.setState({ initStatus: "initializing" });
  expect(getLiveOverlayPrivateChatTarget()).toBeNull();
});

it("requires a current group list, self-membership, E2EE readiness, and loaded tail", () => {
  useUIStore.setState({ destination: { type: "group-dm", channelId: "group-1", label: "Group" } });
  useGroupDMStore.setState({ groupsReady: true, groups: [{ id: "group-1", name: "Group", members: [{ id: "viewer" }] } as never], messages: { "group-1": [] } });
  expect(getLiveOverlayPrivateChatTarget()).toEqual({ type: "group-dm", channelId: "group-1", label: "Group" });
  useGroupDMStore.setState({ groups: [{ id: "group-1", members: [{ id: "other" }] } as never] });
  expect(getLiveOverlayPrivateChatTarget()).toBeNull();
  useGroupDMStore.setState({ groups: [{ id: "group-1", members: [{ id: "viewer" }] } as never], hasMoreAfterByGroup: { "group-1": true } });
  expect(getLiveOverlayPrivateChatTarget()).toBeNull();
  useGroupDMStore.setState({ hasMoreAfterByGroup: {}, authGeneration: getAuthGeneration() - 1 });
  expect(getLiveOverlayPrivateChatTarget()).toBeNull();
});

it("does not revoke an active group send when its own pending operation is installed", () => {
  useUIStore.setState({ destination: { type: "group-dm", channelId: "group-1", label: "Group" } });
  useGroupDMStore.setState({ groupsReady: true, restoreStatus: "ready", restoreDeviceId: "device",
    groups: [{ id: "group-1", name: "Group", members: [{ id: "viewer" }] } as never], messages: { "group-1": [] } });
  expect(getLiveOverlayChatTarget(true)?.channelId).toBe("group-1");
  useGroupDMStore.setState({ pendingSends: { "group-1": { busy: false } as never } });
  expect(getLiveOverlayChatTarget(true)?.channelId).toBe("group-1");
  useGroupDMStore.setState({ pendingSends: {}, restoredQueue: { "group-1": [{}] as never } });
  expect(getLiveOverlayChatTarget(true)?.channelId).toBe("group-1");
});
