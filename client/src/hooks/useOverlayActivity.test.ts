import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { clearTokens, getAuthGeneration } from "../api/client";
import { useAuthStore } from "../stores/authStore";
import { useBlockStore } from "../stores/blockStore";
import { useFriendStore } from "../stores/friendStore";
import { useGameActivityStore } from "../stores/gameActivityStore";
import { usePresenceStore } from "../stores/presenceStore";
import { useOverlayActivity } from "./useOverlayActivity";

const game = { id: "example-game", name: "Example Game", started_at: "2026-10-25T09:00:00Z" };
beforeEach(() => {
  clearTokens();
  useAuthStore.setState({ user: { id: "viewer" } as never });
  useGameActivityStore.getState().start("epoch-a");
  useBlockStore.setState({ blockedUserIds: [] });
  usePresenceStore.setState({ statusByUserId: {} });
  useFriendStore.setState({ ownerId: "viewer", authGeneration: getAuthGeneration(), friendsStatus: "ready", friends: [{ id: "relationship", status: "accepted", user_id: "friend", username: "friend", display_name: "Friend", avatar_url: null, user_status: "online", user_custom_status: null, created_at: "2026-10-25T08:00:00Z" }] });
});
afterEach(cleanup);
it("subscribes to grant, block, presence and revocation changes without reusing server grants", () => {
  const view = renderHook(useOverlayActivity);
  act(() => useGameActivityStore.getState().apply({ epoch: "epoch-a", user_id: "friend", server_id: "private-server", game, revision: 1 }));
  expect(view.result.current).toEqual([]);
  act(() => useGameActivityStore.getState().apply({ epoch: "epoch-a", user_id: "friend", game, revision: 1 }));
  expect(view.result.current).toEqual([{ userId: "friend", label: "Friend", gameName: "Example Game" }]);
  act(() => useBlockStore.setState({ blockedUserIds: ["friend"] }));
  expect(view.result.current).toEqual([]);
  act(() => useBlockStore.setState({ blockedUserIds: [] }));
  act(() => usePresenceStore.setState({ statusByUserId: { friend: "offline" } }));
  expect(view.result.current).toEqual([]);
  act(() => usePresenceStore.setState({ statusByUserId: { friend: "online" } }));
  act(() => useGameActivityStore.getState().apply({ epoch: "epoch-a", user_id: "friend", game: null, revision: 2 }));
  expect(view.result.current).toEqual([]);
});
it("clears the projection on account replacement and connection epoch reset", () => {
  useGameActivityStore.getState().apply({ epoch: "epoch-a", user_id: "friend", game, revision: 1 });
  const view = renderHook(useOverlayActivity);
  expect(view.result.current).toHaveLength(1);
  act(() => useAuthStore.setState({ user: { id: "different-viewer" } as never }));
  expect(view.result.current).toEqual([]);
  act(() => useAuthStore.setState({ user: { id: "viewer" } as never }));
  act(() => useGameActivityStore.getState().clear());
  expect(view.result.current).toEqual([]);
});
it("suppresses cached rows immediately while disconnected and waits for a new ready epoch", () => {
  useGameActivityStore.getState().apply({ epoch: "epoch-a", user_id: "friend", game, revision: 1 });
  const view = renderHook(({ connected }) => useOverlayActivity(true, connected), { initialProps: { connected: true } });
  expect(view.result.current).toHaveLength(1);
  view.rerender({ connected: false });
  expect(view.result.current).toEqual([]);
  // useGameActivity clears the store on disconnect; ready starts a fresh epoch.
  act(() => useGameActivityStore.getState().clear());
  view.rerender({ connected: true });
  expect(view.result.current).toEqual([]);
  act(() => useGameActivityStore.getState().start("epoch-b"));
  act(() => useGameActivityStore.getState().apply({ epoch: "epoch-a", user_id: "friend", game, revision: 2 }));
  expect(view.result.current).toEqual([]);
});

it("immediately hides cached activity when relationship provenance alone changes, then honors revocation while unavailable",()=>{
 useGameActivityStore.getState().apply({epoch:"epoch-a",user_id:"friend",game,revision:1});const friends=useFriendStore.getState().friends;const view=renderHook(useOverlayActivity);expect(view.result.current).toHaveLength(1);
 for(const patch of [{friendsStatus:"loading" as const},{friendsStatus:"error" as const},{friendsStatus:"ready" as const,ownerId:"other"},{ownerId:"viewer",authGeneration:getAuthGeneration()+1}]){act(()=>useFriendStore.setState(patch));expect(useFriendStore.getState().friends).toBe(friends);expect(view.result.current).toEqual([])}
 act(()=>useGameActivityStore.getState().apply({epoch:"epoch-a",user_id:"friend",game:null,revision:2}));act(()=>useFriendStore.setState({ownerId:"viewer",authGeneration:getAuthGeneration(),friendsStatus:"ready"}));expect(view.result.current).toEqual([]);
 act(()=>useGameActivityStore.getState().apply({epoch:"epoch-a",user_id:"friend",game,revision:1}));expect(view.result.current).toEqual([]);
 act(()=>useGameActivityStore.getState().apply({epoch:"epoch-a",user_id:"friend",game,revision:3}));expect(view.result.current).toHaveLength(1);act(()=>useFriendStore.setState({friends:[]}));expect(view.result.current).toEqual([]);
});
