import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  owner: "viewer" as string | null, generation: 1, enabled: true, compatibility:false,
  target: { type: "text", channelId: "channel", label: "Channel", serverInfo: { serverId: "server", serverName: "Server", serverIconUrl: null } } as
    | { type: "text"; channelId: string; label: string; serverInfo: { serverId: string; serverName: string; serverIconUrl: null } }
    | { type: "dm"; channelId: string }
    | { type: "group-dm"; channelId: string }
    | null,
  receive: undefined as ((value: { session: string }) => void) | undefined,
  confirm: vi.fn<(session: string) => Promise<boolean>>(), navigate: vi.fn(), unsubscribe: vi.fn(),
}));
vi.mock("../api/authSessionEvents", () => ({ getAuthSessionSnapshot: () => ({ ownerId: state.owner, generation: state.generation }) }));
vi.mock("../stores/authStore", () => ({ useAuthStore: Object.assign((pick: (s: unknown) => unknown) => pick({ user: state.owner ? { id: state.owner } : null }), { getState: () => ({ user: state.owner ? { id: state.owner } : null }) }) }));
vi.mock("../stores/voiceStore", () => {
  const snapshot = () => ({ voiceOverlayCompatibility:state.compatibility, voiceOverlayEnabled: state.enabled, voiceOverlayChat: state.enabled, voiceOverlayChatActions: state.enabled });
  return { useVoiceStore: Object.assign((pick: (s: unknown) => unknown) => pick(snapshot()), { getState: snapshot }) };
});
vi.mock("../stores/uiStore", () => ({ useUIStore: Object.assign((pick: (s: unknown) => unknown) => pick({ destination: state.target }), { getState: () => ({ navigate: state.navigate }) }) }));
vi.mock("../utils/overlayChatAccess", () => ({ getLiveOverlayChatTarget: () => state.target }));
import { useOverlayChatActions } from "./useOverlayChatActions";

beforeEach(() => {
  state.owner = "viewer"; state.generation = 1; state.enabled = true; state.compatibility=false;
  state.target = { type: "text", channelId: "channel", label: "Channel", serverInfo: { serverId: "server", serverName: "Server", serverIconUrl: null } };
  state.receive = undefined; state.confirm.mockReset().mockResolvedValue(true); state.navigate.mockReset(); state.unsubscribe.mockReset();
  Object.defineProperty(window, "electronAPI", { configurable: true, value: {
    onOverlayOpenChat: (callback: typeof state.receive) => { state.receive = callback; return state.unsubscribe; },
    confirmOverlayOpenChat: state.confirm,
  } });
});
afterEach(() => Reflect.deleteProperty(window, "electronAPI"));

it("confirms the exact opaque session then opens only its live verified destination", async () => {
  const { result } = renderHook(() => useOverlayChatActions(true, true));
  act(() => state.receive?.({ session: "stale" }));
  expect(state.confirm).not.toHaveBeenCalled();
  act(() => state.receive?.({ session: result.current! }));
  await waitFor(() => expect(state.navigate).toHaveBeenCalledExactlyOnceWith(state.target));
  expect(state.confirm).toHaveBeenCalledWith(result.current);
});

it.each([
  { type: "dm" as const, channelId: "dm-channel" },
  { type: "group-dm" as const, channelId: "group-channel" },
])("opens private destination without requiring a server ID: $type", async (target) => {
  state.target = target;
  const { result } = renderHook(() => useOverlayChatActions(true, true));
  expect(result.current).not.toBeNull();
  act(() => state.receive?.({ session: result.current! }));
  await waitFor(() => expect(state.navigate).toHaveBeenCalledExactlyOnceWith(target));
});

it.each(["owner", "generation", "permission", "destination", "consent"])("rechecks %s across native confirmation", async (change) => {
  let finish!: (value: boolean) => void;
  state.confirm.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const { result } = renderHook(() => useOverlayChatActions(true, true));
  act(() => state.receive?.({ session: result.current! }));
  if (change === "owner") state.owner = "other";
  if (change === "generation") state.generation++;
  if (change === "permission") state.target = null;
  if (change === "destination") state.target = { ...state.target!, channelId: "other-channel" };
  if (change === "consent") state.enabled = false;
  await act(async () => finish(true));
  expect(state.navigate).not.toHaveBeenCalled();
});

it("cancels confirmation when destination type changes but its ID stays the same", async () => {
  let finish!: (value: boolean) => void;
  state.target = { type: "dm", channelId: "same-id" };
  state.confirm.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const { result } = renderHook(() => useOverlayChatActions(true, true));
  act(() => state.receive?.({ session: result.current! }));
  state.target = { type: "group-dm", channelId: "same-id" };
  await act(async () => finish(true));
  expect(state.navigate).not.toHaveBeenCalled();
});

it("ignores duplicate in-flight requests and permits retry after failed confirmation", async () => {
  let finish!: (value: boolean) => void;
  state.confirm.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const { result } = renderHook(() => useOverlayChatActions(true, true));
  act(() => { state.receive?.({ session: result.current! }); state.receive?.({ session: result.current! }); });
  expect(state.confirm).toHaveBeenCalledOnce();
  await act(async () => finish(false));
  act(() => state.receive?.({ session: result.current! }));
  await waitFor(() => expect(state.navigate).toHaveBeenCalledOnce());
});

it("retires callbacks on disconnect/unmount and issues no session without a ready chat", () => {
  const view = renderHook(({ connected, ready }) => useOverlayChatActions(connected, ready), { initialProps: { connected: true, ready: true } });
  const session = view.result.current!;
  const receive = state.receive!;
  view.rerender({ connected: false, ready: true });
  expect(view.result.current).toBeNull();
  receive({ session });
  expect(state.confirm).not.toHaveBeenCalled();
  view.rerender({ connected: true, ready: false });
  expect(view.result.current).toBeNull();
});
it("revokes pending focus and rotates chat grants through compatibility",async()=>{let finish!:(value:boolean)=>void;state.confirm.mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));const view=renderHook(()=>useOverlayChatActions(true,true));const old=view.result.current!,receive=state.receive!;act(()=>receive({session:old}));state.compatibility=true;await act(async()=>finish(true));expect(state.navigate).not.toHaveBeenCalled();view.rerender();expect(view.result.current).toBeNull();state.compatibility=false;view.rerender();expect(view.result.current).not.toBe(old);act(()=>receive({session:old}));expect(state.navigate).not.toHaveBeenCalled();});
