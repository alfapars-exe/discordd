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
  getMessagesAround: vi.fn(),
  getMessagesAfter: vi.fn(),
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
import { decryptChannelMessages } from "../crypto/channelEncryption";
import type { APIResponse, Message, MessagePage } from "../types";

const getMessages = vi.mocked(messageApi.getMessages);
const getMessagesAround = vi.mocked(messageApi.getMessagesAround);
const getMessagesAfter = vi.mocked(messageApi.getMessagesAfter);
const sendMessage = vi.mocked(messageApi.sendMessage);
const decryptMock = vi.mocked(decryptChannelMessages);

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
    author: { id: "u-1", username: "alice", display_name: null, avatar_url: null, status: "online" as const, custom_status: null, created_at: "" },
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
    hasMoreAfterByChannel: {},
    isLoadingByChannel: {},
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
  getMessagesAround.mockReset();
  getMessagesAfter.mockReset();
  sendMessage.mockReset();
  decryptMock.mockReset();
  decryptMock.mockImplementation(async (msgs) => msgs as Message[]);
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
    expect(useMessageStore.getState().isLoadingByChannel["ch-1"]).toBe(false);
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

describe("messageStore — invalidateFetchedFlags (WS reconnect)", () => {
  it("allows a refetch but keeps the rendered messages in place", async () => {
    getMessages.mockResolvedValueOnce(ok([makeMessage("m-1")]));
    await useMessageStore.getState().fetchMessages("ch-1", "srv-1");
    expect(getMessages).toHaveBeenCalledTimes(1);

    // Fetch guard is armed — a second fetch is a no-op.
    await useMessageStore.getState().fetchMessages("ch-1", "srv-1");
    expect(getMessages).toHaveBeenCalledTimes(1);

    useMessageStore.getState().invalidateFetchedFlags();

    // Unlike invalidateFetchCache, the window survives — clearing it would
    // blank the chat on every reconnect before the refetch lands.
    expect(
      useMessageStore.getState().messagesByChannel["ch-1"].map((m) => m.id)
    ).toEqual(["m-1"]);

    getMessages.mockResolvedValueOnce(ok([makeMessage("m-1"), makeMessage("m-2")]));
    await useMessageStore.getState().fetchMessages("ch-1", "srv-1");

    expect(getMessages).toHaveBeenCalledTimes(2);
    expect(
      useMessageStore.getState().messagesByChannel["ch-1"].map((m) => m.id)
    ).toEqual(["m-1", "m-2"]);
  });

  it("aborts an in-flight fetch so its late payload can't beat the refetch", async () => {
    const stale = deferred<APIResponse<MessagePage>>();
    getMessages.mockReturnValueOnce(stale.promise);

    const fetching = useMessageStore.getState().fetchMessages("ch-1", "srv-1");
    useMessageStore.getState().invalidateFetchedFlags();

    stale.resolve(ok([makeMessage("stale-1")]));
    await fetching;

    expect(useMessageStore.getState().messagesByChannel["ch-1"]).toBeUndefined();
  });
});

