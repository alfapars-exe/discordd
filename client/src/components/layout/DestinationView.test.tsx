import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { CategoryWithChannels } from "../../types";
import type { Destination } from "../../stores/uiStore";
import { Permissions } from "../../utils/permissions";
import { dispatchConversationCommand } from "../../utils/conversationCommands";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }), initReactI18next: { type: "3rdParty", init: () => {} } }));
vi.mock("../../stores/uiStore", async () => {
  const { create } = await import("zustand");
  return { useUIStore: create(() => ({ destination: { type: "friends", channelId: "friends", label: "Friends" } as Destination, navigationRevision: 0, toggleQuickSwitcher: vi.fn(), navigate: vi.fn() })) };
});
vi.mock("../../stores/authStore", async () => {
  const { create } = await import("zustand");
  return { useAuthStore: create(() => ({ user: { id: "user-A" } })) };
});
vi.mock("../../stores/voiceStore", async () => {
  const { create } = await import("zustand");
  return { useVoiceStore: create(() => ({ currentVoiceChannelId: null as string | null, currentVoiceServerId: null as string | null })) };
});
vi.mock("../../stores/p2pCallStore", async () => {
  const { create } = await import("zustand");
  return { useP2PCallStore: create(() => ({ activeCall: null as { id: string } | null })) };
});
const permission = vi.hoisted(() => ({ allowed: true, byBit: {} as Record<number, boolean> }));
vi.mock("../../hooks/useChannelPermissions", () => ({ useChannelPermissions: () => ({ permsResolved: true, authorizationResolved: true, hasChannelPerm: (bit: number) => permission.byBit[bit] ?? permission.allowed }) }));
vi.mock("../../stores/channelStore", async () => {
  const { create } = await import("zustand");
  return { useChannelStore: create(() => ({ categoriesByServer: {} as Record<string, CategoryWithChannels[]>, isLoading: false, fetchChannels: vi.fn() })) };
});
vi.mock("../../stores/channelPermissionStore", async () => {
  const { create } = await import("zustand");
  return { useChannelPermissionStore: create(() => ({ fetchedChannels: new Set<string>(), fetchOverrides: vi.fn().mockResolvedValue(undefined) })) };
});
vi.mock("../../stores/threadStore", async () => {
  const { create } = await import("zustand");
  return { useThreadStore: create(() => ({ ownerId: null as string | null, authGeneration: 0, byID: {} as Record<string, import("../../types").Channel>, serverIdByThread: {} as Record<string, string>, statusByParent: {} as Record<string, string>, statusByThread: {} as Record<string, string>, loadThread: vi.fn().mockResolvedValue(undefined) })) };
});
vi.mock("./ChatArea", async () => {
  const { useState } = await import("react");
  return { default: function MockChat({ channelId, serverId }: { channelId: string; serverId?: string }) {
    const [edit, setEdit] = useState("");
    return <div data-testid="chat" data-server={serverId} data-channel={channelId}>
      <input aria-label="message edit" value={edit} onChange={(event) => setEdit(event.target.value)} />
    </div>;
  } };
});
vi.mock("../dm/DMChat", () => ({ default: ({ channelId }: { channelId: string }) => <div data-testid="dm">{channelId}</div> }));
vi.mock("../friends/FriendsView", () => ({ default: () => <div>Friends content</div> }));
vi.mock("../inbox/InboxView", () => ({ default: () => <div>Inbox content</div> }));
vi.mock("../inbox/NotificationsView", () => ({ default: () => <div>Notifications content</div> }));
vi.mock("../saved/SavedMessagesView", () => ({ default: () => <div>Saved content</div> }));
vi.mock("../p2p/P2PCallScreen", () => ({ default: () => <div>Call content</div> }));
vi.mock("../voice/VoiceRoom", () => ({ default: () => <div>Voice content</div> }));
vi.mock("../audit/AuditChannel", () => ({ default: () => <div>Audit content</div> }));
vi.mock("../shared/SectionErrorBoundary", () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));

import DestinationView from "./DestinationView";
import { useUIStore } from "../../stores/uiStore";
import { useAuthStore } from "../../stores/authStore";
import { useChannelStore } from "../../stores/channelStore";
import { useChannelPermissionStore } from "../../stores/channelPermissionStore";
import { useVoiceStore } from "../../stores/voiceStore";
import { useP2PCallStore } from "../../stores/p2pCallStore";
import { useThreadStore } from "../../stores/threadStore";
import { getAuthGeneration } from "../../api/client";

