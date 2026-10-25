import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import type { Destination } from "../stores/uiStore";
import { resetAppRouteHistory } from "../utils/appRouteHistory";
const session = vi.hoisted(() => ({ ownerId: "viewer", generation: 1 }));
vi.mock("../api/authSessionEvents", async (original) => ({
  ...await original<typeof import("../api/authSessionEvents")>(),
  getAuthSessionSnapshot: () => session,
}));
vi.mock("../stores/authStore", async () => {
  const { create } = await import("zustand");
  return { useAuthStore: create(() => ({ user: { id: "viewer" } })) };
});

vi.mock("../utils/uiShell", () => ({ UI_SHELL_V2: true }));
vi.mock("../stores/uiStore", async () => {
  const { create } = await import("zustand");
  const home: Destination = { type: "friends", channelId: "friends", label: "" };
  return { HOME_DESTINATION: home, useUIStore: create<{ destination: Destination; navigationRevision: number; navigate: (target: Destination) => void }>((set) => ({
    destination: home, navigationRevision: 0,
    navigate: (target) => set((state) => ({ destination: target, navigationRevision: state.navigationRevision + 1 })),
  })) };
});
vi.mock("../stores/serverStore", async () => {
  const { create } = await import("zustand");
  return { useServerStore: create(() => ({ servers: [{ id: "s1", name: "Server", icon_url: null }] })) };
});
vi.mock("../stores/channelStore", () => ({ useChannelStore: { getState: () => ({ categoriesByServer: {} }) } }));
vi.mock("../stores/dmStore", () => ({ useDMStore: { getState: () => ({ channels: [] }) } }));
vi.mock("../stores/groupDMStore", async () => {
  const { create } = await import("zustand");
  return { useGroupDMStore: create(() => ({ groups: [{ id: "g1", name: "Study group", members: [{ id: "viewer" }] }], groupsReady: true, ownerId: "viewer", authGeneration: 1 })) };
});
vi.mock("../stores/p2pCallStore", () => ({ useP2PCallStore: { getState: () => ({ activeCall: null }) } }));
import { useUIStore, HOME_DESTINATION } from "../stores/uiStore";
import { destinationFromPath, destinationPath, useNavigationHistory } from "./useNavigationHistory";
import { useGroupDMStore } from "../stores/groupDMStore";

function Harness() {
  useNavigationHistory();
  const location = useLocation();
  const navigate = useNavigate();
  const destination = useUIStore((state) => state.destination);
  return <><span data-testid="path">{location.pathname}</span><span data-testid="destination">{destination.channelId}</span><button onClick={() => { void navigate(-1); }}>Back</button></>;
}

beforeEach(() => {
  session.ownerId = "viewer"; session.generation = 1;
  useGroupDMStore.setState({ groups: [{ id: "g1", name: "Study group", members: [{ id: "viewer" }] }] as never, groupsReady: true, ownerId: "viewer", authGeneration: 1 });
  useUIStore.setState({ destination: HOME_DESTINATION, navigationRevision: 0 }); resetAppRouteHistory();
});

