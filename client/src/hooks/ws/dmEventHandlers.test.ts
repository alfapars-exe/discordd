/**
 * dmEventHandlers — `dm_message_create` cue gating.
 *
 * Bug being pinned: muting a DM was cosmetic. The sidebar showed the muted
 * icon, but a new message in that DM still played the ping, flashed the
 * window and fired an OS toast. The unread count must still bump (the badge
 * is the user's record of what they missed); only the attention cues honour
 * the mute. A DM that is currently open advances the server read cursor
 * instead of counting as unread, and `dm_read` from another session clears
 * locally without calling the API again (echo loop).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { DMMessage, WSMessage } from "../../types";

const dmStoreState = {
  selectedDMId: null as string | null,
  channels: [] as { id: string; is_muted: boolean }[],
  dmUnreadCounts: {} as Record<string, number>,
  messagesByChannel: {} as Record<string, DMMessage[]>,
  incrementDMUnread: vi.fn(),
  decrementDMUnread: vi.fn(),
  handleDMMessageCreate: vi.fn(),
  handleDMReadSync: vi.fn(),
};

vi.mock("../../stores/dmStore", () => ({
  useDMStore: { getState: () => dmStoreState },
}));
vi.mock("../../stores/authStore", () => ({
  useAuthStore: { getState: () => ({ user: { id: "me" } }) },
}));
// Read lazily through getState(), so the factory never touches it at hoist
// time (#67). localDeviceId is read by the own-message FIFO gate (#64: the
// mock must expose every field the handler reads).
const e2eeStoreState = {
  localDeviceId: "dev-local" as string | null,
  addDecryptionError: vi.fn(),
  checkAndPromptRecovery: vi.fn(),
};
vi.mock("../../stores/e2eeStore", () => ({
  useE2EEStore: { getState: () => e2eeStoreState },
}));
vi.mock("../../api/dm", () => ({
  markDMRead: vi.fn(async () => ({ success: true, data: { message: "marked as read" } })),
}));
vi.mock("../../crypto/dmEncryption", () => ({
  decryptDMMessage: vi.fn(),
  popSentPlaintext: vi.fn(),
  popEditPlaintext: vi.fn(),
}));
vi.mock("../../crypto/keyStorage", () => ({
  cacheDecryptedMessage: vi.fn(async () => {}),
  getCachedDecryptedMessage: vi.fn(async () => null),
}));
vi.mock("../../utils/sounds", () => ({ playNotificationSound: vi.fn() }));
vi.mock("../../utils/notifications", () => ({ showNotification: vi.fn() }));

import { handleDMEvent } from "./dmEventHandlers";
import { playNotificationSound } from "../../utils/sounds";
import { showNotification } from "../../utils/notifications";
import { markDMRead } from "../../api/dm";
import { decryptDMMessage, popSentPlaintext } from "../../crypto/dmEncryption";

function makeDMMessage(overrides: Partial<DMMessage> = {}): DMMessage {
  return {
    id: "msg-1",
    dm_channel_id: "dm-1",
    user_id: "other",
    content: "hello",
    edited_at: null,
    created_at: "2026-10-21T10:00:00Z",
    reply_to_id: null,
    is_pinned: false,
    author: {
      id: "other",
      username: "alice",
      display_name: "Alice",
      avatar_url: null,
      status: "online",
      custom_status: null,
      created_at: "2026-01-01T00:00:00Z",
    },
    attachments: [],
    reactions: [],
    referenced_message: null,
    encryption_version: 0,
    ...overrides,
  };
}

function createMsg(overrides: Partial<DMMessage> = {}): WSMessage {
  return { op: "dm_message_create", d: makeDMMessage(overrides) };
}

const flashFrame = vi.fn(async () => {});

beforeEach(() => {
  vi.clearAllMocks();
  dmStoreState.selectedDMId = null;
  dmStoreState.channels = [{ id: "dm-1", is_muted: false }];
  dmStoreState.dmUnreadCounts = {};
  dmStoreState.messagesByChannel = {};
  e2eeStoreState.localDeviceId = "dev-local";
  // Only flashFrame is exercised here; the rest of the preload surface is
  // irrelevant to this handler.
  (window as unknown as { electronAPI: { flashFrame: () => Promise<void> } }).electronAPI = {
    flashFrame,
  };
});

describe("handleDMEvent — dm_message_create cue gating", () => {
  it("unmuted DM in the background: bumps unread and fires sound + flash + toast", async () => {
    await handleDMEvent(createMsg());

    expect(dmStoreState.incrementDMUnread).toHaveBeenCalledWith("dm-1");
    expect(playNotificationSound).toHaveBeenCalledTimes(1);
    expect(flashFrame).toHaveBeenCalledTimes(1);
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(markDMRead).not.toHaveBeenCalled();
  });

  it("muted DM in the background: still bumps unread but NO sound / flash / toast", async () => {
    dmStoreState.channels = [{ id: "dm-1", is_muted: true }];

    await handleDMEvent(createMsg());

    expect(dmStoreState.incrementDMUnread).toHaveBeenCalledWith("dm-1");
    expect(playNotificationSound).not.toHaveBeenCalled();
    expect(flashFrame).not.toHaveBeenCalled();
    expect(showNotification).not.toHaveBeenCalled();
  });

  it("DM currently open: advances the server read cursor, no unread bump, no cues", async () => {
    dmStoreState.selectedDMId = "dm-1";

    await handleDMEvent(createMsg({ id: "msg-7" }));

    expect(markDMRead).toHaveBeenCalledWith("dm-1", "msg-7");
    expect(dmStoreState.incrementDMUnread).not.toHaveBeenCalled();
    expect(playNotificationSound).not.toHaveBeenCalled();
    expect(showNotification).not.toHaveBeenCalled();
  });

  it("own message echo: no unread, no cues, no read call", async () => {
    await handleDMEvent(createMsg({ user_id: "me" }));

    expect(dmStoreState.handleDMMessageCreate).toHaveBeenCalledTimes(1);
    expect(dmStoreState.incrementDMUnread).not.toHaveBeenCalled();
    expect(playNotificationSound).not.toHaveBeenCalled();
    expect(markDMRead).not.toHaveBeenCalled();
  });
});

describe("handleDMEvent — dm_message_create own E2EE echo (sent-plaintext FIFO)", () => {
  /** Own E2EE message as the server echoes it; content is server-side null. */
  function ownEncrypted(senderDeviceId: string): WSMessage {
    return createMsg({
      user_id: "me",
      content: null,
      encryption_version: 1,
      ciphertext: "[]",
      sender_device_id: senderDeviceId,
    });
  }

  /** The DMMessage the handler handed to the store. */
  function stored(): DMMessage {
    return dmStoreState.handleDMMessageCreate.mock.calls[0][0] as DMMessage;
  }

  it("own message from THIS device pops the queued plaintext", async () => {
    vi.mocked(popSentPlaintext).mockReturnValueOnce({ content: "my note" });

    await handleDMEvent(ownEncrypted("dev-local"));

    expect(popSentPlaintext).toHaveBeenCalledWith("dm-1");
    expect(decryptDMMessage).not.toHaveBeenCalled();
    expect(stored().content).toBe("my note");
  });

  it("own message from ANOTHER device decrypts and leaves the queue for the in-flight send", async () => {
    vi.mocked(decryptDMMessage).mockResolvedValueOnce({ content: "from laptop" });

    await handleDMEvent(ownEncrypted("dev-laptop"));

    expect(popSentPlaintext).not.toHaveBeenCalled();
    expect(decryptDMMessage).toHaveBeenCalledWith("me", "[]", "dev-laptop");
    expect(stored().content).toBe("from laptop");
  });

  it("unknown local device id never pops the queue", async () => {
    e2eeStoreState.localDeviceId = null;

    await handleDMEvent(ownEncrypted("dev-local"));

    expect(popSentPlaintext).not.toHaveBeenCalled();
  });

  it("forged own message with this device id and nothing queued falls to the null placeholder", async () => {
    // popSentPlaintext: nothing queued; IndexedDB: miss; decrypt: no envelope.
    vi.mocked(popSentPlaintext).mockReturnValueOnce(null);
    vi.mocked(decryptDMMessage).mockResolvedValueOnce(null);

    await expect(handleDMEvent(ownEncrypted("dev-local"))).resolves.toBe(true);

    expect(popSentPlaintext).toHaveBeenCalledTimes(1);
    expect(stored().content).toBeNull();
  });
});

describe("handleDMEvent — dm_read", () => {
  it("clears locally via handleDMReadSync and never calls the API (no echo loop)", async () => {
    const handled = await handleDMEvent({
      op: "dm_read",
      d: { dm_channel_id: "dm-1", user_id: "me", last_read_message_id: "msg-3" },
    });

    expect(handled).toBe(true);
    expect(dmStoreState.handleDMReadSync).toHaveBeenCalledWith({
      dm_channel_id: "dm-1",
      user_id: "me",
      last_read_message_id: "msg-3",
    });
    expect(markDMRead).not.toHaveBeenCalled();
  });
});