const serverInfo = { serverId: "server-A", serverName: "Server A", serverIconUrl: null };
function go(destination: Destination) { act(() => useUIStore.setState((state) => ({ destination, navigationRevision: state.navigationRevision + 1 }))); }
const renderView = () => render(<DestinationView sendTyping={vi.fn()} sendDMTyping={vi.fn()} />);

beforeEach(() => {
  permission.allowed = true;
  permission.byBit = {};
  useAuthStore.setState({ user: { id: "user-A" } as never });
  useChannelPermissionStore.setState({ fetchedChannels: new Set(["A", "B", "voice-A"]) });
  useThreadStore.setState({ ownerId: "user-A", authGeneration: getAuthGeneration(), byID: {}, serverIdByThread: {}, statusByParent: {}, statusByThread: {}, loadThread: vi.fn().mockResolvedValue(undefined) });
  useVoiceStore.setState({ currentVoiceChannelId: null, currentVoiceServerId: null });
  useP2PCallStore.setState({ activeCall: null });
  useUIStore.setState({ destination: { type: "friends", channelId: "friends", label: "Friends" } });
  useChannelStore.setState({
    categoriesByServer: {
      "server-A": [{ category: { id: "category" }, channels: [{ id: "A", name: "general", type: "text" }, { id: "B", name: "random", type: "text" }, { id: "voice-A", name: "Lounge", type: "voice" }] }] as CategoryWithChannels[],
      "server-B": [{ category: { id: "category" }, channels: [{ id: "A", name: "other-general", type: "text" }] }] as CategoryWithChannels[],
    },
    isLoading: false,
  });
  vi.clearAllMocks();
});