describe("destination browser history", () => {
  it("preserves a group deep link until deferred owned membership metadata arrives", async () => {
    useGroupDMStore.setState({ groups: [], groupsReady: false });
    render(<MemoryRouter initialEntries={["/channels/group/g1"]}><Harness /></MemoryRouter>);
    expect(screen.getByTestId("path")).toHaveTextContent("/channels/group/g1");
    expect(useUIStore.getState().destination).toEqual(HOME_DESTINATION);
    act(() => useGroupDMStore.setState({ groupsReady: true, groups: [{ id: "g1", name: "Loaded group", members: [{ id: "viewer" }] }] as never }));
    await waitFor(() => expect(useUIStore.getState().destination).toMatchObject({ type: "group-dm", channelId: "g1", label: "Loaded group" }));
    expect(screen.getByTestId("path")).toHaveTextContent("/channels/group/g1");
  });

  it("waits on stale account or generation metadata and rejects an authoritative outsider group", () => {
    useGroupDMStore.setState({ ownerId: "old-owner" });
    expect(destinationFromPath("/channels/group/g1")).toBeNull();
    useGroupDMStore.setState({ ownerId: "viewer", authGeneration: 0 });
    expect(destinationFromPath("/channels/group/g1")).toBeNull();
    useGroupDMStore.setState({ authGeneration: 1, groups: [{ id: "g1", name: "Not ours", members: [{ id: "other" }] }] as never });
    expect(destinationFromPath("/channels/group/g1")).toEqual(HOME_DESTINATION);
  });

  it("falls back only after the owned group list confirms the deep link is unavailable", async () => {
    useGroupDMStore.setState({ groups: [], groupsReady: false });
    render(<MemoryRouter initialEntries={["/channels/group/deleted"]}><Harness /></MemoryRouter>);
    expect(screen.getByTestId("path")).toHaveTextContent("/channels/group/deleted");
    act(() => useGroupDMStore.setState({ groupsReady: true }));
    await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent("/channels/@me/friends"));
    expect(useUIStore.getState().destination).toEqual(HOME_DESTINATION);
  });
  it("pushes internal navigation and restores the preceding conversation on Back", async () => {
    render(<MemoryRouter initialEntries={["/channels/@me/friends"]}><Harness /></MemoryRouter>);
    act(() => useUIStore.getState().navigate({ type: "dm", channelId: "alice", label: "Alice" }));
    await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent("/channels/dm/alice"));
    act(() => useUIStore.getState().navigate({ type: "saved", channelId: "saved", label: "Saved" }));
    await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent("/channels/@me/saved"));
    fireEvent.click(screen.getByText("Back"));
    await waitFor(() => expect(screen.getByTestId("destination")).toHaveTextContent("alice"));
  });

  it("hydrates a server channel deep link without invoking voice join", () => {
    render(<MemoryRouter initialEntries={["/channels/server/s1/voice/v1"]}><Harness /></MemoryRouter>);
    expect(useUIStore.getState().destination).toMatchObject({ type: "voice", channelId: "v1", serverInfo: { serverId: "s1" } });
  });

  it("routes shortcut back/forward only through recorded app destinations", async () => {
    render(<MemoryRouter initialEntries={["/channels/@me/friends"]}><Harness /></MemoryRouter>);
    act(() => useUIStore.getState().navigate({ type: "dm", channelId: "alice", label: "Alice" }));
    await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent("/channels/dm/alice"));
    act(() => window.dispatchEvent(new Event("hichat:history-back")));
    await waitFor(() => expect(screen.getByTestId("destination")).toHaveTextContent("friends"));
    act(() => window.dispatchEvent(new Event("hichat:history-forward")));
    await waitFor(() => expect(screen.getByTestId("destination")).toHaveTextContent("alice"));
  });

  it("rejects malformed URLs and stale calls and encodes destination IDs", () => {
    expect(destinationFromPath("/channels/dm/%zz")).toEqual(HOME_DESTINATION);
    expect(destinationFromPath("/channels/p2p/ended")).toEqual(HOME_DESTINATION);
    expect(destinationFromPath("/channels/server/absent")).toEqual(HOME_DESTINATION);
    expect(destinationPath({ type: "dm", channelId: "a/b", label: "" })).toBe("/channels/dm/a%2Fb");
  });

  it("round-trips group DMs and resolves deleted groups to home", () => {
    const group = destinationFromPath("/channels/group/g1");
    expect(group).toEqual({ type: "group-dm", channelId: "g1", label: "Study group" });
    expect(destinationPath(group!)).toBe("/channels/group/g1");
    expect(destinationFromPath("/channels/group/deleted")).toEqual(HOME_DESTINATION);
  });
});
