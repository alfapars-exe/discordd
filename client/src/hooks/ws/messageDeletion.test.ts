import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { handleChannelEvent } from "./channelEventHandlers";
import { handleDMEvent } from "./dmEventHandlers";
import { useMessageStore } from "../../stores/messageStore";
import { useDMStore } from "../../stores/dmStore";
import { useReadStateStore } from "../../stores/readStateStore";
import { useAuthStore } from "../../stores/authStore";
import { publishAuthOwnerChange } from "../../api/authSessionEvents";
import { deleteCachedChannelMessage, deleteCachedDMMessage } from "../../crypto/keyStorage";
import type { WSMessage } from "../../types";

vi.mock("../../crypto/keyStorage", async importOriginal => ({
  ...await importOriginal<typeof import("../../crypto/keyStorage")>(),
  deleteCachedChannelMessage: vi.fn(async () => true),
  deleteCachedDMMessage: vi.fn(async () => true),
}));

const stops: (() => void)[] = [];
beforeEach(() => {
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
afterEach(() => { for (const stop of stops.splice(0)) stop(); vi.restoreAllMocks(); });

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

  it(`${kind}: cleans cache after a committed deletion observer throws, preserving the failure`, async () => {
    const failure = new Error("deletion observer");
    observeDeletion(() => { throw failure; });
    await expect(deliver()).rejects.toBe(failure);
    expect(cleanup()).toHaveBeenCalledExactlyOnceWith("deleted", "room", expect.any(Function));
    expect(cleanup().mock.calls[0][2]()).toBe(true);
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
}
