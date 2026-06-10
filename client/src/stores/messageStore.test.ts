/**
 * messageStore race/WS tests — the fetch ↔ WebSocket interplay that keeps
 * a channel's message window consistent:
 *
 *   1. handleMessageCreate dedup — the same WS message delivered twice
 *      (reconnect replay) lands in messagesByChannel exactly once.
 *   2. WS buffering — a message arriving while the channel's fetch is in
 *      flight is buffered, then merged without duplicates after the
 *      fetch resolves.
 *   3. handleMessageDelete removes the row AND publishes lastDeleted so
 *      snapshot consumers (search panel) can drop dead rows.
 *   4. Abort discipline — a re-fetch of the same channel and
 *      invalidateFetchCache both abort the stale in-flight request so
 *      its late payload can't clobber what the user is now looking at.
 *
 * Pattern matches memberStore.test.ts / authStore.test.ts: mock the API
 * modules, reset the Zustand store between tests, exercise the public
 * store API.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../api/messages", () => ({
  getMessages: vi.fn(),
  sendMessage: vi.fn(),
  sendEncryptedMessage: vi.fn(),
  editMessage: vi.fn(),
  editEncryptedMessage: vi.fn(),
  deleteMessage: vi.fn(),
}));
vi.mock("../api/reactions", () => ({
  toggleReaction: vi.fn(),
}));
// Pass-through decrypt — these tests exercise fetch/WS plumbing, not E2EE.
vi.mock("../crypto/channelEncryption", () => ({
  encryptChannelMessage: vi.fn(),
  decryptChannelMessages: vi.fn(async (msgs: unknown[]) => msgs),
}));
vi.mock("../crypto/e2eePayload", () => ({
  encodePayload: vi.fn((content: string) => content),
}));
vi.mock("./serverStore", () => ({
  useServerStore: {
    getState: () => ({
      activeServerId: "srv-1",
      activeServer: { e2ee_enabled: false },
    }),
  },
}));
vi.mock("./e2eeStore", () => ({
  useE2EEStore: {
    getState: () => ({ initStatus: "uninitialized", localDeviceId: null }),
  },
}));
vi.mock("./authStore", () => ({
  useAuthStore: { getState: () => ({ user: null }) },
}));
vi.mock("./readStateStore", () => ({
  useReadStateStore: { getState: () => ({ markAsRead: vi.fn() }) },
}));
vi.mock("./toastStore", () => ({
  useToastStore: { getState: () => ({ addToast: vi.fn() }) },
}));

import { useMessageStore } from "./messageStore";
import * as messageApi from "../api/messages";
import type { APIResponse, Message, MessagePage } from "../types";

const getMessages = vi.mocked(messageApi.getMessages);

/** Same minimal Message shape SearchPanel.test.tsx builds. */
function makeMessage(id: string, channelId = "ch-1"): Message {
  return {
    id,
    channel_id: channelId,
    user_id: "u-1",
    content: `content of ${id}`,
    created_at: "2026-01-01T00:00:00.000Z",
    edited_at: null,
    attachments: [],
    mentions: [],
    role_mentions: [],
    reactions: [],
    reply_to_id: null,
    referenced_message: null,
    author: { id: "u-1", username: "alice", display_name: null, avatar_url: null, status: "online" as const, custom_status: null, email: null, language: "en", is_platform_admin: false, has_seen_download_prompt: false, has_seen_welcome: false, dm_privacy: "message_request" as const, created_at: "" },
    encryption_version: 0,
  };
}

function ok(messages: Message[], hasMore = false): APIResponse<MessagePage> {
  return { success: true, data: { messages, has_more: hasMore } };
}

