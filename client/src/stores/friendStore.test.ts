/**
 * friendStore — live presence on friend / request rows.
 *
 * `user_status` on FriendshipWithUser used to be frozen at fetch time; the
 * friends page showed whatever GET /api/friends returned until the next
 * refetch. handlePresenceUpdate (fed by presenceStore from `presence_update`)
 * patches every row for that user. When no row matches (or nothing changes)
 * the state reference must be kept so selectors don't re-render.
 *
 * Real store, mocked API module (pattern: memberStore.test.ts).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../api/friends", () => ({
  listFriends: vi.fn(async () => ({ success: true, data: [] })),
  listRequests: vi.fn(async () => ({ success: true, data: { incoming: [], outgoing: [] } })),
  sendRequest: vi.fn(),
  acceptRequest: vi.fn(),
  declineRequest: vi.fn(),
  removeFriend: vi.fn(),
}));

import { useFriendStore } from "./friendStore";
import * as friendsApi from "../api/friends";
import type { FriendshipWithUser } from "../types";

function makeRow(overrides: Partial<FriendshipWithUser> = {}): FriendshipWithUser {
  return {
    id: "f-1",
    status: "accepted",
    created_at: "2025-01-01T00:00:00Z",
    user_id: "u-1",
    username: "alice",
    display_name: "Alice",
    avatar_url: null,
    user_status: "offline",
    user_custom_status: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useFriendStore.setState({ friends: [], incoming: [], outgoing: [], isLoading: false });
});

describe("friendStore.handlePresenceUpdate", () => {
  it("updates user_status on the matching friend row", () => {
    useFriendStore.setState({ friends: [makeRow(), makeRow({ id: "f-2", user_id: "u-2" })] });

    useFriendStore.getState().handlePresenceUpdate("u-1", "online");

    const { friends } = useFriendStore.getState();
    expect(friends[0].user_status).toBe("online");
    expect(friends[1].user_status).toBe("offline");
  });

  it("also patches incoming and outgoing request rows", () => {
    useFriendStore.setState({
      incoming: [makeRow({ id: "r-in", status: "pending" })],
      outgoing: [makeRow({ id: "r-out", status: "pending" })],
    });

    useFriendStore.getState().handlePresenceUpdate("u-1", "dnd");

    const { incoming, outgoing } = useFriendStore.getState();
    expect(incoming[0].user_status).toBe("dnd");
    expect(outgoing[0].user_status).toBe("dnd");
  });

  it("keeps the same list references when no row matches", () => {
    const friends = [makeRow()];
    const incoming = [makeRow({ id: "r-in", user_id: "u-9", status: "pending" })];
    useFriendStore.setState({ friends, incoming });

    useFriendStore.getState().handlePresenceUpdate("u-unknown", "online");

    const state = useFriendStore.getState();
    expect(state.friends).toBe(friends);
    expect(state.incoming).toBe(incoming);
  });

  it("keeps the same reference when the status is unchanged", () => {
    const friends = [makeRow({ user_status: "idle" })];
    useFriendStore.setState({ friends });

    useFriendStore.getState().handlePresenceUpdate("u-1", "idle");

    expect(useFriendStore.getState().friends).toBe(friends);
  });
});

describe("friendStore.sendRequest", () => {
  it("returns the created friendship (target row) on success", async () => {
    const row = makeRow({ id: "f-new", status: "pending", user_id: "u-target" });
    vi.mocked(friendsApi.sendRequest).mockResolvedValueOnce({ success: true, data: row });

    const res = await useFriendStore.getState().sendRequest("alice");

    expect(res).toEqual({ success: true, friendship: row });
    expect(useFriendStore.getState().outgoing[0]).toBe(row);
  });

  it("puts a mutually auto-accepted row straight into friends", async () => {
    const row = makeRow({ id: "f-mutual", status: "accepted", user_id: "u-target" });
    vi.mocked(friendsApi.sendRequest).mockResolvedValueOnce({ success: true, data: row });

    const res = await useFriendStore.getState().sendRequest("alice");

    expect(res.friendship?.user_id).toBe("u-target");
    expect(useFriendStore.getState().friends[0]).toBe(row);
    expect(useFriendStore.getState().outgoing).toHaveLength(0);
  });

  it("surfaces the API error without a friendship on failure", async () => {
    vi.mocked(friendsApi.sendRequest).mockResolvedValueOnce({ success: false, error: "nope" });

    const res = await useFriendStore.getState().sendRequest("alice");

    expect(res).toEqual({ success: false, error: "nope" });
  });
});
