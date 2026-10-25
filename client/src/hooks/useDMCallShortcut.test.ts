import { renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { executeVoiceShortcut } from "./useVoiceShortcutAction";
import { useDMCallShortcut } from "./useDMCallShortcut";
import { useDMStore } from "../stores/dmStore";
import { useAuthStore } from "../stores/authStore";
import { useP2PCallStore } from "../stores/p2pCallStore";
import { useUIStore } from "../stores/uiStore";
import { getAuthGeneration } from "../api/client";
import type { P2PCall } from "../types";
import type { DMChannelWithUser } from "../types/dm";

const key = () => new KeyboardEvent("keydown", { key: "'", code: "Quote", ctrlKey: true, bubbles: true, cancelable: true });

beforeEach(() => {
  useAuthStore.setState({ user: { id: "me" } as NonNullable<ReturnType<typeof useAuthStore.getState>["user"]> });
  useDMStore.setState({ channels: [{ id: "dm-one", other_user: { id: "friend", username: "friend", display_name: "Friend" }, status: "accepted" } as DMChannelWithUser] });
  useP2PCallStore.setState({ activeCall: null, incomingCall: null, _sendWS: vi.fn(), initiateCall: vi.fn() });
  useUIStore.setState({ destination: { type: "dm", channelId: "dm-one", label: "Friend" } });
});

it("starts a voice call only for the authenticated peer in the active DM", () => {
  renderHook(() => useDMCallShortcut({ channelId: "dm-one", ownerId: "me", otherUserId: "friend", otherUserName: "Friend", isSelf: false, authGeneration: getAuthGeneration() }));
  expect(executeVoiceShortcut("group-call-start", key())).toBe(true);
  expect(useP2PCallStore.getState().initiateCall).toHaveBeenCalledExactlyOnceWith("friend", "voice");
});

it("does not start a call from another destination, self-DM, switched account or without WS", () => {
  const first = renderHook(() => useDMCallShortcut({ channelId: "dm-one", ownerId: "me", otherUserId: "friend", otherUserName: "Friend", isSelf: false, authGeneration: getAuthGeneration() }));
  useUIStore.setState({ destination: { type: "dm", channelId: "dm-two", label: "Other" } });
  expect(executeVoiceShortcut("group-call-start", key())).toBe(false);
  useUIStore.setState({ destination: { type: "dm", channelId: "dm-one", label: "Friend" } });
  useAuthStore.setState({ user: { id: "other-account" } as NonNullable<ReturnType<typeof useAuthStore.getState>["user"]> });
  expect(executeVoiceShortcut("group-call-start", key())).toBe(false);
  useAuthStore.setState({ user: { id: "me" } as NonNullable<ReturnType<typeof useAuthStore.getState>["user"]> });
  useP2PCallStore.setState({ _sendWS: null });
  expect(executeVoiceShortcut("group-call-start", key())).toBe(false);
  useP2PCallStore.setState({ _sendWS: vi.fn() });
  first.unmount();
  renderHook(() => useDMCallShortcut({ channelId: "dm-one", ownerId: "me", otherUserId: "me", otherUserName: "Me", isSelf: true, authGeneration: getAuthGeneration() }));
  expect(executeVoiceShortcut("group-call-start", key())).toBe(false);
  expect(useP2PCallStore.getState().initiateCall).not.toHaveBeenCalled();
});

it("returns to an existing call with this peer but never replaces a different peer call", () => {
  const activeCall = { id: "active", caller_id: "me", receiver_id: "friend", caller_username: "me", receiver_username: "friend", status: "active" } as P2PCall;
  const openTab = vi.fn();
  useP2PCallStore.setState({ activeCall });
  useUIStore.setState({ openTab });
  renderHook(() => useDMCallShortcut({ channelId: "dm-one", ownerId: "me", otherUserId: "friend", otherUserName: "Friend", isSelf: false, authGeneration: getAuthGeneration() }));
  expect(executeVoiceShortcut("group-call-start", key())).toBe(true);
  expect(openTab).toHaveBeenCalledExactlyOnceWith("active", "p2p", "Friend");

  openTab.mockClear();
  useP2PCallStore.setState({ activeCall: { ...activeCall, receiver_id: "someone-else" } });
  expect(executeVoiceShortcut("group-call-start", key())).toBe(false);
  expect(openTab).not.toHaveBeenCalled();
});