describe("single destination content", () => {
  it("loads explicit channel overrides before deciding access and mounts after an allow resolves", async () => {
    permission.allowed = false;
    useChannelPermissionStore.setState({ fetchedChannels: new Set() });
    go({ type: "text", channelId: "A", label: "general", serverInfo });
    renderView();
    expect(screen.queryByTestId("chat")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("loading");
    expect(useChannelPermissionStore.getState().fetchOverrides).toHaveBeenCalledWith("A", "server-A");
    await act(async () => {
      permission.allowed = true;
      useChannelPermissionStore.setState({ fetchedChannels: new Set(["A"]) });
    });
    expect(screen.getByTestId("chat")).toBeInTheDocument();
  });
  it("offers retry when permission lookup fails instead of exposing cached content", async () => {
    useChannelPermissionStore.setState({ fetchedChannels: new Set() });
    go({ type: "text", channelId: "A", label: "general", serverInfo });
    await act(async () => { renderView(); });
    expect(screen.queryByTestId("chat")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("shellChannelUnavailable");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "retry" })));
    expect(useChannelPermissionStore.getState().fetchOverrides).toHaveBeenCalledTimes(2);
  });
  it("unmounts cached messages and composer immediately when read access is revoked", () => {
    go({ type: "text", channelId: "A", label: "general", serverInfo });
    const view = renderView();
    expect(screen.getByTestId("chat")).toBeInTheDocument();
    permission.allowed = false;
    view.rerender(<DestinationView sendTyping={vi.fn()} sendDMTyping={vi.fn()} />);
    expect(screen.queryByTestId("chat")).not.toBeInTheDocument();
    expect(screen.getByText("shellChannelUnavailable")).toBeInTheDocument();
  });
  it("requires an explicit join for another voice route and never displays the current room under a wrong label", async () => {
    const join = vi.fn().mockResolvedValue(undefined);
    useVoiceStore.setState({ currentVoiceChannelId: "voice-B", currentVoiceServerId: "server-A" });
    go({ type: "voice", channelId: "voice-A", label: "Lounge", serverInfo });
    render(<DestinationView sendTyping={vi.fn()} sendDMTyping={vi.fn()} onJoinVoice={join} />);
    expect(screen.queryByText("Voice content")).not.toBeInTheDocument();
    expect(join).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "joinVoice" })));
    expect(join).toHaveBeenCalledWith("voice-A");
    act(() => useVoiceStore.setState({ currentVoiceChannelId: "voice-A" }));
    expect(screen.getByText("Voice content")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "joinVoice" })).not.toBeInTheDocument();
    go({ type: "voice", channelId: "voice-A", label: "Lounge", serverInfo });
    expect(join).toHaveBeenCalledOnce();
  });

  it("opens voice text with read permission without requiring voice connect permission", () => {
    permission.byBit = {
      [Permissions.ViewChannel]: true,
      [Permissions.ReadMessages]: true,
      [Permissions.SendMessages]: false,
      [Permissions.ConnectVoice]: false,
    };
    go({ type: "voice", channelId: "voice-A", label: "Lounge", serverInfo });
    renderView();

    expect(screen.getByRole("button", { name: "voiceTextView" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "joinVoice" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "voiceTextView" }));
    expect(screen.getByTestId("chat")).toHaveAttribute("data-channel", "voice-A");
    expect(screen.getByTestId("chat")).toHaveAttribute("data-server", "server-A");
    expect(screen.queryByText("Voice content")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "voiceRoomView" })).toHaveAttribute("aria-pressed", "true");
  });

  it("switches the content surface without leaving an existing voice connection", () => {
    useVoiceStore.setState({ currentVoiceChannelId: "voice-A", currentVoiceServerId: "server-A" });
    go({ type: "voice", channelId: "voice-A", label: "Lounge", serverInfo });
    renderView();

    fireEvent.click(screen.getByRole("button", { name: "voiceTextView" }));
    expect(screen.getByTestId("chat")).toBeInTheDocument();
    expect(useVoiceStore.getState().currentVoiceChannelId).toBe("voice-A");
    expect(useVoiceStore.getState().currentVoiceServerId).toBe("server-A");
    fireEvent.click(screen.getByRole("button", { name: "voiceRoomView" }));
    expect(screen.getByText("Voice content")).toBeInTheDocument();
    expect(useVoiceStore.getState().currentVoiceChannelId).toBe("voice-A");
  });

  it("hides voice text immediately when read access is revoked", () => {
    useVoiceStore.setState({ currentVoiceChannelId: "voice-A", currentVoiceServerId: "server-A" });
    go({ type: "voice", channelId: "voice-A", label: "Lounge", serverInfo });
    const view = renderView();
    fireEvent.click(screen.getByRole("button", { name: "voiceTextView" }));
    expect(screen.getByTestId("chat")).toBeInTheDocument();

    permission.byBit[Permissions.ReadMessages] = false;
    view.rerender(<DestinationView sendTyping={vi.fn()} sendDMTyping={vi.fn()} />);
    expect(screen.queryByTestId("chat")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "voiceTextView" })).not.toBeInTheDocument();
    expect(screen.getByText("Voice content")).toBeInTheDocument();
  });

  it("routes Ctrl+U's members command to the voice text toggle", () => {
    go({ type: "voice", channelId: "voice-A", label: "Lounge", serverInfo });
    renderView();
    let handled = false;
    act(() => { handled = dispatchConversationCommand("members"); });
    expect(handled).toBe(true);
    expect(screen.getByTestId("chat")).toBeInTheDocument();
    act(() => { handled = dispatchConversationCommand("members"); });
    expect(handled).toBe(true);
    expect(screen.getByRole("button", { name: "voiceTextView" })).toBeInTheDocument();
  });

  it("does not keep or reopen voice text when the bound account changes", () => {
    go({ type: "voice", channelId: "voice-A", label: "Lounge", serverInfo });
    const view = renderView();
    fireEvent.click(screen.getByRole("button", { name: "voiceTextView" }));
    expect(screen.getByTestId("chat")).toBeInTheDocument();

    act(() => useAuthStore.setState({ user: { id: "user-B" } as never }));
    view.rerender(<DestinationView sendTyping={vi.fn()} sendDMTyping={vi.fn()} />);
    expect(screen.queryByTestId("chat")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "voiceTextView" })).not.toBeInTheDocument();
    expect(dispatchConversationCommand("members")).toBe(false);
  });

  it("offers join after disconnected voice navigation and respects known permission denial", () => {
    const join = vi.fn();
    permission.allowed = false;
    go({ type: "screen", channelId: "voice-A", label: "Lounge", serverInfo });
    render(<DestinationView sendTyping={vi.fn()} sendDMTyping={vi.fn()} onJoinVoice={join} />);
    expect(screen.getByText("voiceChannelLocked")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "joinVoice" })).toBeDisabled();
    expect(screen.queryByText("Voice content")).not.toBeInTheDocument();
    expect(join).not.toHaveBeenCalled();
  });

  it("does not render a newer P2P call behind a stale call URL", () => {
    // This test only needs call identity; other media fields are owned by the mocked call screen.
    useP2PCallStore.setState({ activeCall: { id: "new-call" } as NonNullable<ReturnType<typeof useP2PCallStore.getState>["activeCall"]> });
    go({ type: "p2p", channelId: "old-call", label: "Old caller" });
    renderView();
    expect(screen.queryByText("Call content")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("callEnded");
    fireEvent.click(screen.getByRole("button", { name: "returnToCall" }));
    expect(useUIStore.getState().navigate).toHaveBeenCalledWith({ type: "p2p", channelId: "new-call", label: "returnToCall" });
    go({ type: "p2p", channelId: "new-call", label: "Current call" });
    expect(screen.getByText("Call content")).toBeInTheDocument();
  });

  it("rejects a route type that does not match the channel instead of showing a message composer", () => {
    go({ type: "text", channelId: "voice-A", label: "Lounge", serverInfo });
    renderView();
    expect(screen.queryByTestId("chat")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("shellChannelUnavailable");
  });

  it("renders only the selected surface with no tab bar or split regions", () => {
    const { container } = renderView();
    expect(screen.getByText("Friends content")).toBeInTheDocument();
    go({ type: "dm", channelId: "dm-A", label: "Alice" });
    expect(screen.getByTestId("dm")).toHaveTextContent("dm-A");
    expect(screen.queryByText("Friends content")).not.toBeInTheDocument();
    expect(container.querySelectorAll(".shell-content")).toHaveLength(1);
    expect(container.querySelector(".panel-tab-bar, .split-pane, .drop-zone-overlay")).toBeNull();
  });

  it("retains local edit state on a label update but remounts across channel or server identity", () => {
    go({ type: "text", channelId: "A", label: "general", serverInfo });
    renderView();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "unsaved edit" } });
    go({ type: "text", channelId: "A", label: "renamed", serverInfo });
    expect(screen.getByRole("textbox")).toHaveValue("unsaved edit");
    go({ type: "text", channelId: "B", label: "random", serverInfo });
    expect(screen.getByRole("textbox")).toHaveValue("");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "another edit" } });
    go({ type: "text", channelId: "A", label: "other", serverInfo: { ...serverInfo, serverId: "server-B" } });
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(screen.getByTestId("chat")).toHaveAttribute("data-server", "server-B");
  });

  it("resolves an unknown text destination through the scoped thread endpoint", async () => {
    go({ type: "text", channelId: "B", label: "missing", serverInfo: { ...serverInfo, serverId: "server-B" } });
    renderView();
    expect(screen.queryByTestId("chat")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("shellChannelUnavailable"));
    expect(useThreadStore.getState().loadThread).toHaveBeenCalledWith("server-B", "B", true);
    fireEvent.click(screen.getByRole("button", { name: "retry" }));
    expect(useThreadStore.getState().loadThread).toHaveBeenCalledTimes(2);
  });

  it("shows loading without stale content while an uncached server loads", () => {
    useChannelStore.setState({ isLoading: true });
    go({ type: "text", channelId: "A", label: "waiting", serverInfo: { ...serverInfo, serverId: "uncached" } });
    renderView();
    expect(screen.queryByTestId("chat")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("loading");
    expect(screen.queryByRole("button", { name: "retry" })).not.toBeInTheDocument();
  });

  it("renders a verified text thread through the main destination using its parent ACL", async () => {
    useThreadStore.setState({
      ownerId: "user-A", authGeneration: getAuthGeneration(),
      byID: { "thread-1": { id: "thread-1", name: "discussion", type: "thread", category_id: null, topic: null, position: 0, user_limit: 0, bitrate: 0, created_at: "2026-01-01T00:00:00Z", parent_channel_id: "A" } },
      serverIdByThread: { "thread-1": "server-A" },
      statusByParent: { [JSON.stringify(["server-A", "A"])]: "ready" }, statusByThread: { "thread-1": "ready" },
    });
    go({ type: "text", channelId: "thread-1", label: "discussion", serverInfo });
    renderView();
    await waitFor(() => expect(screen.getByTestId("chat")).toBeInTheDocument());
    expect(screen.getByTestId("chat")).toHaveAttribute("data-channel", "thread-1");
    expect(screen.getByTestId("chat")).toHaveAttribute("data-server", "server-A");
    expect(useChannelPermissionStore.getState().fetchOverrides).not.toHaveBeenCalledWith("thread-1", "server-A");
  });

  it("hides cached thread content until a revisit refresh settles", async () => {
    useThreadStore.setState({
      ownerId: "user-A", authGeneration: getAuthGeneration(),
      byID: { "thread-1": { id: "thread-1", name: "discussion", type: "thread", category_id: null, topic: null, position: 0, user_limit: 0, bitrate: 0, created_at: "2026-01-01T00:00:00Z", parent_channel_id: "A" } },
      serverIdByThread: { "thread-1": "server-A" },
      statusByParent: { [JSON.stringify(["server-A", "A"])]: "ready" }, statusByThread: { "thread-1": "ready" },
    });
    go({ type: "text", channelId: "thread-1", label: "discussion", serverInfo });
    const view = renderView();
    await waitFor(() => expect(screen.getByTestId("chat")).toBeInTheDocument());

    go({ type: "friends", channelId: "friends", label: "Friends" });
    expect(screen.getByText("Friends content")).toBeInTheDocument();
    let resolveRefresh!: () => void;
    act(() => useThreadStore.setState({ loadThread: vi.fn(() => new Promise<void>((resolve) => { resolveRefresh = resolve; })) }));
    go({ type: "text", channelId: "thread-1", label: "discussion", serverInfo });
    view.rerender(<DestinationView sendTyping={vi.fn()} sendDMTyping={vi.fn()} />);
    expect(screen.queryByTestId("chat")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("loading");

    await act(async () => { resolveRefresh(); });
    expect(screen.getByTestId("chat")).toBeInTheDocument();
  });

  it("fetches the verified parent ACL before mounting a thread", async () => {
    useChannelPermissionStore.setState({ fetchedChannels: new Set(["B", "voice-A"]) });
    useThreadStore.setState({
      ownerId: "user-A", authGeneration: getAuthGeneration(),
      byID: { "thread-1": { id: "thread-1", name: "discussion", type: "thread", category_id: null, topic: null, position: 0, user_limit: 0, bitrate: 0, created_at: "2026-01-01T00:00:00Z", parent_channel_id: "A" } },
      serverIdByThread: { "thread-1": "server-A" }, statusByParent: {}, statusByThread: { "thread-1": "ready" },
    });
    go({ type: "text", channelId: "thread-1", label: "discussion", serverInfo });
    renderView();
    await waitFor(() => expect(useChannelPermissionStore.getState().fetchOverrides).toHaveBeenCalledWith("A", "server-A"));
    expect(screen.queryByTestId("chat")).not.toBeInTheDocument();
  });

  it.each([
    ["wrong account", { ownerId: "other-user" }],
    ["stale authentication generation", { authGeneration: getAuthGeneration() - 1 }],
    ["wrong server", { serverIdByThread: { "thread-1": "server-B" } }],
    ["missing parent", { parent: "not-in-tree" }],
    ["voice parent", { parent: "voice-A" }],
  ])("rejects a thread with %s provenance", async (_case, patch) => {
    const parent = "parent" in patch ? String(patch.parent) : "A";
    useThreadStore.setState({
      ownerId: "user-A", authGeneration: getAuthGeneration(),
      byID: { "thread-1": { id: "thread-1", name: "discussion", type: "thread", category_id: null, topic: null, position: 0, user_limit: 0, bitrate: 0, created_at: "2026-01-01T00:00:00Z", parent_channel_id: parent } },
      serverIdByThread: { "thread-1": "server-A" }, statusByParent: {}, statusByThread: { "thread-1": "ready" },
      ...patch,
    } as never);
    go({ type: "text", channelId: "thread-1", label: "discussion", serverInfo });
    renderView();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("shellChannelUnavailable"));
    expect(screen.queryByTestId("chat")).not.toBeInTheDocument();
  });

  it("unmounts a thread immediately when inherited parent read access is revoked", async () => {
    useThreadStore.setState({
      ownerId: "user-A", authGeneration: getAuthGeneration(),
      byID: { "thread-1": { id: "thread-1", name: "discussion", type: "thread", category_id: null, topic: null, position: 0, user_limit: 0, bitrate: 0, created_at: "2026-01-01T00:00:00Z", parent_channel_id: "A" } },
      serverIdByThread: { "thread-1": "server-A" }, statusByParent: { [JSON.stringify(["server-A", "A"])]: "ready" }, statusByThread: { "thread-1": "ready" },
    });
    go({ type: "text", channelId: "thread-1", label: "discussion", serverInfo });
    const view = renderView();
    await waitFor(() => expect(screen.getByTestId("chat")).toBeInTheDocument());
    expect(screen.getByTestId("chat")).toBeInTheDocument();
    permission.allowed = false;
    view.rerender(<DestinationView sendTyping={vi.fn()} sendDMTyping={vi.fn()} />);
    expect(screen.queryByTestId("chat")).not.toBeInTheDocument();
  });
});
