import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel, WSMessage } from "../../types";
const state = vi.hoisted(() => ({
  destination: { type: "text", channelId: "visible" },
  ownerId: "me", authGeneration: 0,
  markAsRead: vi.fn(), incrementUnread: vi.fn(), sound: vi.fn(),
  e2eeReady: false, decrypt: vi.fn(),
  handleMessageCreate: vi.fn(), handleMessageUpdate: vi.fn(),
  handleDeletedChannel: vi.fn(), fetchChannels: vi.fn(), handleChannelDelete: vi.fn(),
  markVoiceChannelCreated: vi.fn(), markVoiceChannelDeleted: vi.fn(),
  rememberThread: vi.fn(), removeThread: vi.fn(), removeParentThreads: vi.fn(),
  handleChannelUpdate: vi.fn(), updateTabLabel: vi.fn(),
}));
vi.mock("../../utils/uiShell", () => ({ UI_SHELL_V2: true }));
vi.mock("../../api/client", () => ({ getAuthGeneration: () => state.authGeneration }));
vi.mock("../../api/authSessionEvents", () => ({
  getAuthSessionOwner: () => state.ownerId,
  getAuthSessionSnapshot: () => ({ ownerId: state.ownerId, generation: state.authGeneration }),
  subscribeAuthOwnerChanges: () => () => {},
  subscribeAuthGenerationChanges: () => () => {},
}));
vi.mock("../../stores/uiStore", () => ({ useUIStore: { getState: () => ({ destination: state.destination, panels: {}, activePanelId: "legacy", updateTabLabel: state.updateTabLabel }) } }));
vi.mock("../../stores/authStore", () => ({ useAuthStore: { getState: () => ({ user: state.ownerId ? { id: state.ownerId } : null }) } }));
vi.mock("../../stores/messageStore", () => ({ useMessageStore: { getState: () => ({ messagesByChannel: {}, handleMessageCreate: state.handleMessageCreate, handleMessageUpdate: state.handleMessageUpdate }) } }));
vi.mock("../../stores/readStateStore", () => ({ useReadStateStore: { getState: () => ({ registerChannel: vi.fn(), markAsRead: state.markAsRead, incrementUnread: state.incrementUnread }) } }));
vi.mock("../../stores/serverStore", () => ({ useServerStore: { getState: () => ({ isServerMuted: () => false }) } }));
vi.mock("../../stores/channelStore", () => ({ useChannelStore: { getState: () => ({ mutedChannelIds: new Set(), categories: [], fetchChannels: state.fetchChannels, handleChannelDelete: state.handleChannelDelete, handleChannelUpdate: state.handleChannelUpdate }) } }));
vi.mock("../../stores/voiceStore", () => ({ useVoiceStore: { getState: () => ({ handleChannelDeleted: state.handleDeletedChannel, markVoiceChannelCreated: state.markVoiceChannelCreated, markVoiceChannelDeleted: state.markVoiceChannelDeleted }) } }));
vi.mock("../../stores/threadStore", () => ({ useThreadStore: { getState: () => ({ remember: state.rememberThread, remove: state.removeThread, removeParent: state.removeParentThreads }) } }));
vi.mock("../../stores/pinStore", () => ({ usePinStore: {} }));
vi.mock("../../stores/channelPermissionStore", () => ({ useChannelPermissionStore: {} }));
vi.mock("../../stores/e2eeStore", () => ({ useE2EEStore: { getState: () => ({ initStatus: state.e2eeReady ? "ready" : "idle" }) } }));
vi.mock("../../crypto/channelEncryption", () => ({ decryptChannelMessage: state.decrypt, markChannelRecipientsStale: vi.fn() }));
vi.mock("../../crypto/keyStorage", () => ({}));
vi.mock("../../utils/sounds", () => ({ playNotificationSound: state.sound }));
vi.mock("../../utils/notifications", () => ({ showNotification: vi.fn() }));
import { handleChannelEvent } from "./channelEventHandlers";

beforeEach(() => { vi.clearAllMocks(); state.destination = { type: "text", channelId: "visible" }; state.e2eeReady = false; state.ownerId = "me"; state.authGeneration = 0; });

describe("channel deletion cleanup", () => {
  it("clears the voice-channel tombstone on an explicit create event", async () => {
    await handleChannelEvent({ op: "channel_create", server_id: "origin-server", d: { id: "reused-channel" } } as WSMessage);
    expect(state.markVoiceChannelCreated).toHaveBeenCalledExactlyOnceWith("reused-channel");
    expect(state.fetchChannels).toHaveBeenCalledExactlyOnceWith("origin-server");
  });

  it("cleans voice state for the deleted channel and refreshes its origin server", async () => {
    await handleChannelEvent({ op: "channel_delete", server_id: "origin-server", d: { id: "deleted-voice" } } as WSMessage);
    expect(state.markVoiceChannelDeleted).toHaveBeenCalledExactlyOnceWith("deleted-voice");
    expect(state.handleDeletedChannel).toHaveBeenCalledExactlyOnceWith("deleted-voice");
    expect(state.handleChannelDelete).toHaveBeenCalledExactlyOnceWith("deleted-voice");
    expect(state.fetchChannels).toHaveBeenCalledExactlyOnceWith("origin-server");
  });
});

