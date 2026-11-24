import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ send: vi.fn(), join: vi.fn(), toast: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../stores/voiceStore", async () => { const { create } = await import("zustand"); return {
  useVoiceStore: create<{
    _wsSend: ((op: string, data?: unknown) => void) | null;
    currentVoiceChannelId: string | null;
    pendingVoiceChannelId: string | null;
    voiceStates: Record<string, { user_id: string }[]>;
  }>(() => ({ _wsSend: fixture.send, currentVoiceChannelId: "a", pendingVoiceChannelId: null, voiceStates: {} })),
}; });
vi.mock("../stores/channelStore", async () => { const { create } = await import("zustand"); return {
  useChannelStore: create<{ categories: unknown[]; reorderChannels: () => void; reorderCategories: () => void }>(
    () => ({ categories: [], reorderChannels: vi.fn(), reorderCategories: vi.fn() })),
}; });
vi.mock("../stores/toastStore", async () => { const { create } = await import("zustand"); return {
  useToastStore: create(() => ({ addToast: fixture.toast })),
}; });
import { useChannelStore } from "../stores/channelStore";
import { useVoiceStore } from "../stores/voiceStore";
import { useVoicePendingMoveStore } from "../stores/voicePendingMoveStore";
import { useChannelTreeDragDrop } from "./useChannelTreeDragDrop";

function dragEvent() {
  return {
    preventDefault: vi.fn(), stopPropagation: vi.fn(), clientY: 0, relatedTarget: null,
    dataTransfer: { effectAllowed: "", dropEffect: "", setData: vi.fn() },
  } as unknown as React.DragEvent & { preventDefault: ReturnType<typeof vi.fn> };
}

function setup(locked: string[] = [], noMoveMembers: string[] = []) {
  return renderHook(() => useChannelTreeDragDrop({
    canConnectVoice: (channelId) => !locked.includes(channelId),
    canMoveMembers: (channelId) => !noMoveMembers.includes(channelId),
    currentUserId: "me",
    onJoinVoice: fixture.join,
  }));
}

/** Drag `userId` out of voice channel "a" and drop it on `target`. */
function dragOnto(view: ReturnType<typeof setup>, userId: string, target: string, type = "voice") {
  const over = dragEvent();
  act(() => { view.result.current.handleVoiceUserDragStart(dragEvent(), userId, "a"); });
  act(() => { view.result.current.handleChannelDragOver(over, target, type, "cat"); });
  act(() => { view.result.current.handleChannelDrop(dragEvent(), target, "cat"); });
  return over;
}

beforeEach(() => {
  fixture.send.mockReset(); fixture.join.mockReset(); fixture.toast.mockReset();
  useVoiceStore.setState({ _wsSend: fixture.send, currentVoiceChannelId: "a", pendingVoiceChannelId: null, voiceStates: {} });
  useChannelStore.setState({ categories: [] });
  useVoicePendingMoveStore.setState({ moves: {} });
});