describe("messageStore — per-channel loading & abort hygiene", () => {
  it("loading is per-channel: one channel's fetch doesn't flag others", async () => {
    const api = deferred<APIResponse<MessagePage>>();
    getMessages.mockReturnValueOnce(api.promise);

    const fetching = useMessageStore.getState().fetchMessages("ch-1", "srv-1");
    expect(useMessageStore.getState().isLoadingByChannel["ch-1"]).toBe(true);
    expect(!!useMessageStore.getState().isLoadingByChannel["ch-2"]).toBe(false);

    api.resolve(ok([]));
    await fetching;
    expect(useMessageStore.getState().isLoadingByChannel["ch-1"]).toBe(false);
  });

  it("an abort during decrypt neither marks the channel fetched nor leaves it loading", async () => {
    // The permanent-skeleton bug: fetchedChannels.add() used to run BEFORE
    // the post-decrypt abort check, and the abort branches returned without
    // clearing isLoading — leaving a forever-skeleton, forever-unfetchable
    // channel. This drives the abort into the decrypt phase specifically.
    const api = deferred<APIResponse<MessagePage>>();
    const decrypt = deferred<Message[]>();
    getMessages.mockReturnValueOnce(api.promise);
    decryptMock.mockImplementationOnce(() => decrypt.promise);

    const fetching = useMessageStore.getState().fetchMessages("ch-1", "srv-1");
    api.resolve(ok([makeMessage("stale-1")]));
    // Let the store advance past the request-phase abort check into decrypt.
    await new Promise((r) => setTimeout(r, 0));

    useMessageStore.getState().invalidateFetchCache();
    decrypt.resolve([makeMessage("stale-1")]);
    await fetching;

    expect(useMessageStore.getState().messagesByChannel["ch-1"]).toBeUndefined();
    expect(useMessageStore.getState().isLoadingByChannel["ch-1"]).toBe(false);

    // The channel must remain fetchable — the guard was never armed.
    getMessages.mockResolvedValueOnce(ok([makeMessage("m-1")]));
    await useMessageStore.getState().fetchMessages("ch-1", "srv-1");
    expect(
      useMessageStore.getState().messagesByChannel["ch-1"].map((m) => m.id)
    ).toEqual(["m-1"]);
  });
});

describe("messageStore — sendMessage inserts the POST body", () => {
  it("renders the sender's message from the 201 response, without waiting for the WS echo", async () => {
    const created = makeMessage("sent-1");
    sendMessage.mockResolvedValueOnce({ success: true, data: created });

    const okSend = await useMessageStore.getState().sendMessage("ch-1", "hello");
    expect(okSend).toBe(true);
    expect(
      useMessageStore.getState().messagesByChannel["ch-1"].map((m) => m.id)
    ).toEqual(["sent-1"]);

    // The WS echo arriving afterwards dedupes by id — still one message.
    useMessageStore.getState().handleMessageCreate(created);
    expect(useMessageStore.getState().messagesByChannel["ch-1"]).toHaveLength(1);
  });

  it("echo-first then 201-insert also dedupes to one message", async () => {
    const created = makeMessage("sent-2");
    const api = deferred<APIResponse<Message>>();
    sendMessage.mockReturnValueOnce(api.promise);

    const sending = useMessageStore.getState().sendMessage("ch-1", "hello");
    // Synchronous broadcast path: echo can land before the HTTP response.
    useMessageStore.getState().handleMessageCreate(created);
    api.resolve({ success: true, data: created });
    await sending;

    expect(useMessageStore.getState().messagesByChannel["ch-1"]).toHaveLength(1);
  });

  it("unwraps the 207 multi-status envelope ({message, upload_failures})", async () => {
    const created = makeMessage("sent-3");
    sendMessage.mockResolvedValueOnce({
      success: true,
      data: { message: created, upload_failures: [{ filename: "x.png", error: "boom" }] },
    } as unknown as APIResponse<Message>);

    await useMessageStore.getState().sendMessage("ch-1", "hello");
    expect(
      useMessageStore.getState().messagesByChannel["ch-1"].map((m) => m.id)
    ).toEqual(["sent-3"]);
  });

  it("inserts nothing on failure", async () => {
    sendMessage.mockResolvedValueOnce({ success: false, error: "nope", status: 403 });
    const okSend = await useMessageStore.getState().sendMessage("ch-1", "hello");
    expect(okSend).toBe(false);
    expect(useMessageStore.getState().messagesByChannel["ch-1"]).toBeUndefined();
  });
});

function aroundPage(
  messages: Message[],
  hasMore: boolean,
  hasMoreAfter: boolean
): APIResponse<MessagePage> {
  return { success: true, data: { messages, has_more: hasMore, has_more_after: hasMoreAfter } };
}

/** Put ch-1 into a jumped-to window [old-1, target, old-3] with newer messages after it. */
async function jumpIntoPast() {
  getMessagesAround.mockResolvedValueOnce(
    aroundPage([makeMessage("old-1"), makeMessage("target"), makeMessage("old-3")], true, true)
  );
  const found = await useMessageStore.getState().fetchAroundMessage("srv-1", "ch-1", "target");
  expect(found).toBe(true);
}

