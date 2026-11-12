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

const authGenerationState = vi.hoisted(() => ({ value: 0 }));
vi.mock("../api/client", () => ({ getAuthGeneration: () => authGenerationState.value }));
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
vi.mock("../utils/registerSpamMessage", () => ({ registerSpamBatch: vi.fn() }));
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
      activeServer: { id: "srv-1", e2ee_enabled: false },
    }),
  },
}));
vi.mock("./e2eeStore", () => ({
  useE2EEStore: {
    getState: () => ({ initStatus: "uninitialized", localDeviceId: null }),
  },
}));
const markAsRead = vi.hoisted(() => vi.fn());
vi.mock("./readStateStore", () => ({
  useReadStateStore: { getState: () => ({ markAsRead }) },
}));
vi.mock("./toastStore", () => ({
  useToastStore: { getState: () => ({ addToast: vi.fn() }) },
}));

import { useMessageStore } from "./messageStore";
import { publishAuthGenerationChange, publishAuthOwnerChange } from "../api/authSessionEvents";
import * as messageApi from "../api/messages";
import * as spamRegistration from "../utils/registerSpamMessage";
import { decryptChannelMessages } from "../crypto/channelEncryption";
import type { APIResponse, Message, MessagePage } from "../types";

const getMessages = vi.mocked(messageApi.getMessages);
const getMessagesAround = vi.mocked(messageApi.getMessagesAround);
const getMessagesAfter = vi.mocked(messageApi.getMessagesAfter);
const sendMessage = vi.mocked(messageApi.sendMessage);
const decryptMock = vi.mocked(decryptChannelMessages);
const registerSpamBatch = vi.mocked(spamRegistration.registerSpamBatch);

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

function switchSession(userId: string, generation = authGenerationState.value + 1) {
  authGenerationState.value = generation;
  publishAuthOwnerChange(userId);
}

