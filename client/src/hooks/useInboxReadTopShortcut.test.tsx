import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DMChannelWithUser, DMMessage } from "../types";
import type { InboxDMRow } from "./useInboxDMs";
import { selectTopUnreadInboxRow } from "./useInboxDMs";

const { markDMReadMock } = vi.hoisted(() => ({ markDMReadMock: vi.fn() }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
vi.mock("../api/dm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/dm")>()),
  markDMRead: markDMReadMock,
}));

import { executeInboxShortcut } from "./useInboxShortcutAction";
import { useInboxReadTopShortcut } from "./useInboxReadTopShortcut";
import { useAuthStore } from "../stores/authStore";
import { useDMStore } from "../stores/dmStore";
import { useUIStore } from "../stores/uiStore";
import { useShortcutCaptureStore } from "../stores/shortcutCaptureStore";

const keyEvent = () => new KeyboardEvent("keydown", { key: "E", code: "KeyE", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });

function row(channelId: string, unread: number, messageId?: string, status: "pending" | "accepted" = "accepted"): InboxDMRow {
  const last = messageId ? { id: messageId, user_id: "peer", content: null, created_at: "2026-10-24T12:00:00Z" } as DMMessage : null;
  const dm = {
    id: channelId,
    other_user: { id: `peer-${channelId}`, username: `peer-${channelId}`, display_name: `Peer ${channelId}` },
    status,
    initiated_by: status === "pending" ? `peer-${channelId}` : "me",
    created_at: "2026-10-24T11:00:00Z",
    last_message_at: last?.created_at ?? null,
    last_message: last,
    is_pinned: false,
    is_muted: false,
  } as DMChannelWithUser;
  return { dm, name: dm.other_user.display_name ?? dm.other_user.username, preview: "", isOwn: false, unread, activityAt: dm.last_message_at ?? dm.created_at };
}

function activateInbox(panelId = "panel-a") {
  useUIStore.setState({
    activePanelId: panelId,
    destination: { type: "inbox", channelId: "inbox", label: "Inbox" },
    panels: { [panelId]: { id: panelId, tabs: [{ id: "inbox-tab", channelId: "inbox", type: "inbox", label: "Inbox" }], activeTabId: "inbox-tab" } },
  });
}

function setupRows(requests: InboxDMRow[], conversations: InboxDMRow[]) {
  const all = [...requests, ...conversations];
  const channels = all.map((item) => item.dm);
  useDMStore.setState({
    channels,
    dmUnreadCounts: Object.fromEntries(all.filter((item) => item.unread > 0).map((item) => [item.dm.id, item.unread])),
    messagesByChannel: {},
    fetchChannels: vi.fn().mockResolvedValue(true),
    acceptDMRequest: vi.fn(),
  });
}

