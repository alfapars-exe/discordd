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
import {useBlockStore} from "./blockStore";
import {useAuthStore} from "./authStore";

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
  useAuthStore.setState({user:{id:"owner"} as never});
  useBlockStore.setState({blockedUserIds:[]});
  vi.clearAllMocks();
  useFriendStore.setState({ friends: [], incoming: [], outgoing: [], isLoading: false });
});

it("uses canonical state for a late accept after reverse block",async()=>{
  const row=makeRow();
  useFriendStore.getState().handleFriendRemove({user_id:row.user_id});
  useFriendStore.getState().handleFriendRequestAccept(row);
  await vi.waitFor(()=>expect(friendsApi.listFriends).toHaveBeenCalledOnce());
  expect(useFriendStore.getState().friends).toEqual([]);
});
it("rejects a list snapshot invalidated by a newer removal",async()=>{
  const row=makeRow();let finish!:(result:{success:boolean;data:FriendshipWithUser[]})=>void;
  vi.mocked(friendsApi.listFriends).mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
  const pending=useFriendStore.getState().fetchFriends();
  useFriendStore.getState().handleFriendRemove({user_id:row.user_id});
  finish({success:true,data:[row]});await pending;
  expect(useFriendStore.getState().friends).toEqual([]);
});

it("does not resurrect an own-blocked peer from late request/accept events",()=>{
  const row=makeRow({user_id:"blocked-peer"});
  useFriendStore.setState({friends:[row],incoming:[row],outgoing:[row]});
  useBlockStore.setState({blockedUserIds:[row.user_id]});
  useFriendStore.getState().handleFriendRemove({user_id:row.user_id});
  useFriendStore.getState().handleFriendRequestCreate(row);
  useFriendStore.getState().handleFriendRequestAccept(row);
  expect(useFriendStore.getState().friends).toEqual([]);
  expect(useFriendStore.getState().incoming).toEqual([]);
  expect(useFriendStore.getState().outgoing).toEqual([]);
});
it("filters a late accepted response after a local block",async()=>{
  const row=makeRow({user_id:"blocked-peer"});
  vi.mocked(friendsApi.acceptRequest).mockImplementationOnce(async()=>{
    useBlockStore.setState({blockedUserIds:[row.user_id]});return {success:true,data:row};
  });
  expect(await useFriendStore.getState().acceptRequest(row.id)).toBe(false);
  expect(useFriendStore.getState().friends).toEqual([]);
});
it("does not restore a peer from HTTP acceptance after a reverse removal",async()=>{
  const row=makeRow();
  vi.mocked(friendsApi.acceptRequest).mockImplementationOnce(async()=>{
    useFriendStore.getState().handleFriendRemove({user_id:row.user_id});return {success:true,data:row};
  });
  expect(await useFriendStore.getState().acceptRequest(row.id)).toBe(false);
  expect(useFriendStore.getState().friends).toEqual([]);
});
it("ignores HTTP mutation success after account switching",async()=>{
  const row=makeRow();
  vi.mocked(friendsApi.sendRequest).mockImplementationOnce(async()=>{
    useAuthStore.setState({user:{id:"another"} as never});return {success:true,data:row};
  });
  expect(await useFriendStore.getState().sendRequest("alice")).toEqual({success:false,error:"request_cancelled"});
  expect(useFriendStore.getState().friends).toEqual([]);expect(useFriendStore.getState().outgoing).toEqual([]);
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