describe("messageStore — fetchAroundMessage vs mount-time fetchMessages race", () => {
  it("a fetchMessages call during the jump is skipped; the around window wins", async () => {
    const around = deferred<APIResponse<MessagePage>>();
    getMessagesAround.mockReturnValueOnce(around.promise);

    const jumping = useMessageStore.getState().fetchAroundMessage("srv-1", "ch-1", "target");
    // MessageList mounts on the freshly opened tab and asks for the tail.
    await useMessageStore.getState().fetchMessages("ch-1", "srv-1");
    expect(getMessages).not.toHaveBeenCalled();

    around.resolve(aroundPage([makeMessage("a-1"), makeMessage("target")], true, true));
    expect(await jumping).toBe(true);

    const s = useMessageStore.getState();
    expect(s.messagesByChannel["ch-1"].map((m) => m.id)).toEqual(["a-1", "target"]);
    expect(s.hasMoreAfterByChannel["ch-1"]).toBe(true);
    expect(s.isLoadingByChannel["ch-1"]).toBe(false);

    // Still skipped afterwards — the window is marked fetched.
    await useMessageStore.getState().fetchMessages("ch-1", "srv-1");
    expect(getMessages).not.toHaveBeenCalled();
  });

  it("releases the claim when the target is gone and loads the tail instead", async () => {
    getMessagesAround.mockResolvedValueOnce({ success: false, status: 404, error: "not found" });
    getMessages.mockResolvedValueOnce(ok([makeMessage("tail-1")]));

    const found = await useMessageStore.getState().fetchAroundMessage("srv-1", "ch-1", "gone");
    expect(found).toBe(false);
    await vi.waitFor(() =>
      expect(useMessageStore.getState().messagesByChannel["ch-1"]?.map((m) => m.id)).toEqual(["tail-1"])
    );
    expect(getMessages).toHaveBeenCalledTimes(1);
  });
});

describe("messageStore — leaving a jumped-to window", () => {
  it("sending while detached returns to the present and shows the sender's own message", async () => {
    await jumpIntoPast();

    const tail = deferred<APIResponse<MessagePage>>();
    getMessages.mockReturnValueOnce(tail.promise);
    const created = makeMessage("mine");
    sendMessage.mockResolvedValueOnce({ success: true, data: created });

    const okSend = await useMessageStore.getState().sendMessage("ch-1", "hello", undefined, undefined, "srv-1");
    expect(okSend).toBe(true);
    expect(useMessageStore.getState().hasMoreAfterByChannel["ch-1"]).toBe(false);
    expect(getMessages).toHaveBeenCalledTimes(1);

    // The tail refetch (issued before the POST) doesn't contain it — the
    // WS-buffer merge must keep it.
    tail.resolve(ok([makeMessage("t-1"), makeMessage("t-2")]));
    await vi.waitFor(() =>
      expect(useMessageStore.getState().messagesByChannel["ch-1"].map((m) => m.id)).toEqual([
        "t-1", "t-2", "mine",
      ])
    );
  });

  it("holds live messages while detached and merges them when forward paging hits the tail", async () => {
    await jumpIntoPast();

    // Two live messages while looking at the past: not appended to the window.
    useMessageStore.getState().handleMessageCreate(makeMessage("live-1"));
    useMessageStore.getState().handleMessageCreate(makeMessage("live-2"));
    expect(useMessageStore.getState().messagesByChannel["ch-1"].map((m) => m.id)).toEqual([
      "old-1", "target", "old-3",
    ]);

    // Last forward page: includes live-1 (already persisted) but not live-2.
    getMessagesAfter.mockResolvedValueOnce(
      aroundPage([makeMessage("new-1"), makeMessage("live-1")], false, false)
    );
    await useMessageStore.getState().fetchNewerMessages("ch-1", "srv-1");

    const s = useMessageStore.getState();
    expect(getMessagesAfter).toHaveBeenCalledWith("srv-1", "ch-1", "old-3", expect.any(Number));
    expect(s.hasMoreAfterByChannel["ch-1"]).toBe(false);
    expect(s.messagesByChannel["ch-1"].map((m) => m.id)).toEqual([
      "old-1", "target", "old-3", "new-1", "live-1", "live-2",
    ]);
  });
});
