import { describe, expect, it } from "vitest";
import { onlySelfDMChannelsAdded, mergeDMChannelUnreadCounts, retainSelfDMChannels } from "./dmChannelSnapshot";

const channel = (id: string, owner = "peer", unread_count = 0) => Object.freeze({
  id, other_user: Object.freeze({ id: owner }), unread_count,
});

describe("DM channel snapshot reconciliation", () => {
  const initial = channel("peer");
  it.each([
    { name: "unchanged references", current: [initial], accepted: true },
    { name: "new self channel", current: [initial, channel("notes", "me")], accepted: true },
    { name: "replaced metadata", current: [channel("peer")], accepted: false },
    { name: "self channel replacing the initial peer", current: [channel("notes", "me")], accepted: false },
    { name: "removed initial channel", current: [], accepted: false },
    { name: "new foreign channel", current: [initial, channel("new")], accepted: false },
  ])("classifies $name while a list is pending", ({ current, accepted }) => {
    expect(onlySelfDMChannelsAdded(Object.freeze([initial]), Object.freeze(current), "me")).toBe(accepted);
  });

  it("rejects replacement of an initial self-channel row even for the same owner", () => {
    expect(onlySelfDMChannelsAdded([channel("notes", "me")], [channel("notes", "me")], "me")).toBe(false);
  });

  it("keeps local unread changes and explicit zero while removing a newly read count", () => {
    const listed = Object.freeze([
      channel("read", "peer", 4), channel("changed", "peer", 2),
      channel("unchanged", "peer", 8), channel("remote", "peer", 5),
      channel("zero", "peer", 0), channel("negative", "peer", -1),
    ]);
    const before = Object.freeze({ read: 3, changed: 1, unlisted: 2, unchanged: 7 });
    const current = Object.freeze({ changed: 9, unlisted: 0, unchanged: 7, added: 11 });
    expect(mergeDMChannelUnreadCounts(listed, before, current)).toEqual({
      changed: 9, unlisted: 0, unchanged: 8, remote: 5, added: 11,
    });
    expect(before.read).toBe(3);
    expect(listed[0].unread_count).toBe(4);
  });

  it("retains server order and row identity, then appends each missing self channel once", () => {
    const server = channel("listed", "me");
    const notes = channel("notes", "me");
    const second = channel("second", "me");
    const listed = Object.freeze([server]);
    const current = Object.freeze([channel("listed", "me"), notes, channel("notes", "me"), channel("foreign"), second]);
    const result = retainSelfDMChannels(listed, current, "me");
    expect(result).toEqual([server, notes, second]);
    expect(result[0]).toBe(server);
    expect(result[1]).toBe(notes);
    expect(result).not.toBe(listed);
    expect(current).toHaveLength(5);
  });

  it("does not retain foreign self-like channels without the captured owner", () => {
    expect(onlySelfDMChannelsAdded([], [channel("notes", "me")], null)).toBe(false);
    expect(retainSelfDMChannels([], [channel("notes", "me")], null)).toEqual([]);
  });
});