describe("voice user drag and drop", () => {
  it("switches channel through the join action when the user drags their own row", () => {
    const view = setup();
    const over = dragOnto(view, "me", "b");
    expect(over.preventDefault).toHaveBeenCalled();
    expect(fixture.join).toHaveBeenCalledTimes(1);
    expect(fixture.join).toHaveBeenCalledWith("b");
    expect(fixture.send).not.toHaveBeenCalled();
    expect(useVoicePendingMoveStore.getState().moves).toEqual({});
    expect(view.result.current.draggingVoiceUserId).toBeNull();
    expect(view.result.current.voiceDropTargetId).toBeNull();
  });

  it("sends voice_move_user and records the pending move when a moderator drops another member", () => {
    const view = setup();
    dragOnto(view, "ada", "b");
    expect(fixture.send).toHaveBeenCalledTimes(1);
    expect(fixture.send).toHaveBeenCalledWith("voice_move_user", { target_user_id: "ada", target_channel_id: "b" });
    expect(fixture.join).not.toHaveBeenCalled();
    expect(useVoicePendingMoveStore.getState().moves).toEqual({
      ada: { userId: "ada", fromChannelId: "a", toChannelId: "b", startedAt: expect.any(Number) },
    });
  });

  it("asks the server to move the user's other session when this one is not in voice", () => {
    useVoiceStore.setState({ currentVoiceChannelId: null });
    const view = setup();
    dragOnto(view, "me", "b");
    expect(fixture.join).not.toHaveBeenCalled();
    expect(fixture.send).toHaveBeenCalledWith("voice_move_user", { target_user_id: "me", target_channel_id: "b" });
    expect(useVoicePendingMoveStore.getState().moves.me).toMatchObject({ fromChannelId: "a", toChannelId: "b" });
  });

  it("treats a join in flight as owning the voice session", () => {
    useVoiceStore.setState({ currentVoiceChannelId: null, pendingVoiceChannelId: "a" });
    const view = setup();
    dragOnto(view, "me", "b");
    expect(fixture.join).toHaveBeenCalledWith("b");
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it("keeps rejecting a locked, non-voice or same-channel drop target", () => {
    const view = setup(["locked"]);
    for (const [target, type] of [["locked", "voice"], ["text", "text"], ["a", "voice"]]) {
      const over = dragEvent();
      act(() => { view.result.current.handleVoiceUserDragStart(dragEvent(), "me", "a"); });
      act(() => { view.result.current.handleChannelDragOver(over, target, type, "cat"); });
      expect(over.preventDefault).not.toHaveBeenCalled();
      expect(view.result.current.voiceDropTargetId).toBeNull();
      act(() => { view.result.current.handleVoiceUserDragEnd(); });
    }
  });

  it("does not join a channel the user cannot connect to even if a drop is delivered", () => {
    const view = setup(["locked"]);
    dragOnto(view, "me", "locked");
    expect(fixture.join).not.toHaveBeenCalled();
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it("records nothing when the move cannot be sent", () => {
    useVoiceStore.setState({ _wsSend: null });
    const view = setup();
    dragOnto(view, "ada", "b");
    expect(useVoicePendingMoveStore.getState().moves).toEqual({});
    expect(fixture.join).not.toHaveBeenCalled();
  });

  // The server refuses such a move without telling the mover: showing the
  // member under the target would be a phantom row until the overlay expires.
  it.each([["source", "a"], ["target", "b"]])(
    "records no pending move when the mover lacks MoveMembers in the %s channel", (_side, channelId) => {
      const view = setup([], [channelId]);
      dragOnto(view, "ada", "b");
      // The request is still sent: the server stays the authority.
      expect(fixture.send).toHaveBeenCalledExactlyOnceWith("voice_move_user", { target_user_id: "ada", target_channel_id: "b" });
      expect(useVoicePendingMoveStore.getState().moves).toEqual({});
    });

  it("still shows the user's own other session moving without MoveMembers", () => {
    useVoiceStore.setState({ currentVoiceChannelId: null });
    const view = setup([], ["a", "b"]);
    dragOnto(view, "me", "b");
    expect(useVoicePendingMoveStore.getState().moves.me).toMatchObject({ fromChannelId: "a", toChannelId: "b" });
  });
});

describe("dragging your own row onto a channel with a user limit", () => {
  const limited = (userLimit: number) => useChannelStore.setState({
    categories: [{ category: { id: "cat" }, channels: [{ id: "a", user_limit: 0 }, { id: "b", user_limit: userLimit }] }] as never,
  });
  const occupied = (...userIds: string[]) => useVoiceStore.setState({
    voiceStates: { a: [{ user_id: "me" }], b: userIds.map((user_id) => ({ user_id })) } as never,
  });

  // The join leaves the current channel first; a refusal by the server
  // would end with the user in no voice channel at all.
  it("keeps the current session and reports the channel as full", () => {
    limited(2); occupied("ada", "bob");
    const view = setup();
    dragOnto(view, "me", "b");
    expect(fixture.join).not.toHaveBeenCalled();
    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.toast).toHaveBeenCalledExactlyOnceWith("error", "voiceChannelFull");
    expect(useVoiceStore.getState().currentVoiceChannelId).toBe("a");
    expect(view.result.current.draggingVoiceUserId).toBeNull();
  });

  it.each([
    ["below its limit", 3, ["ada", "bob"]],
    ["without a limit", 0, ["ada", "bob", "cem"]],
    ["that already lists the user", 2, ["ada", "me"]],
  ])("joins a channel %s", (_label, userLimit, userIds) => {
    limited(userLimit); occupied(...userIds);
    const view = setup();
    dragOnto(view, "me", "b");
    expect(fixture.join).toHaveBeenCalledExactlyOnceWith("b");
    expect(fixture.toast).not.toHaveBeenCalled();
  });
});