describe("thread metadata websocket parity", () => {
  const thread: Channel & { server_id: string } = { id: "thread-1", name: "Topic", type: "thread", category_id: null, topic: null, position: 0, user_limit: 0, bitrate: 0, created_at: "2026-10-25T00:00:00Z", parent_channel_id: "parent-1", server_id: "server-1", archived_at: null };

  it("remembers created threads under the exact server from the event envelope", async () => {
    await handleChannelEvent({ op: "channel_create", server_id: "server-1", d: thread } as WSMessage);
    expect(state.rememberThread).toHaveBeenCalledExactlyOnceWith(thread, "server-1");
  });

  it("refreshes archived state for a thread update", async () => {
    const archived = { ...thread, archived_at: "2026-10-25T12:00:00Z" };
    await handleChannelEvent({ op: "channel_update", server_id: "server-1", d: archived } as WSMessage);
    expect(state.rememberThread).toHaveBeenCalledExactlyOnceWith(archived, "server-1");
  });

  it("removes a deleted thread and all children when its parent is deleted", async () => {
    await handleChannelEvent({ op: "channel_delete", server_id: "server-1", d: { id: "thread-1" } } as WSMessage);
    expect(state.removeThread).toHaveBeenCalledExactlyOnceWith("thread-1", "server-1");
    expect(state.removeParentThreads).toHaveBeenCalledExactlyOnceWith("thread-1", "server-1");
  });

  it("does not let an old connection or conflicting server payload resurrect metadata", async () => {
    await handleChannelEvent({ op: "channel_update", server_id: "server-1", d: thread } as WSMessage, () => false);
    await handleChannelEvent({ op: "channel_update", server_id: "server-1", d: { ...thread, server_id: "server-2" } } as WSMessage);
    expect(state.rememberThread).not.toHaveBeenCalled();
  });

  it("does not use a payload's server ID as a substitute for the scoped event envelope", async () => {
    await handleChannelEvent({ op: "channel_create", d: thread } as WSMessage);
    expect(state.rememberThread).not.toHaveBeenCalled();
  });
});

describe("single-view unread routing", () => {
  it.each(["message_create", "message_update"] as const)("%s decrypts using the event origin while another server is browsed", async (op) => {
    state.e2eeReady = true;
    state.decrypt.mockResolvedValue(null);
    await handleChannelEvent({ op, server_id: "origin-server", d: { id: "m", channel_id: "background", user_id: "me", encryption_version: 1, ciphertext: "cipher", sender_device_id: "device" } } as WSMessage);
    expect(state.decrypt).toHaveBeenCalledExactlyOnceWith("me", "background", "cipher", "device", "origin-server", expect.any(Function));
  });
  it("reads an incoming message in the current destination without an unread badge or sound", async () => {
    await handleChannelEvent({ op: "message_create", d: { id: "m", channel_id: "visible", server_id: "s", user_id: "other", author: { id: "other", username: "Other" } } } as WSMessage);
    expect(state.markAsRead).toHaveBeenCalledWith("visible", "m");
    expect(state.incrementUnread).not.toHaveBeenCalled();
    expect(state.sound).not.toHaveBeenCalled();
  });

  it("counts another conversation as unread", async () => {
    await handleChannelEvent({ op: "message_create", d: { id: "m", channel_id: "background", server_id: "s", user_id: "other", author: { id: "other", username: "Other" } } } as WSMessage);
    expect(state.incrementUnread).toHaveBeenCalledWith("background");
    expect(state.markAsRead).not.toHaveBeenCalled();
  });

  it("drops a queued encrypted create when the authenticated session changes during decrypt", async () => {
    let resolve!: (value: { content: string }) => void;
    state.decrypt.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    state.e2eeReady = true;
    const event = handleChannelEvent({ op: "message_create", server_id: "s", d: {
      id: "late", channel_id: "background", server_id: "s", user_id: "other",
      encryption_version: 1, ciphertext: "cipher", sender_device_id: "device",
      created_at: new Date().toISOString(), author: { id: "other", username: "Other" },
    } } as WSMessage);

    state.ownerId = "next-account";
    state.authGeneration++;
    resolve({ content: "private" });
    await event;

    expect(state.handleMessageCreate).not.toHaveBeenCalled();
    expect(state.markAsRead).not.toHaveBeenCalled();
    expect(state.incrementUnread).not.toHaveBeenCalled();
    expect(state.sound).not.toHaveBeenCalled();
  });

  it("drops a queued encrypted update after the auth generation changes", async () => {
    let resolve!: (value: { content: string }) => void;
    state.decrypt.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    state.e2eeReady = true;
    const event = handleChannelEvent({ op: "message_update", server_id: "s", d: {
      id: "late", channel_id: "background", server_id: "s", user_id: "other",
      encryption_version: 1, ciphertext: "cipher", sender_device_id: "device",
      created_at: new Date().toISOString(), author: { id: "other", username: "Other" },
    } } as WSMessage);

    state.authGeneration++;
    resolve({ content: "private" });
    await event;

    expect(state.handleMessageUpdate).not.toHaveBeenCalled();
  });
});