beforeEach(() => {
  markDMReadMock.mockReset();
  useAuthStore.setState({ user: { id: "me" } as NonNullable<ReturnType<typeof useAuthStore.getState>["user"]> });
  useShortcutCaptureStore.setState({ active: false });
  activateInbox();
  setupRows([], []);
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("Inbox top unread shortcut", () => {
  it("selects the first unread item in rendered request-then-conversation order", () => {
    const requestRead = row("request-read", 0, "read-request", "pending");
    const requestUnread = row("request-unread", 2, "request-message", "pending");
    const olderConversation = row("older", 4, "older-message");
    const topConversation = row("top", 1, "top-message");
    expect(selectTopUnreadInboxRow([requestRead, requestUnread], [topConversation, olderConversation])).toBe(requestUnread);
    expect(selectTopUnreadInboxRow([], [requestRead, topConversation])).toBe(topConversation);
  });

  it("marks only the exact latest visible unread message and refreshes after acknowledgement without replacing history", async () => {
    const firstRequest = row("request", 1, "request-last", "pending");
    const firstConversation = row("conversation", 3, "conversation-last");
    setupRows([firstRequest], [firstConversation]);
    const fetchChannels = vi.fn().mockResolvedValue(true);
    useDMStore.setState({ fetchChannels });
    const { unmount } = renderHook(() => useInboxReadTopShortcut(true, "panel-a", [firstRequest], [firstConversation]));
    let resolveMark!: (result: { success: boolean; data?: { message: string } }) => void;
    markDMReadMock.mockImplementation(() => new Promise((resolve) => { resolveMark = resolve; }));

    expect(executeInboxShortcut("inbox-read-top", keyEvent())).toBe(true);
    expect(markDMReadMock).toHaveBeenCalledExactlyOnceWith("request", "request-last");
    expect(fetchChannels).not.toHaveBeenCalled();
    expect(useDMStore.getState().acceptDMRequest).not.toHaveBeenCalled();
    expect(useUIStore.getState().destination.type).toBe("inbox");

    const liveMessage = { id: "arrived-during-read", dm_channel_id: "request", user_id: "peer-request", content: "new", created_at: "2026-10-24T12:01:00Z" } as DMMessage;
    useDMStore.setState((state) => ({ messagesByChannel: { ...state.messagesByChannel, request: [liveMessage] } }));
    await act(async () => {
      resolveMark({ success: true, data: { message: "read" } });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchChannels).toHaveBeenCalledOnce();
    expect(useDMStore.getState().messagesByChannel.request).toEqual([liveMessage]);
    unmount();
  });

  it("does not acknowledge when there is no unread anchor, account changed, or Inbox is no longer active", () => {
    const unreadWithoutMessage = row("no-anchor", 1);
    setupRows([], [unreadWithoutMessage]);
    const firstHook = renderHook(() => useInboxReadTopShortcut(true, "panel-a", [], [unreadWithoutMessage]));
    expect(executeInboxShortcut("inbox-read-top", keyEvent())).toBe(false);
    firstHook.unmount();

    const anchored = row("anchored", 1, "latest");
    setupRows([], [anchored]);
    const hook = renderHook(() => useInboxReadTopShortcut(true, "panel-a", [], [anchored]));
    act(() => useAuthStore.setState({ user: { id: "other" } as NonNullable<ReturnType<typeof useAuthStore.getState>["user"]> }));
    expect(executeInboxShortcut("inbox-read-top", keyEvent())).toBe(false);
    act(() => {
      useAuthStore.setState({ user: { id: "me" } as NonNullable<ReturnType<typeof useAuthStore.getState>["user"]> });
      useUIStore.setState({
        destination: { type: "friends", channelId: "friends", label: "Friends" },
        panels: { "panel-a": { id: "panel-a", tabs: [{ id: "friends-tab", channelId: "friends", type: "friends", label: "Friends" }], activeTabId: "friends-tab" } },
      });
    });
    expect(executeInboxShortcut("inbox-read-top", keyEvent())).toBe(false);
    expect(markDMReadMock).not.toHaveBeenCalled();
    hook.unmount();
  });

  it("does not refresh unread metadata after an API rejection or from a different active panel", async () => {
    const unread = row("dm", 1, "message");
    setupRows([], [unread]);
    const fetchChannels = vi.fn().mockResolvedValue(true);
    useDMStore.setState({ fetchChannels });
    const { unmount } = renderHook(() => useInboxReadTopShortcut(true, "panel-a", [], [unread]));
    markDMReadMock.mockResolvedValue({ success: false });
    expect(executeInboxShortcut("inbox-read-top", keyEvent())).toBe(true);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(fetchChannels).not.toHaveBeenCalled();
    expect(useDMStore.getState().dmUnreadCounts.dm).toBe(1);
    unmount();

    activateInbox("panel-b");
    const inactive = renderHook(() => useInboxReadTopShortcut(true, "panel-a", [], [unread]));
    expect(executeInboxShortcut("inbox-read-top", keyEvent())).toBe(false);
    expect(markDMReadMock).toHaveBeenCalledOnce();
    inactive.unmount();
  });

  it("drops a late read acknowledgement after the authenticated account changes", async () => {
    const unread = row("dm", 1, "message");
    setupRows([], [unread]);
    const fetchChannels = vi.fn().mockResolvedValue(true);
    useDMStore.setState({ fetchChannels });
    const { unmount } = renderHook(() => useInboxReadTopShortcut(true, "panel-a", [], [unread]));
    let resolveMark!: (result: { success: boolean; data?: { message: string } }) => void;
    markDMReadMock.mockImplementation(() => new Promise((resolve) => { resolveMark = resolve; }));
    expect(executeInboxShortcut("inbox-read-top", keyEvent())).toBe(true);
    useAuthStore.setState({ user: { id: "new-account" } as NonNullable<ReturnType<typeof useAuthStore.getState>["user"]> });
    await act(async () => {
      resolveMark({ success: true, data: { message: "read" } });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchChannels).not.toHaveBeenCalled();
    unmount();
  });

  it("yields while a dialog is open", () => {
    const unread = row("dm", 1, "message");
    setupRows([], [unread]);
    renderHook(() => useInboxReadTopShortcut(true, "panel-a", [], [unread]));
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.append(dialog);
    expect(executeInboxShortcut("inbox-read-top", keyEvent())).toBe(false);
    expect(markDMReadMock).not.toHaveBeenCalled();
    dialog.remove();
  });

  it("yields to text entry and shortcut capture", () => {
    const unread = row("dm", 1, "message");
    setupRows([], [unread]);
    renderHook(() => useInboxReadTopShortcut(true, "panel-a", [], [unread]));
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    expect(executeInboxShortcut("inbox-read-top", keyEvent())).toBe(false);
    input.blur();
    useShortcutCaptureStore.setState({ active: true });
    expect(executeInboxShortcut("inbox-read-top", keyEvent())).toBe(false);
    expect(markDMReadMock).not.toHaveBeenCalled();
    input.remove();
  });

  it("yields to plaintext-only contenteditable editors", () => {
    const unread = row("dm", 1, "message");
    setupRows([], [unread]);
    renderHook(() => useInboxReadTopShortcut(true, "panel-a", [], [unread]));
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "plaintext-only");
    document.body.append(editor);
    editor.focus();
    expect(executeInboxShortcut("inbox-read-top", keyEvent())).toBe(false);
    expect(markDMReadMock).not.toHaveBeenCalled();
    editor.remove();
  });
});
