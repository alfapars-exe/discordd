import "fake-indexeddb/auto";
import { IDBFactory as FakeIDBFactory } from "fake-indexeddb";

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { handleChannelEvent } from "./channelEventHandlers";
import { handleDMEvent } from "./dmEventHandlers";
import { useMessageStore } from "../../stores/messageStore";
import { useDMStore } from "../../stores/dmStore";
import { useReadStateStore } from "../../stores/readStateStore";
import { useAuthStore } from "../../stores/authStore";
import { publishAuthOwnerChange } from "../../api/authSessionEvents";
import { deleteCachedChannelMessage, deleteCachedDMMessage, cacheDecryptedMessage, getCachedDecryptedMessage, closeDB } from "../../crypto/keyStorage";
import type { WSMessage } from "../../types";
import { waitForCachedMessageDeletions } from "../../crypto/cachedMessageDeletions";

vi.mock("../../crypto/keyStorage", async importOriginal => ({
  ...await importOriginal<typeof import("../../crypto/keyStorage")>(),
  deleteCachedChannelMessage: vi.fn(async () => true),
  deleteCachedDMMessage: vi.fn(async () => true),
}));

const stops: (() => void)[] = [];
beforeEach(async () => {
  await closeDB();
  globalThis.indexedDB = new FakeIDBFactory();
  vi.clearAllMocks();
  vi.mocked(deleteCachedChannelMessage).mockReset().mockResolvedValue(true);
  vi.mocked(deleteCachedDMMessage).mockReset().mockResolvedValue(true);
  publishAuthOwnerChange("alice");
  useAuthStore.setState({ user: { id: "alice" } as never });
  useMessageStore.setState({ lastDeleted: null, messagesByChannel: {},
    handleMessageDelete: value => useMessageStore.setState({ lastDeleted: value }) });
  useReadStateStore.setState({ unreadCounts: {} });
  useDMStore.setState({ lastDeletedDM: null, dmUnreadCounts: {}, messagesByChannel: {},
    handleDMMessageDelete: value => useDMStore.setState({ lastDeletedDM: value }) });
});
afterEach(async () => { for (const stop of stops.splice(0)) stop(); vi.restoreAllMocks(); await closeDB(); });

it("HTTP DM deletion evicts actual cached plaintext after its committed notification throws", async () => {
  const api = await import("../../api/dm");
  vi.spyOn(api, "deleteDMMessage").mockResolvedValueOnce({ success: true, data: { id: "deleted", dm_channel_id: "room", message: "deleted" } });
  const storage = await vi.importActual<typeof import("../../crypto/keyStorage")>("../../crypto/keyStorage");
  vi.mocked(deleteCachedDMMessage).mockImplementation(storage.deleteCachedDMMessage);
  await cacheDecryptedMessage({ messageId: "deleted", channelId: "", dmChannelId: "room", content: "deleted plaintext", timestamp: 10 });
  await cacheDecryptedMessage({ messageId: "retained", channelId: "", dmChannelId: "room", content: "retained plaintext", timestamp: 11 });
  stops.push(useDMStore.subscribe((next, previous) => {
    if (next.lastDeletedDM !== previous.lastDeletedDM) throw new Error("committed HTTP notification failed");
  }));
  expect(await useDMStore.getState().deleteMessage("deleted")).toBe(false);
  expect(await getCachedDecryptedMessage("deleted")).toBeNull();
  expect((await getCachedDecryptedMessage("retained"))?.content).toBe("retained plaintext");
  await waitForCachedMessageDeletions("dm", "room");
});