/** Manually-resolvable promise — lets the test control response order. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function resetStore() {
  // invalidateFetchCache clears the module-level fetchedChannels set and
  // aborts any in-flight fetch left over from the previous test.
  useMessageStore.getState().invalidateFetchCache();
  useMessageStore.setState({
    messagesByChannel: {},
    hasMoreByChannel: {},
    isLoading: false,
    isLoadingMore: false,
    typingUsers: {},
    lastDeleted: null,
    replyingTo: null,
    scrollToMessageId: null,
  });
}

beforeEach(() => {
  resetStore();
  getMessages.mockReset();
});

describe("messageStore — handleMessageCreate dedup", () => {
  it("stores a WS message delivered twice exactly once", () => {
    const msg = makeMessage("m-1");
    useMessageStore.getState().handleMessageCreate(msg);
    useMessageStore.getState().handleMessageCreate(msg);

    const msgs = useMessageStore.getState().messagesByChannel["ch-1"];
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe("m-1");
  });
});

describe("messageStore — WS buffering during fetch", () => {
  it("merges buffered WS messages after fetchMessages resolves, without duplicates", async () => {
    const api = deferred<APIResponse<MessagePage>>();
    getMessages.mockReturnValueOnce(api.promise);

    const fetching = useMessageStore.getState().fetchMessages("ch-1", "srv-1");

    // Two WS messages land while the API request is pending. One of them
    // ("dup-1") is also part of the API page — it must not double up.
    useMessageStore.getState().handleMessageCreate(makeMessage("dup-1"));
    useMessageStore.getState().handleMessageCreate(makeMessage("ws-1"));
    expect(useMessageStore.getState().messagesByChannel["ch-1"]).toHaveLength(2);

    api.resolve(ok([makeMessage("api-1"), makeMessage("dup-1")]));
    await fetching;

    const msgs = useMessageStore.getState().messagesByChannel["ch-1"];
    expect(msgs.map((m) => m.id)).toEqual(["api-1", "dup-1", "ws-1"]);
    expect(useMessageStore.getState().isLoading).toBe(false);
  });
});

describe("messageStore — handleMessageDelete", () => {
  it("removes the message and records lastDeleted for snapshot consumers", () => {
    useMessageStore.getState().handleMessageCreate(makeMessage("m-1"));
    useMessageStore.getState().handleMessageCreate(makeMessage("m-2"));

    useMessageStore.getState().handleMessageDelete({ id: "m-1", channel_id: "ch-1" });

    const msgs = useMessageStore.getState().messagesByChannel["ch-1"];
    expect(msgs.map((m) => m.id)).toEqual(["m-2"]);
    expect(useMessageStore.getState().lastDeleted).toEqual({ id: "m-1", channel_id: "ch-1" });
  });
});

describe("messageStore — in-flight fetch aborts", () => {
  it("a re-fetch aborts the stale request; its late payload is dropped", async () => {
    const stale = deferred<APIResponse<MessagePage>>();
    const fresh = deferred<APIResponse<MessagePage>>();
    getMessages
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(fresh.promise);

    // Spam-click: the second fetch for the SAME channel aborts the first
    // (per-channel AbortController in inflightFetches).
    const first = useMessageStore.getState().fetchMessages("ch-1", "srv-1");
    const second = useMessageStore.getState().fetchMessages("ch-1", "srv-1");

    fresh.resolve(ok([makeMessage("fresh-1")]));
    await second;
    expect(
      useMessageStore.getState().messagesByChannel["ch-1"].map((m) => m.id)
    ).toEqual(["fresh-1"]);

    // Stale response arrives late — must not clobber the fresh window.
    stale.resolve(ok([makeMessage("stale-1")]));
    await first;
    expect(
      useMessageStore.getState().messagesByChannel["ch-1"].map((m) => m.id)
    ).toEqual(["fresh-1"]);
  });

  it("invalidateFetchCache aborts in-flight fetches (E2EE rotation case)", async () => {
    const api = deferred<APIResponse<MessagePage>>();
    getMessages.mockReturnValueOnce(api.promise);

    const fetching = useMessageStore.getState().fetchMessages("ch-1", "srv-1");
    useMessageStore.getState().invalidateFetchCache();

    api.resolve(ok([makeMessage("stale-1")]));
    await fetching;

    // The late payload must not repopulate the cleared window.
    expect(useMessageStore.getState().messagesByChannel["ch-1"]).toBeUndefined();
  });
});
