/**
 * dmStore jump-to-message tests (real store, API + crypto mocked):
 *
 *   1. fetchMessagesAround claims the channel before its first await, so the
 *      freshly opened DM tab's mount-time fetchMessages is skipped instead of
 *      aborting the jump — the around window wins and contains the target.
 *   2. A missing target releases the claim and loads the tail.
 *   3. Sending while detached returns to the present AFTER the POST, so the
 *      refetch includes the sender's own message (DMs have no local insert).
 *   4. Live messages held back while detached merge when paging hits the tail.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../api/dm", () => ({
  getDMMessages: vi.fn(),
  getDMMessagesAround: vi.fn(),
  getDMMessagesAfter: vi.fn(),
  sendDMMessage: vi.fn(),
}));
vi.mock("../api/clientLog", () => ({ logToServer: vi.fn() }));
vi.mock("../crypto/dmEncryption", () => ({
  encryptDMMessage: vi.fn(),
  decryptDMMessages: vi.fn(async (msgs: unknown[]) => msgs),
  pushSentPlaintext: vi.fn(),
  discardLastSentPlaintext: vi.fn(),
  persistSentPlaintext: vi.fn(),
  cacheEditPlaintext: vi.fn(),
}));
vi.mock("../crypto/e2eePayload", () => ({ encodePayload: vi.fn((c: string) => c) }));
vi.mock("../crypto/fileEncryption", () => ({ encryptFile: vi.fn() }));
// vi.hoisted: the toast spy and e2ee state are read by hoisted factories (#67).
const hoisted = vi.hoisted(() => ({
  addToast: vi.fn(),
  e2ee: { initStatus: "ready", localDeviceId: null as string | null },
}));
vi.mock("./e2eeStore", () => ({
  useE2EEStore: { getState: () => hoisted.e2ee },
}));
vi.mock("./authStore", () => ({
  useAuthStore: { getState: () => ({ user: { id: "me" } }) },
}));
vi.mock("./uiStore", () => ({
  useUIStore: { getState: () => ({ closeDMTab: vi.fn() }) },
}));
vi.mock("./toastStore", () => ({
  useToastStore: { getState: () => ({ addToast: hoisted.addToast }) },
}));
vi.mock("../i18n", () => ({ default: { t: (k: string) => k } }));

import { useDMStore } from "./dmStore";
import * as dmApi from "../api/dm";
import { encryptDMMessage, discardLastSentPlaintext } from "../crypto/dmEncryption";
import type { APIResponse, DMMessage, DMMessagePage } from "../types";

const getDMMessages = vi.mocked(dmApi.getDMMessages);
const getAround = vi.mocked(dmApi.getDMMessagesAround);
const getAfter = vi.mocked(dmApi.getDMMessagesAfter);
const sendDM = vi.mocked(dmApi.sendDMMessage);

const CH = "dm-1";

function makeDM(id: string): DMMessage {
  return {
    id,
    dm_channel_id: CH,
    user_id: "u-2",
    content: `content ${id}`,
    edited_at: null,
    created_at: "2026-10-22T10:00:00Z",
    reply_to_id: null,
    is_pinned: false,
    author: { id: "u-2", username: "bob", display_name: null, avatar_url: null, status: "online", custom_status: null, created_at: "" },
    attachments: [],
    reactions: [],
    referenced_message: null,
    encryption_version: 0,
  };
}

function page(messages: DMMessage[], hasMore: boolean, hasMoreAfter?: boolean): APIResponse<DMMessagePage> {
  return { success: true, data: { messages, has_more: hasMore, has_more_after: hasMoreAfter } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const ids = () => (useDMStore.getState().messagesByChannel[CH] ?? []).map((m) => m.id);

beforeEach(() => {
  useDMStore.getState().invalidateFetchCache();
  useDMStore.setState({
    channels: [],
    messagesByChannel: {},
    hasMoreByChannel: {},
    hasMoreAfterByChannel: {},
    isLoadingMessages: false,
  });
  vi.clearAllMocks();
  hoisted.e2ee.localDeviceId = null;
});

async function jumpIntoPast() {
  getAround.mockResolvedValueOnce(page([makeDM("old-1"), makeDM("target")], true, true));
  expect(await useDMStore.getState().fetchMessagesAround(CH, "target")).toBe(true);
}

describe("dmStore — fetchMessagesAround vs mount-time fetchMessages race", () => {
  it("skips fetchMessages while the jump is in flight; the around window wins", async () => {
    const around = deferred<APIResponse<DMMessagePage>>();
    getAround.mockReturnValueOnce(around.promise);

    const jumping = useDMStore.getState().fetchMessagesAround(CH, "target");
    await useDMStore.getState().fetchMessages(CH);
    expect(getDMMessages).not.toHaveBeenCalled();

    around.resolve(page([makeDM("a-1"), makeDM("target")], true, true));
    expect(await jumping).toBe(true);
    expect(ids()).toEqual(["a-1", "target"]);
    expect(useDMStore.getState().hasMoreAfterByChannel[CH]).toBe(true);
    expect(useDMStore.getState().isLoadingMessages).toBe(false);
  });

  it("releases the claim when the target is gone and loads the tail", async () => {
    getAround.mockResolvedValueOnce({ success: false, status: 404, error: "not found" });
    getDMMessages.mockResolvedValueOnce(page([makeDM("tail-1")], false));

    expect(await useDMStore.getState().fetchMessagesAround(CH, "gone")).toBe(false);
    await vi.waitFor(() => expect(ids()).toEqual(["tail-1"]));
  });
});

describe("dmStore — leaving a jumped-to window", () => {
  it("sending while detached refetches the tail after the POST so the own message shows", async () => {
    await jumpIntoPast();
    sendDM.mockResolvedValueOnce({ success: true, data: makeDM("mine") });
    // The echo arrives before the HTTP response and is held back (detached).
    useDMStore.getState().handleDMMessageCreate(makeDM("mine"));
    getDMMessages.mockResolvedValueOnce(page([makeDM("t-1"), makeDM("mine")], true));

    expect(await useDMStore.getState().sendMessage(CH, "hello")).toBe(true);
    expect(useDMStore.getState().hasMoreAfterByChannel[CH]).toBe(false);
    await vi.waitFor(() => expect(ids()).toEqual(["t-1", "mine"]));
    expect(getDMMessages).toHaveBeenCalledTimes(1);
  });

  it("merges held live messages when forward paging reaches the tail", async () => {
    await jumpIntoPast();
    useDMStore.getState().handleDMMessageCreate(makeDM("live-1"));
    expect(ids()).toEqual(["old-1", "target"]);

    getAfter.mockResolvedValueOnce(page([makeDM("new-1")], false, false));
    await useDMStore.getState().fetchNewerMessages(CH);
    expect(getAfter).toHaveBeenCalledWith(CH, "target", 50);
    expect(ids()).toEqual(["old-1", "target", "new-1", "live-1"]);
    expect(useDMStore.getState().hasMoreAfterByChannel[CH]).toBe(false);
  });
});

describe("dmStore — encrypted self-DM send failure", () => {
  it("SELF_FANOUT_UNAVAILABLE shows the encryption-failed toast and never sends plaintext", async () => {
    hoisted.e2ee.localDeviceId = "dev-local";
    useDMStore.setState({
      channels: [{ id: CH, e2ee_enabled: true, other_user: { id: "me" } }] as never,
    });
    vi.mocked(encryptDMMessage).mockRejectedValueOnce(new Error("SELF_FANOUT_UNAVAILABLE"));

    expect(await useDMStore.getState().sendMessage(CH, "secret note")).toBe(false);

    expect(sendDM).not.toHaveBeenCalled();
    expect(hoisted.addToast).toHaveBeenCalledWith("error", "e2ee:encryptionFailed");
    // Encryption failed before this send queued anything, so it must not
    // discard another in-flight send's queue entry.
    expect(discardLastSentPlaintext).not.toHaveBeenCalled();
  });
});