beforeEach(() => {
  authGenerationState.value = 0;
  publishAuthOwnerChange("test-user");
  resetStore();
  getMessages.mockReset();
  getMessagesAround.mockReset();
  getMessagesAfter.mockReset();
  sendMessage.mockReset();
  decryptMock.mockReset();
  decryptMock.mockImplementation(async (msgs) => msgs as Message[]);
  registerSpamBatch.mockReset();
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
  it("clears channel-keyed data on a same-owner auth generation change", () => {
    useMessageStore.setState({ messagesByChannel: { "ch-1": [makeMessage("old-session")] } });
    authGenerationState.value++;
    publishAuthGenerationChange(authGenerationState.value);
    expect(useMessageStore.getState().messagesByChannel).toEqual({});
    expect(useMessageStore.getState().ownerId).toBe("test-user");
  });

  it("clears caches synchronously and drops a late response when the auth owner changes", async () => {
    const api = deferred<APIResponse<MessagePage>>();
    getMessages.mockReturnValueOnce(api.promise);
    const fetching = useMessageStore.getState().fetchMessages("ch-1", "srv-1");

    switchSession("next-user");
    expect(useMessageStore.getState().ownerId).toBe("next-user");
    expect(useMessageStore.getState().messagesByChannel).toEqual({});
    api.resolve(ok([makeMessage("old-account")]));
    await fetching;

    expect(useMessageStore.getState().messagesByChannel).toEqual({});
    expect(registerSpamBatch).not.toHaveBeenCalled();
  });

  it("drops decrypted tail results if the auth owner changes during decrypt", async () => {
    const decrypting = deferred<Message[]>();
    getMessages.mockResolvedValueOnce(ok([makeMessage("old-account")]));
    decryptMock.mockReturnValueOnce(decrypting.promise);
    const fetching = useMessageStore.getState().fetchMessages("ch-1", "srv-1");
    await vi.waitFor(() => expect(decryptMock).toHaveBeenCalledTimes(1));

    switchSession("next-user");
    decrypting.resolve([makeMessage("old-account")]);
    await fetching;

    expect(useMessageStore.getState().messagesByChannel).toEqual({});
    expect(registerSpamBatch).not.toHaveBeenCalled();
  });

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

describe("messageStore — paged requests are session fenced", () => {
  it.each(["older", "newer"] as const)("does not commit a stale %s page", async (direction) => {
    const page = deferred<APIResponse<MessagePage>>();
    useMessageStore.setState({
      messagesByChannel: { "ch-1": [makeMessage("anchor")] },
      hasMoreByChannel: { "ch-1": true },
      hasMoreAfterByChannel: { "ch-1": true },
    });
    if (direction === "older") getMessages.mockReturnValueOnce(page.promise);
    else getMessagesAfter.mockReturnValueOnce(page.promise);

    const pending = direction === "older"
      ? useMessageStore.getState().fetchOlderMessages("ch-1", "srv-1")
      : useMessageStore.getState().fetchNewerMessages("ch-1", "srv-1");
    switchSession("next-user");
    page.resolve(ok([makeMessage("old-account-page")]));
    await pending;

    expect(useMessageStore.getState().ownerId).toBe("next-user");
    expect(useMessageStore.getState().messagesByChannel).toEqual({});
    expect(registerSpamBatch).not.toHaveBeenCalled();
  });

  it("does not let an old WS owner insert a message after an account transition", () => {
    const oldOwner = { ownerId: "test-user", authGeneration: 0 };
    switchSession("next-user");
    useMessageStore.getState().handleMessageCreate(makeMessage("old-ws"), oldOwner);
    expect(useMessageStore.getState().messagesByChannel).toEqual({});
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
  it("refuses a stale source before dispatch and rechecks it after server resolution", async () => {
    expect(await useMessageStore.getState().sendMessage("ch-1", "hello", undefined, undefined, "srv-1", { isCurrent: () => false })).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
    let current = true;
    const pending = useMessageStore.getState().sendMessage("ch-1", "hello", undefined, undefined, "srv-1", { isCurrent: () => current });
    current = false;
    expect(await pending).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not claim a source-invalidated in-flight POST as current success", async () => {
    const api = deferred<APIResponse<Message>>();
    sendMessage.mockReturnValueOnce(api.promise);
    let current = true;
    const pending = useMessageStore.getState().sendMessage("ch-1", "hello", undefined, undefined, "srv-1", { isCurrent: () => current });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    current = false;
    api.resolve({ success: true, data: makeMessage("late-source-post") });
    expect(await pending).toBe(false);
    expect(useMessageStore.getState().messagesByChannel["ch-1"] ?? []).toEqual([]);
  });

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

  it("does not decrypt, register spam, fall back, or write state after scoped navigation goes stale", async () => {
    const around = deferred<APIResponse<MessagePage>>();
    getMessagesAround.mockReturnValueOnce(around.promise);
    let current = true;
    const jumping = useMessageStore.getState().fetchAroundMessage("srv-1", "ch-1", "target", {
      isCurrent: () => current,
      timeoutMs: 5000,
    });
    const requestOptions = getMessagesAround.mock.calls[0][4];
    expect(requestOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(requestOptions?.timeoutMs).toBe(5000);
    expect(requestOptions?.isCurrent?.()).toBe(true);

    current = false;
    around.resolve(aroundPage([makeMessage("target")], true, false));
    expect(await jumping).toBe(false);
    expect(decryptMock).not.toHaveBeenCalled();
    expect(registerSpamBatch).not.toHaveBeenCalled();
    expect(getMessages).not.toHaveBeenCalled();
    expect(useMessageStore.getState().messagesByChannel["ch-1"]).toBeUndefined();
    expect(useMessageStore.getState().isLoadingByChannel["ch-1"]).toBe(false);
  });

  it("rechecks scoped navigation after decryption before spam or store writes", async () => {
    const decrypting = deferred<Message[]>();
    decryptMock.mockReturnValueOnce(decrypting.promise);
    getMessagesAround.mockResolvedValueOnce(aroundPage([makeMessage("target")], true, false));
    let current = true;
    const jumping = useMessageStore.getState().fetchAroundMessage("srv-1", "ch-1", "target", {
      isCurrent: () => current,
    });
    await vi.waitFor(() => expect(decryptMock).toHaveBeenCalledTimes(1));
    current = false;
    decrypting.resolve([makeMessage("target")]);

    expect(await jumping).toBe(false);
    expect(registerSpamBatch).not.toHaveBeenCalled();
    expect(useMessageStore.getState().messagesByChannel["ch-1"]).toBeUndefined();
    expect(useMessageStore.getState().isLoadingByChannel["ch-1"]).toBe(false);
  });

  it("does not clear loading in a reset store when an old-account request finishes", async () => {
    const around = deferred<APIResponse<MessagePage>>();
    getMessagesAround.mockReturnValueOnce(around.promise);
    const jumping = useMessageStore.getState().fetchAroundMessage("srv-1", "ch-1", "target");
    expect(useMessageStore.getState().isLoadingByChannel["ch-1"]).toBe(true);

    useMessageStore.getState().invalidateFetchCache();
    authGenerationState.value++;
    // Represents a new account's request owning the same channel key.
    useMessageStore.setState({ isLoadingByChannel: { "ch-1": true } });
    around.resolve(aroundPage([makeMessage("target")], true, false));

    expect(await jumping).toBe(false);
    expect(useMessageStore.getState().isLoadingByChannel["ch-1"]).toBe(true);
    expect(useMessageStore.getState().messagesByChannel["ch-1"]).toBeUndefined();
    expect(registerSpamBatch).not.toHaveBeenCalled();
  });

  it.each(["request", "decrypt"] as const)("releases around ownership and loading after a thrown %s error", async (failure) => {
    if (failure === "request") {
      getMessagesAround.mockRejectedValueOnce(new Error("network"));
    } else {
      getMessagesAround.mockResolvedValueOnce(aroundPage([makeMessage("target")], true, false));
      decryptMock.mockRejectedValueOnce(new Error("decrypt"));
    }
    await expect(useMessageStore.getState().fetchAroundMessage("srv-1", "ch-1", "target")).rejects.toThrow();
    expect(useMessageStore.getState().isLoadingByChannel["ch-1"]).toBe(false);

    getMessagesAround.mockResolvedValueOnce(aroundPage([makeMessage("target")], true, false));
    expect(await useMessageStore.getState().fetchAroundMessage("srv-1", "ch-1", "target")).toBe(true);
  });
});

describe("messageStore — leaving a jumped-to window", () => {
  it("sending while detached returns to the present and shows the sender's own message", async () => {
    await jumpIntoPast();

    const tail = deferred<APIResponse<MessagePage>>();
    getMessages.mockReturnValueOnce(tail.promise);
    const created = { ...makeMessage("mine"), created_at: "2026-01-02T00:00:00Z" };
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
    const live1 = { ...makeMessage("live-1"), created_at: "2026-01-02T00:00:01Z" };
    useMessageStore.getState().handleMessageCreate(live1);
    useMessageStore.getState().handleMessageCreate({ ...makeMessage("live-2"), created_at: "2026-01-02T00:00:02Z" });
    expect(useMessageStore.getState().messagesByChannel["ch-1"].map((m) => m.id)).toEqual([
      "old-1", "target", "old-3",
    ]);

    // Last forward page: includes live-1 (already persisted) but not live-2.
    getMessagesAfter.mockResolvedValueOnce(
      aroundPage([makeMessage("new-1"), live1], false, false)
    );
    await useMessageStore.getState().fetchNewerMessages("ch-1", "srv-1");

    const s = useMessageStore.getState();
    expect(getMessagesAfter).toHaveBeenCalledWith("srv-1", "ch-1", "old-3", expect.any(Number), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(s.hasMoreAfterByChannel["ch-1"]).toBe(false);
    expect(s.messagesByChannel["ch-1"].map((m) => m.id)).toEqual([
      "old-1", "target", "old-3", "new-1", "live-1", "live-2",
    ]);
  });
});

function numberedMessage(index: number): Message {
  // Identifiers are opaque and deliberately run against time order.
  const id = (10_000_000 - index).toString(16).padStart(16, "0");
  return { ...makeMessage(id), created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString() };
}
const reaction = [{ emoji: "👍", count: 1, users: ["reader"] }];
const state = () => useMessageStore.getState();
const rows = () => state().messagesByChannel["ch-1"];
const ids = (messages: Message[]) => messages.map((row) => row.id);

describe("channel history reconciliation", () => {
  it("reloads a disjoint 50-row tail, marks its newest row read and pages from its oldest", async () => {
    const all = Array.from({ length: 104 }, (_, index) => numberedMessage(index));
    getMessages.mockResolvedValueOnce(ok(all.slice(1, 51), true));
    await state().fetchMessages("ch-1", "srv-1");
    state().invalidateFetchedFlags();
    getMessages.mockResolvedValueOnce(ok(all.slice(54), true));
    await state().fetchMessages("ch-1", "srv-1");
    expect(ids(rows())).toEqual(ids(all.slice(54)));
    expect(markAsRead).toHaveBeenLastCalledWith("ch-1", all[103].id);
    getMessages.mockResolvedValueOnce(ok(all.slice(4, 54), true));
    await state().fetchOlderMessages("ch-1", "srv-1");
    expect(getMessages).toHaveBeenLastCalledWith("srv-1", "ch-1", all[54].id, 50, expect.anything());
    expect(ids(rows())).toEqual(ids(all.slice(4)));
  });

  it("preserves an overlapping older prefix and its has_more flag, removes missing rows inside the fresh page", async () => {
    const all = Array.from({ length: 54 }, (_, index) => numberedMessage(index));
    getMessages.mockResolvedValueOnce(ok(all.slice(0, 50)));
    await state().fetchMessages("ch-1", "srv-1");
    state().invalidateFetchedFlags();
    getMessages.mockResolvedValueOnce(ok(all.slice(3).filter((m) => m.id !== all[21].id), true));
    await state().fetchMessages("ch-1", "srv-1");
    expect(ids(rows())).toEqual(ids(all.filter((m) => m.id !== all[21].id)));
    expect(state().hasMoreByChannel["ch-1"]).toBe(false);
  });

  it("keeps edits, reactions and deletes received while a tail snapshot is pending", async () => {
    const [a, b, c, d] = [1, 2, 3, 4].map(numberedMessage);
    const response = deferred<APIResponse<MessagePage>>();
    getMessages.mockReturnValueOnce(response.promise);
    const pending = state().fetchMessages("ch-1", "srv-1");
    state().handleMessageCreate(d);
    state().handleMessageUpdate({ ...a, content: "latest" });
    state().handleMessageDelete({ channel_id: "ch-1", id: b.id });
    state().handleReactionUpdate({ channel_id: "ch-1", message_id: c.id, reactions: reaction });
    response.resolve(ok([a, b, { ...c, reply_to_id: b.id, referenced_message: {id:b.id, author:b.author, content:b.content} }]));
    await pending;
    expect(ids(rows())).toEqual(ids([a, c, d]));
    expect(rows()[0].content).toBe("latest");
    expect(rows()[1].reactions).toEqual(reaction);
    expect(rows()[1].referenced_message?.content).toBeNull();
  });

  it("folds detached edits, reactions, duplicate creates and deletes into the last page", async () => {
    await jumpIntoPast();
    const [edited, reacted, deleted] = [1, 2, 3].map(numberedMessage);
    for (const m of [edited, reacted, deleted]) state().handleMessageCreate(m);
    state().handleMessageUpdate({ ...edited, content: "latest" });
    state().handleMessageCreate(edited);
    state().handleReactionUpdate({ channel_id:"ch-1", message_id:reacted.id, reactions:reaction });
    const page = deferred<APIResponse<MessagePage>>();
    getMessagesAfter.mockReturnValueOnce(page.promise);
    const fetching = state().fetchNewerMessages("ch-1", "srv-1");
    state().handleMessageDelete({ channel_id:"ch-1", id:deleted.id });
    page.resolve(aroundPage([reacted, deleted], false, false));
    await fetching;
    expect(ids(rows()).slice(-2)).toEqual(ids([edited, reacted]));
    expect(rows().at(-2)?.content).toBe("latest");
    expect(rows().at(-1)?.reactions).toEqual(reaction);
  });

  it("ignores an old forward page after jump to present selects a new window", async () => {
    await jumpIntoPast();
    const oldPage = deferred<APIResponse<MessagePage>>();
    getMessagesAfter.mockReturnValueOnce(oldPage.promise);
    const paging = state().fetchNewerMessages("ch-1", "srv-1");
    getMessages.mockResolvedValueOnce(ok([numberedMessage(8)]));
    state().jumpToPresent("ch-1", "srv-1");
    await vi.waitFor(() => expect(ids(rows())).toEqual(ids([numberedMessage(8)])));
    oldPage.resolve(aroundPage([numberedMessage(2)], false, true));
    await paging;
    expect(ids(rows())).toEqual(ids([numberedMessage(8)]));
    expect(state().hasMoreAfterByChannel["ch-1"]).toBe(false);
  });

  it("drops denied history and late pages while keeping a different channel", async () => {
    await jumpIntoPast();
    state().handleMessageCreate(numberedMessage(2));
    state().handleMessageCreate(makeMessage("unrelated", "ch-2"));
    const old = deferred<APIResponse<MessagePage>>();
    getMessages.mockReturnValueOnce(old.promise);
    const older = state().fetchOlderMessages("ch-1", "srv-1");
    getMessagesAfter.mockResolvedValueOnce({success:false, status:403});
    await state().fetchNewerMessages("ch-1", "srv-1");
    old.resolve(ok([numberedMessage(1)]));
    await older;
    expect(rows()).toBeUndefined();
    expect(ids(state().messagesByChannel["ch-2"])).toEqual(["unrelated"]);
    getMessages.mockResolvedValueOnce(ok([numberedMessage(8)]));
    await state().fetchMessages("ch-1", "srv-1");
    expect(ids(rows())).toEqual(ids([numberedMessage(8)]));
  });

  it("an edit preserves explicit reactions even when the edit payload carries an empty list", async () => {
    const [visible, held] = [4, 5].map(numberedMessage);
    getMessagesAround.mockResolvedValueOnce(aroundPage([visible], true, true));
    await state().fetchAroundMessage("srv-1", "ch-1", visible.id);
    state().handleMessageCreate(held);
    for (const row of [visible, held]) {
      state().handleReactionUpdate({ channel_id:"ch-1", message_id:row.id, reactions:reaction });
      state().handleMessageUpdate({ ...row, content:"edited", reactions:[] });
    }
    expect(rows()[0].reactions).toEqual(reaction);
    getMessagesAfter.mockResolvedValueOnce(aroundPage([held], false, false));
    await state().fetchNewerMessages("ch-1", "srv-1");
    expect(rows().map((m) => m.reactions)).toEqual([reaction, reaction]);
    state().handleReactionUpdate({ channel_id:"ch-1", message_id:held.id, reactions:[] });
    expect(rows().at(-1)?.reactions).toEqual([]);
  });

  it("sorts live rows by database timestamp precision then opaque id across duplicate delivery", async () => {
    const a = { ...numberedMessage(2), created_at:"2026-01-01T00:00:00.123400Z" };
    const b = { ...numberedMessage(1), created_at:"2026-01-01T00:00:00.123400Z" };
    const c = { ...numberedMessage(3), created_at:"2026-01-01T00:00:00.123600Z" };
    getMessages.mockResolvedValueOnce(ok([c]));
    await state().fetchMessages("ch-1", "srv-1");
    for (const row of [b, a, b]) state().handleMessageCreate(row);
    expect(ids(rows())).toEqual(ids([a,b,c]));
  });

  it("revocation retires an in-flight decrypt and an authoritative regrant permits fresh history", async () => {
    const old = deferred<Message[]>();
    const stale = numberedMessage(2);
    getMessages.mockResolvedValueOnce(ok([stale]));
    decryptMock.mockReturnValueOnce(old.promise);
    const request = state().fetchMessages("ch-1", "srv-1");
    await vi.waitFor(() => expect(decryptMock).toHaveBeenCalledOnce());
    state().evictChannelHistory("ch-1");
    state().handleMessageCreate(stale);
    expect(rows()).toBeUndefined();
    getMessages.mockResolvedValueOnce(ok([numberedMessage(9)]));
    await state().fetchMessages("ch-1", "srv-1");
    old.resolve([stale]);
    await request;
    expect(ids(rows())).toEqual(ids([numberedMessage(9)]));
    expect(markAsRead).toHaveBeenLastCalledWith("ch-1", numberedMessage(9).id);
  });

  it.each(["tail fetch", "detached window"] as const)("keeps the newest edited_at when an older edit is replayed during a %s", async (mode) => {
    const row = numberedMessage(4);
    const response = deferred<APIResponse<MessagePage>>();
    let pending: Promise<void>;
    if (mode === "detached window") {
      await jumpIntoPast();
      state().handleMessageCreate(row);
      getMessagesAfter.mockReturnValueOnce(response.promise);
      pending = state().fetchNewerMessages("ch-1", "srv-1");
    } else {
      getMessages.mockReturnValueOnce(response.promise);
      pending = state().fetchMessages("ch-1", "srv-1");
    }
    state().handleMessageUpdate({ ...row, content: "latest", edited_at: "2026-01-02T00:00:00.123002Z" });
    state().handleMessageUpdate({ ...row, content: "replayed", edited_at: "2026-01-02T00:00:00.123001Z" });
    response.resolve(ok(mode === "tail fetch" ? [row] : []));
    await pending;

    expect(rows().find((message) => message.id === row.id)).toMatchObject({
      content: "latest", edited_at: "2026-01-02T00:00:00.123002Z",
    });
  });

  it("keeps the newer REST edit and source reactions when an older edit is replayed", async () => {
    const row = numberedMessage(4);
    const response = deferred<APIResponse<MessagePage>>();
    getMessages.mockReturnValueOnce(response.promise);
    const pending = state().fetchMessages("ch-1", "srv-1");
    state().handleMessageUpdate({ ...row, content: "older", edited_at: "2026-01-02T00:00:00.123001Z" });
    response.resolve(ok([{ ...row, content: "latest", edited_at: "2026-01-02T00:00:00.123002Z", reactions: reaction }]));
    await pending;
    expect(rows()[0]).toMatchObject({ content: "latest", reactions: reaction });
  });

  it("an out-of-window replay cannot move the before cursor across a history gap", async () => {
    const [oldRow, start, end] = [1, 54, 103].map(numberedMessage);
    const response = deferred<APIResponse<MessagePage>>();
    getMessages.mockReturnValueOnce(response.promise);
    const pending = state().fetchMessages("ch-1", "srv-1");
    state().handleMessageCreate(oldRow);
    response.resolve(ok([start, end], true));
    await pending;
    state().handleMessageCreate(oldRow);
    expect(ids(rows())).toEqual(ids([start, end]));
  });

  it("preserves cached rows across a transient refresh failure", async () => {
    await jumpIntoPast();
    state().invalidateFetchedFlags();
    getMessages.mockResolvedValueOnce({success:false, status:503});
    await state().fetchMessages("ch-1", "srv-1");
    expect(ids(rows())).toEqual(["old-1", "target", "old-3"]);
  });
});

// HICHAT_BENCH_CHANNEL_HISTORY=1 enables the reproducible hot-path measurement.
if (process.env.HICHAT_BENCH_CHANNEL_HISTORY === "1") {
  it("measures detached create processing and checks the complete merged window", async () => {
    for (const count of [1000, 5000, 10000]) {
      const live = Array.from({length: count}, (_, i) => numberedMessage(i + 10));
      const samples = [];
      for (let run = 0; run <= 9; run++) {
        resetStore();
        markAsRead.mockClear();
        await jumpIntoPast();
        const earlier = rows();
        const create = state().handleMessageCreate;
        const start = performance.now();
        for (const message of live) create(message);
        const duration = performance.now() - start;
        if (run > 0) samples.push(duration);
        // Everything below is outside the timed create loop, including validation.
        const edited = { ...live[count - 2], content: "edited while paging", edited_at: "2026-01-02T00:00:00Z" };
        const deleted = live[count - 1];
        state().handleReactionUpdate({ channel_id: "ch-1", message_id: edited.id, reactions: reaction });
        state().handleMessageUpdate(edited);
        state().handleMessageDelete({ channel_id: "ch-1", id: deleted.id });
        getMessagesAfter.mockResolvedValueOnce(aroundPage(live.slice(-2), false, false));
        await state().fetchNewerMessages("ch-1", "srv-1");

        const expected = [...earlier, ...live.slice(0, -2), { ...edited, reactions: reaction }];
        expect(ids(rows())).toEqual(ids(expected));
        expect(rows().map((row) => row.content)).toEqual(expected.map((row) => row.content));
        expect(rows().at(-1)?.reactions).toEqual(reaction);
        expect(markAsRead).not.toHaveBeenCalled();

        const response = deferred<APIResponse<MessagePage>>();
        state().invalidateFetchedFlags();
        getMessages.mockReturnValueOnce(response.promise);
        const reconnect = state().fetchMessages("ch-1", "srv-1");
        const latest = numberedMessage(count + 10);
        state().handleMessageCreate(latest);
        response.resolve(ok(expected.slice(-50), true));
        await reconnect;
        expect(ids(rows())).toEqual([...ids(expected), latest.id]);
        expect(rows().at(-1)?.content).toBe(latest.content);
        expect(markAsRead).toHaveBeenCalledExactlyOnceWith("ch-1", latest.id);
      }
      samples.sort((a, b) => a - b);
      console.info(`Detached creates ${count}: median ${samples[4].toFixed(2)} ms (${samples[0].toFixed(2)}–${samples[8].toFixed(2)})`);
    }
  }, 60000);
}