for (const kind of ["channel", "dm"] as const) {
  const event = { op: kind === "channel" ? "message_delete" : "dm_message_delete",
    d: kind === "channel" ? { id: "deleted", channel_id: "room" } : { id: "deleted", dm_channel_id: "room" } } as WSMessage;
  const deliver = () => kind === "channel" ? handleChannelEvent(event) : handleDMEvent(event);
  const cleanup = () => vi.mocked(kind === "channel" ? deleteCachedChannelMessage : deleteCachedDMMessage);
  const observeDeletion = (callback: () => void) => {
    stops.push(kind === "channel"
      ? useMessageStore.subscribe((next, previous) => { if (next.lastDeleted !== previous.lastDeleted) callback(); })
      : useDMStore.subscribe((next, previous) => { if (next.lastDeletedDM !== previous.lastDeletedDM) callback(); }));
  };

  it(`${kind}: reserves cleanup before store observers can start a replacement query`, async () => {
    let release!: (value: boolean) => void;
    cleanup().mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    const started = vi.fn(); let query: Promise<void> | undefined;
    observeDeletion(() => { query = waitForCachedMessageDeletions(kind, "room").then(started); });
    const deletion = deliver();
    await Promise.resolve(); await Promise.resolve();
    const premature = started.mock.calls.length;
    release(true); await deletion; await query;
    expect(premature).toBe(0);
    expect(started).toHaveBeenCalledOnce();
  });

  it(`${kind}: cleans cache after a committed deletion observer throws, preserving the failure`, async () => {
    const failure = new Error("deletion observer");
    observeDeletion(() => { throw failure; });
    await expect(deliver()).rejects.toBe(failure);
    expect(cleanup()).toHaveBeenCalledExactlyOnceWith("deleted", "room", expect.any(Function));
    expect(cleanup().mock.calls[0][2]()).toBe(true);
    await waitForCachedMessageDeletions(kind, "room");
  });

  it(`${kind}: does not clean a replacement account after an observer retires ownership`, async () => {
    const failure = new Error("retired deletion observer");
    observeDeletion(() => {
      publishAuthOwnerChange("bob");
      useAuthStore.setState({ user: { id: "bob" } as never });
      throw failure;
    });
    await expect(deliver()).rejects.toBe(failure);
    expect(cleanup()).not.toHaveBeenCalled();
  });

  it(`${kind}: publishes deletion and cleans cache even if unread notification throws`, async () => {
    const failure = new Error("unread observer");
    if (kind === "channel") {
      useMessageStore.setState({ messagesByChannel: { room: [{ id: "deleted", user_id: "peer" } as never] } });
      useReadStateStore.setState({ unreadCounts: { room: 3 }, decrementUnread: () => { throw failure; } });
    } else {
      useDMStore.setState({ dmUnreadCounts: { room: 3 }, messagesByChannel: { room: [{ id: "deleted", user_id: "peer" } as never] },
        decrementDMUnread: () => { throw failure; } });
    }
    const published = vi.fn(); observeDeletion(published);
    await expect(deliver()).rejects.toBe(failure);
    expect(published).toHaveBeenCalledOnce();
    expect(cleanup()).toHaveBeenCalledOnce();
  });

  it(`${kind}: preserves notification failure when cache cleanup also fails`, async () => {
    const failure = new Error("notification failure");
    cleanup().mockRejectedValueOnce(new Error("private cache failure detail"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    observeDeletion(() => { throw failure; });
    await expect(deliver()).rejects.toBe(failure);
    expect(warn).toHaveBeenCalledExactlyOnceWith(kind === "channel"
      ? "[ws] Channel deleted-message cache cleanup failed" : "[ws] DM deleted-message cache cleanup failed");
  });

  it(`${kind}: skips an obsolete connection before publishing deletion`, async () => {
    const published = vi.fn(); observeDeletion(published);
    const result = kind === "channel" ? handleChannelEvent(event, () => false) : handleDMEvent(event, () => false);
    await expect(result).resolves.toBe(true);
    expect(published).not.toHaveBeenCalled();
    expect(cleanup()).not.toHaveBeenCalled();
  });

  it(`${kind}: retains both notification failures after completing cache cleanup`, async () => {
    const unreadFailure = new Error("unread failure"), deletionFailure = new Error("deletion failure");
    if (kind === "channel") {
      useMessageStore.setState({ messagesByChannel: { room: [{ id: "deleted", user_id: "peer" } as never] } });
      useReadStateStore.setState({ unreadCounts: { room: 3 }, decrementUnread: () => { throw unreadFailure; } });
    } else {
      useDMStore.setState({ dmUnreadCounts: { room: 3 }, messagesByChannel: { room: [{ id: "deleted", user_id: "peer" } as never] },
        decrementDMUnread: () => { throw unreadFailure; } });
    }
    observeDeletion(() => { throw deletionFailure; });
    await expect(deliver()).rejects.toMatchObject({
      name: "AggregateError", errors: [unreadFailure, deletionFailure], cause: deletionFailure,
    });
    expect(cleanup()).toHaveBeenCalledOnce();
  });

  it(`${kind}: removes actual cached plaintext despite a committed store observer failure`, async () => {
    const storage = await vi.importActual<typeof import("../../crypto/keyStorage")>("../../crypto/keyStorage");
    if (kind === "channel") vi.mocked(deleteCachedChannelMessage).mockImplementation(storage.deleteCachedChannelMessage);
    else vi.mocked(deleteCachedDMMessage).mockImplementation(storage.deleteCachedDMMessage);
    const row = { messageId: "deleted", channelId: kind === "channel" ? "room" : "",
      dmChannelId: kind === "dm" ? "room" : null, content: "deleted plaintext", timestamp: 10 };
    const retained = { ...row, messageId: "retained", content: "unrelated plaintext" };
    await cacheDecryptedMessage(row); await cacheDecryptedMessage(retained);
    const failure = new Error("committed notification failed");
    observeDeletion(() => { throw failure; });
    await expect(deliver()).rejects.toBe(failure);
    expect(await getCachedDecryptedMessage("deleted")).toBeNull();
    expect(await getCachedDecryptedMessage("retained")).toEqual(retained);
  });

  it(`${kind}: does not guess an unread decrement for an unloaded deletion`, async () => {
    const decrement = vi.fn();
    if (kind === "channel") useReadStateStore.setState({ unreadCounts: { room: 3 }, decrementUnread: decrement });
    else useDMStore.setState({ dmUnreadCounts: { room: 3 }, decrementDMUnread: decrement });
    await deliver();
    expect(decrement).not.toHaveBeenCalled();
  });

  it(`${kind}: does not decrement unread again when notification failure causes redelivery`, async () => {
    const decrement = vi.fn(), failure = new Error("first publication failed");
    if (kind === "channel") {
      useReadStateStore.setState({ unreadCounts: { room: 3 }, decrementUnread: decrement });
      useMessageStore.setState({ messagesByChannel: { room: [{ id: "deleted", user_id: "peer" } as never] },
        handleMessageDelete: value => useMessageStore.setState({ lastDeleted: value, messagesByChannel: {} }) });
    } else {
      useDMStore.setState({ dmUnreadCounts: { room: 3 }, decrementDMUnread: decrement,
        messagesByChannel: { room: [{ id: "deleted", user_id: "peer" } as never] },
        handleDMMessageDelete: value => useDMStore.setState({ lastDeletedDM: value, messagesByChannel: {} }) });
    }
    const listener = vi.fn().mockImplementationOnce(() => { throw failure; });
    observeDeletion(listener);
    await expect(deliver()).rejects.toBe(failure);
    await expect(deliver()).resolves.toBe(true);
    expect(decrement).toHaveBeenCalledOnce();
  });
}
