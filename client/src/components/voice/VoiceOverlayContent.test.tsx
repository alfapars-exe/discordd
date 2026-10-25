import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import VoiceOverlayContent, { type VoiceOverlaySnapshot } from "./VoiceOverlayContent";
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const participant = (id: string, speaking: boolean) => ({
  id, name: id, avatarUrl: "", speaking, muted: false, deafened: false,
});

function snapshot(position: VoiceOverlaySnapshot["position"], patch: Partial<VoiceOverlaySnapshot> = {}): VoiceOverlaySnapshot {
  return {
    enabled: true,
    participants: [participant("speaking-user", true), participant("idle-user", false)],
    speakingOpacity: 95,
    idleOpacity: 35,
    scale: 120,
    position,
    speakingOnly: false,
    voiceOverlayAvatarSize: "small",
    voiceOverlayNameDisplay: "always",
    voiceOverlayMaxParticipants: 25,
    ...patch,
  };
}

describe("VoiceOverlayContent", () => {
  it("renders real projected activity independently from voice and an honest empty state", () => {
    const source = snapshot("top-left", { participants: [], voiceOverlayMaxParticipants: 0, voiceOverlayActivity: true, activities: [{ userId: "friend", label: "Friend", gameName: "Example Game" }] });
    const view = render(<VoiceOverlayContent snapshot={source} />);
    expect(screen.getByRole("region", { name: "overlayActivityTitle" })).toHaveTextContent("Friend");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    view.rerender(<VoiceOverlayContent snapshot={{ ...source, activities: [] }} />);
    expect(screen.getByText("overlayActivityEmpty")).toBeInTheDocument();
    expect(screen.queryByText("Friend")).not.toBeInTheDocument();
    view.rerender(<VoiceOverlayContent snapshot={{ ...source, voiceOverlayActivity: false }} />);
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });
  it("renders only categorized read-only unread indicators and honest source states", () => {
    const source = snapshot("top-left", { participants: [], voiceOverlayMaxParticipants: 0, voiceOverlayNotifications: true,
      notificationStatus: "ready", notifications: [
        { id: "n1", category: "mention" }, { id: "n2", category: "friend_request" },
        { id: "n3", category: "system" }, { id: "n4", category: "reply" },
      ] });
    const view = render(<VoiceOverlayContent snapshot={source} />);
    const panel = screen.getByRole("region", { name: "overlayNotificationsTitle" });
    expect(panel.querySelectorAll(".voice-overlay-notification-row")).toHaveLength(3);
    expect(panel).toHaveTextContent("overlayNotificationMention");
    expect(panel).toHaveTextContent("overlayNotificationFriendRequest");
    expect(panel).toHaveTextContent("overlayNotificationSystem");
    expect(panel.querySelectorAll("button, a, input")).toHaveLength(0);
    expect(panel.textContent).not.toContain("n1");
    view.rerender(<VoiceOverlayContent snapshot={{ ...source, notificationStatus: "loading", notifications: [] }} />);
    expect(screen.getByText("overlayNotificationsLoading")).toBeInTheDocument();
    view.rerender(<VoiceOverlayContent snapshot={{ ...source, notificationStatus: "unavailable", notifications: [] }} />);
    expect(screen.getByText("overlayNotificationsUnavailable")).toBeInTheDocument();
    view.rerender(<VoiceOverlayContent snapshot={{ ...source, notifications: [] }} />);
    expect(screen.getByText("overlayNotificationsEmpty")).toBeInTheDocument();
    view.rerender(<VoiceOverlayContent snapshot={{ ...source, voiceOverlayNotifications: false }} />);
    expect(screen.queryByRole("region", { name: "overlayNotificationsTitle" })).not.toBeInTheDocument();
  });
  it("renders a bounded read-only chat excerpt as text nodes only", () => {
    const messages = Array.from({ length: 7 }, (_, index) => ({
      id: `private-id-${index}`, author: `Author ${index}`, text: index === 0 ? "<img src=x> https://example.invalid" : `Message ${index}`,
    }));
    const source = snapshot("top-left", { participants: [], voiceOverlayMaxParticipants: 0, voiceOverlayChat: true, chatStatus: "ready", chatMessages: messages });
    const view = render(<VoiceOverlayContent snapshot={source} />);
    const panel = screen.getByRole("region", { name: "overlayChatTitle" });
    expect(panel.querySelectorAll(".voice-overlay-chat-row")).toHaveLength(5);
    expect(panel).toHaveTextContent("<img src=x> https://example.invalid");
    expect(panel.querySelector("img, a, video, audio, button, input")).toBeNull();
    expect(panel.textContent).not.toContain("private-id");
    expect(panel.querySelectorAll(".voice-overlay-chat-row")[0]).toHaveStyle({ height: "72px", maxHeight: "72px" });
    expect(panel).toHaveStyle({ height: "380px", maxHeight: "380px" });
    view.rerender(<VoiceOverlayContent snapshot={{ ...source, voiceOverlayChat: false }} />);
    expect(screen.queryByRole("region", { name: "overlayChatTitle" })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("<img src=x>");
  });
  it("distinguishes unavailable from an honestly empty chat panel", () => {
    const source = snapshot("top-left", { participants: [], voiceOverlayMaxParticipants: 0, voiceOverlayChat: true, chatStatus: "unavailable", chatMessages: [] });
    const view = render(<VoiceOverlayContent snapshot={source} />);
    expect(screen.getByText("overlayChatUnavailable")).toBeInTheDocument();
    view.rerender(<VoiceOverlayContent snapshot={{ ...source, chatStatus: "ready" }} />);
    expect(screen.getByText("overlayChatEmpty")).toBeInTheDocument();
    expect(screen.queryByText("overlayChatUnavailable")).not.toBeInTheDocument();
  });
  it("shows a noninteractive Open chat affordance only with the separate opt-in and ready session", () => {
    const source = snapshot("top-left", { participants: [], voiceOverlayMaxParticipants: 0,
      voiceOverlayChat: true, voiceOverlayChatActions: true, chatStatus: "ready", chatActionSession: "session-1" });
    const view = render(<VoiceOverlayContent snapshot={source} />);
    expect(screen.getByText("overlayOpenChat")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "overlayOpenChatInApp" })).not.toBeInTheDocument();
    view.rerender(<VoiceOverlayContent snapshot={{ ...source, voiceOverlayChatActions: false }} />);
    expect(screen.queryByText("overlayOpenChat")).not.toBeInTheDocument();
    view.rerender(<VoiceOverlayContent snapshot={{ ...source, chatStatus: "unavailable" }} />);
    expect(screen.queryByText("overlayOpenChat")).not.toBeInTheDocument();
  });
  it("sends only the current chat-action session through the dedicated surface", () => {
    const send = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("electronAPI", { sendOverlayOpenChat: send });
    const source = snapshot("top-left", { participants: [], voiceOverlayMaxParticipants: 0, voiceOverlayChat: true,
      voiceOverlayChatActions: true, chatStatus: "ready", chatActionSession: "session-opaque",
      chatMessages: [{ id: "private-message-id", author: "Secret author", text: "Sensitive message" }] });
    render(<VoiceOverlayContent snapshot={source} chatActionsOnly />);
    fireEvent.click(screen.getByRole("button", { name: "overlayOpenChatInApp" }));
    expect(send).toHaveBeenCalledExactlyOnceWith("session-opaque");
    expect(JSON.stringify(send.mock.calls)).not.toContain("Sensitive message");
    expect(JSON.stringify(send.mock.calls)).not.toContain("private-message-id");
  });
  it("shows the two 88px chat actions only under their separate opt-ins", () => {
    vi.stubGlobal("electronAPI", { sendOverlayOpenChat: vi.fn(), sendOverlayOpenChatComposer: vi.fn() });
    const source = snapshot("top-left", { voiceOverlayChat: true, chatStatus: "ready", voiceOverlayChatActions: true, chatActionSession: "open-s", voiceOverlayChatCompose: true, chatComposeSession: "compose-s" });
    const view = render(<VoiceOverlayContent snapshot={source} chatActionsOnly />);
    expect(screen.getByRole("button", { name: "overlayComposeChat" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "overlayOpenChatInApp" })).toBeInTheDocument();
    expect(document.querySelector(".voice-overlay-notification-action-surface")).toHaveStyle({ width: "184px", gap: "8px" });
    view.rerender(<VoiceOverlayContent snapshot={{ ...source, voiceOverlayChatCompose: false }} chatActionsOnly />);
    expect(document.querySelector(".voice-overlay-notification-action-surface")).toHaveStyle({ width: "88px" });
    expect(screen.queryByRole("button", { name: "overlayComposeChat" })).not.toBeInTheDocument();
  });
  it("composer surface sends a bounded explicit request and clears only after confirmed success", async () => {
    const send = vi.fn().mockResolvedValueOnce("failed").mockResolvedValueOnce("sent");
    vi.stubGlobal("electronAPI", { sendOverlayChatMessage: send, closeOverlayChatComposer: vi.fn().mockResolvedValue(true) });
    vi.stubGlobal("crypto", { randomUUID: vi.fn().mockReturnValueOnce("request-1").mockReturnValueOnce("request-2") });
    const source = snapshot("top-left", { voiceOverlayChatCompose: true, chatComposeSession: "compose-session" });
    render(<VoiceOverlayContent snapshot={source} chatComposerOnly />);
    const input = screen.getByRole("textbox", { name: "overlayChatMessageLabel" });
    expect(input).toHaveFocus();
    const composer = screen.getByRole("region", { name: "overlayChatComposerTitle" });
    expect(composer).toHaveStyle({ overflowY: "auto", minHeight: "0px" });
    expect(composer.querySelector("header")).toHaveStyle({ flex: "0 0 20px" });
    expect(input).toHaveStyle({ minHeight: "50px", flex: "1 0 50px" });
    fireEvent.change(input, { target: { value: "hello\nworld" } });
    fireEvent.click(screen.getByRole("button", { name: "overlayChatSend" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "overlayChatClose" })).toBeInTheDocument();
    expect(screen.getByText("overlayChatComposeSessionWarning")).toBeInTheDocument();
    expect(input).toHaveValue("hello\nworld");
    expect(send).toHaveBeenNthCalledWith(1, { session: "compose-session", requestId: "request-1", text: "hello\nworld" });
    fireEvent.click(screen.getByRole("button", { name: "overlayChatSend" }));
    await waitFor(() => expect(input).toHaveValue(""));
    expect(send).toHaveBeenNthCalledWith(2, { session: "compose-session", requestId: "request-2", text: "hello\nworld" });
  });
  it("uses Enter to send, preserves Shift+Enter and IME composition, and rejects control characters", async () => {
    const send = vi.fn().mockResolvedValue("sent");
    vi.stubGlobal("electronAPI", { sendOverlayChatMessage: send });
    vi.stubGlobal("crypto", { randomUUID: vi.fn().mockReturnValue("request-enter") });
    render(<VoiceOverlayContent snapshot={snapshot("top-left", { voiceOverlayChatCompose: true, chatComposeSession: "compose-session" })} chatComposerOnly />);
    const input = screen.getByRole("textbox", { name: "overlayChatMessageLabel" });
    fireEvent.change(input, { target: { value: "a" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(send).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(send).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    fireEvent.change(input, { target: { value: "bad\u0001text" } });
    expect(input).toHaveValue("");
  });
  it("single-flights sends, ignores stale completion after session change, and asks before discarding draft", async () => {
    let finish!: (result: "sent" | "failed" | "unavailable") => void;
    const send = vi.fn(() => new Promise<"sent" | "failed" | "unavailable">((resolve) => { finish = resolve; }));
    const close = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("electronAPI", { sendOverlayChatMessage: send, closeOverlayChatComposer: close });
    vi.stubGlobal("crypto", { randomUUID: vi.fn().mockReturnValue("request") });
    const source = snapshot("top-left", { voiceOverlayChatCompose: true, chatComposeSession: "old-session" });
    const view = render(<VoiceOverlayContent snapshot={source} chatComposerOnly />);
    const input = screen.getByRole("textbox", { name: "overlayChatMessageLabel" });
    fireEvent.change(input, { target: { value: "draft" } });
    const sendButton = screen.getByRole("button", { name: "overlayChatSend" });
    fireEvent.click(sendButton);
    expect(send).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "overlayChatSending" })).toBeDisabled();
    view.rerender(<VoiceOverlayContent snapshot={{ ...source, chatComposeSession: "new-session" }} chatComposerOnly />);
    await act(async () => finish("failed"));
    expect(screen.getByRole("textbox", { name: "overlayChatMessageLabel" })).toHaveValue("");
    fireEvent.change(screen.getByRole("textbox", { name: "overlayChatMessageLabel" }), { target: { value: "new draft" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "overlayChatMessageLabel" }), { key: "Escape" });
    expect(screen.getByRole("group", { name: "overlayChatDiscardConfirmation" })).toBeInTheDocument();
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "overlayChatKeepEditing" }));
    expect(screen.getByRole("textbox", { name: "overlayChatMessageLabel" })).toHaveValue("new draft");
    fireEvent.click(screen.getByRole("button", { name: "overlayChatClose" }));
    fireEvent.click(screen.getByRole("button", { name: "overlayChatDiscard" }));
    await waitFor(() => expect(close).toHaveBeenCalledExactlyOnceWith("new-session"));
  });
  it("does not expose the composer without device opt-in and session", () => {
    const source = snapshot("top-left", { voiceOverlayChatCompose: true, chatComposeSession: "compose-session" });
    const view = render(<VoiceOverlayContent snapshot={{ ...source, voiceOverlayChatCompose: false }} chatComposerOnly />);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    view.rerender(<VoiceOverlayContent snapshot={{ ...source, chatComposeSession: "" }} chatComposerOnly />);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
  it("single-flights chat-action clicks and exposes a retryable failure", async () => {
    const send = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    vi.stubGlobal("electronAPI", { sendOverlayOpenChat: send });
    const source = snapshot("top-left", { voiceOverlayChat: true, voiceOverlayChatActions: true,
      chatStatus: "ready", chatActionSession: "session-opaque" });
    render(<VoiceOverlayContent snapshot={source} chatActionsOnly />);
    const button = screen.getByRole("button", { name: "overlayOpenChatInApp" });
    fireEvent.click(button);
    expect(button).toBeDisabled();
    await screen.findByRole("alert", { name: "overlayOpenChatFailed" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert", { name: "overlayOpenChatFailed" })).not.toBeInTheDocument());
  });
  it("resets pending chat-action UI when the session changes and denies disabled or web surfaces", async () => {
    let finish!: (value: boolean) => void;
    const send = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    vi.stubGlobal("electronAPI", { sendOverlayOpenChat: send });
    const source = snapshot("top-left", { voiceOverlayChat: true, voiceOverlayChatActions: true,
      chatStatus: "ready", chatActionSession: "session-old" });
    const view = render(<VoiceOverlayContent snapshot={source} chatActionsOnly />);
    fireEvent.click(screen.getByRole("button", { name: "overlayOpenChatInApp" }));
    view.rerender(<VoiceOverlayContent snapshot={{ ...source, chatActionSession: "session-new" }} chatActionsOnly />);
    await act(async () => finish(false));
    expect(screen.queryByRole("alert", { name: "overlayOpenChatFailed" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "overlayOpenChatInApp" })).toBeEnabled();
    view.rerender(<VoiceOverlayContent snapshot={{ ...source, voiceOverlayChatActions: false }} chatActionsOnly />);
    expect(screen.queryByRole("button", { name: "overlayOpenChatInApp" })).not.toBeInTheDocument();
    vi.stubGlobal("electronAPI", {});
    view.rerender(<VoiceOverlayContent snapshot={{ ...source, chatActionSession: "session-web" }} chatActionsOnly />);
    expect(screen.getByRole("button", { name: "overlayOpenChatInApp" })).toBeDisabled();
  });
  it("reserves chat height above the voice participant widget", () => {
    render(<VoiceOverlayContent snapshot={snapshot("top-left", {
      voiceOverlayChat: true,
      chatStatus: "ready",
      chatMessages: [{ id: "m1", author: "Friend", text: "Hello" }, { id: "m2", author: "Friend", text: "How are you?" }],
    })} />);
    const root = screen.getByRole("region", { name: "overlayChatTitle" }).closest<HTMLElement>(".voice-overlay-root");
    expect(root).toHaveStyle({ paddingTop: "172px" });
    expect(root?.querySelector(".voice-overlay-widget")).toBeInTheDocument();
    expect(root?.querySelectorAll(".voice-overlay-chat-row")).toHaveLength(2);
  });
  it("shows generic inbox affordance only with its separate opt-in and ready unread rows", () => {
    const source = snapshot("top-left", { participants: [], voiceOverlayMaxParticipants: 0,
      voiceOverlayNotifications: true, voiceOverlayNotificationActions: true,
      notificationStatus: "ready", notifications: [{ id: "private-id", category: "mention" }],
      notificationActionSession: "generation:opaque" });
    const view = render(<VoiceOverlayContent snapshot={source} />);
    expect(screen.getByText("overlayOpenInbox")).toBeInTheDocument();
    view.rerender(<VoiceOverlayContent snapshot={{ ...source, voiceOverlayNotificationActions: false }} />);
    expect(screen.queryByText("overlayOpenInbox")).not.toBeInTheDocument();
    view.rerender(<VoiceOverlayContent snapshot={{ ...source, notifications: [] }} />);
    expect(screen.queryByText("overlayOpenInbox")).not.toBeInTheDocument();
  });
  it("notification action surface sends only a generic inbox intent with its current session", () => {
    const send = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("electronAPI", { sendOverlayOpenInbox: send });
    const source = snapshot("top-left", { participants: [], voiceOverlayMaxParticipants: 0,
      voiceOverlayNotifications: true, voiceOverlayNotificationActions: true,
      notificationStatus: "ready", notifications: [{ id: "private-id", category: "mention" }],
      notificationActionSession: "generation:opaque" });
    render(<VoiceOverlayContent snapshot={source} notificationActionsOnly />);
    fireEvent.click(screen.getByRole("button", { name: "overlayOpenInbox" }));
    expect(send).toHaveBeenCalledExactlyOnceWith("generation:opaque");
    expect(JSON.stringify(send.mock.calls)).not.toContain("private-id");
  });
  it("single-flights inbox clicks and shows a retryable error when native confirmation fails", async () => {
    let finish!: (value: boolean) => void;
    const send = vi.fn()
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce(true);
    vi.stubGlobal("electronAPI", { sendOverlayOpenInbox: send });
    const source = snapshot("top-left", { participants: [], voiceOverlayMaxParticipants: 0,
      voiceOverlayNotifications: true, voiceOverlayNotificationActions: true,
      notificationActionSession: "generation:opaque" });
    render(<VoiceOverlayContent snapshot={source} notificationActionsOnly />);
    const button = screen.getByRole("button", { name: "overlayOpenInbox" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(send).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    await act(async () => finish(false));
    expect(await screen.findByRole("alert", { name: "overlayOpenInboxFailed" })).toBeInTheDocument();
    fireEvent.click(button);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert", { name: "overlayOpenInboxFailed" })).not.toBeInTheDocument());
  });
  it("does not surface a stale inbox-action result after the account session rotates", async () => {
    let finish!: (value: boolean) => void;
    const send = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    vi.stubGlobal("electronAPI", { sendOverlayOpenInbox: send });
    const source = snapshot("top-left", { participants: [], voiceOverlayMaxParticipants: 0,
      voiceOverlayNotifications: true, voiceOverlayNotificationActions: true,
      notificationActionSession: "old-generation" });
    const view = render(<VoiceOverlayContent snapshot={source} notificationActionsOnly />);
    fireEvent.click(screen.getByRole("button", { name: "overlayOpenInbox" }));
    view.rerender(<VoiceOverlayContent snapshot={{ ...source, notificationActionSession: "new-generation" }} notificationActionsOnly />);
    await act(async () => finish(false));
    expect(screen.queryByRole("alert", { name: "overlayOpenInboxFailed" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "overlayOpenInbox" })).toBeEnabled();
  });
  it("keeps action buttons disabled without click consent and sends only bounded intents", async () => {
    const send = vi.fn().mockResolvedValue(false);
    vi.stubGlobal("electronAPI", { sendOverlayVoiceAction: send });
    const source = snapshot("top-left", { voiceOverlayQuickActions: true, voiceActionSession: "call-a", selfMuted: true });
    const view = render(<VoiceOverlayContent snapshot={source} />);
    expect(screen.getByRole("button", { name: "overlayToggleMute" })).toBeDisabled();
    view.rerender(<VoiceOverlayContent snapshot={{ ...source, voiceOverlayClickableActions: true }} />);
    const button = screen.getByRole("button", { name: "overlayToggleMute" });
    expect(button).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button);
    expect(send).toHaveBeenCalledExactlyOnceWith("toggle-mute", "call-a");
    await waitFor(() => expect(screen.getByRole("alert")).toHaveAttribute("aria-label", "overlayActionFailed"));
  });
  it("fences a pending action result when the call session changes", async () => {
    let finish!: (value: boolean) => void;
    const send = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    vi.stubGlobal("electronAPI", { sendOverlayVoiceAction: send });
    const source = snapshot("top-left", { voiceOverlayQuickActions: true, voiceOverlayClickableActions: true, voiceActionSession: "call-a" });
    const view = render(<VoiceOverlayContent snapshot={source} />);
    fireEvent.click(screen.getByRole("button", { name: "overlayToggleDeafen" }));
    expect(screen.getByRole("button", { name: "overlayToggleDeafen" })).toBeDisabled();
    view.rerender(<VoiceOverlayContent snapshot={{ ...source, voiceActionSession: "call-b" }} />);
    expect(screen.getByRole("button", { name: "overlayToggleDeafen" })).toBeEnabled();
    await act(async () => finish(false));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("shows persistence failure and pin state without inventing participant data", () => {
    render(<VoiceOverlayContent snapshot={snapshot("top-left", { layoutSaveFailed: true, voiceOverlayPinned: true })} />);
    expect(screen.getByRole("alert")).toHaveAttribute("title");
    expect(screen.getByText("⌖")).toHaveAttribute("aria-label");
    expect(screen.getByText("speaking-user")).toBeInTheDocument();
  });
  it.each([
    ["top-left", "top left"],
    ["top-right", "top right"],
    ["bottom-left", "bottom left"],
    ["bottom-right", "bottom right"],
  ] as const)("anchors the widget at %s within its overlay viewport", (position, transformOrigin) => {
    render(<VoiceOverlayContent snapshot={snapshot(position)} />);
    const root = screen.getByText("speaking-user").closest(".voice-overlay-root");
    expect(root).toHaveAttribute("data-position", position);
    expect(root?.querySelector(".voice-overlay-widget")).toHaveStyle({ transform: "scale(1.2)", transformOrigin });
  });

  it("retains participant filtering and configured opacity", () => {
    render(<VoiceOverlayContent snapshot={snapshot("bottom-left", { speakingOnly: true })} />);
    expect(screen.getByText("speaking-user").closest(".voice-overlay-row")).toHaveClass("speaking");
    expect(screen.queryByText("idle-user")).not.toBeInTheDocument();
    const widget = screen.getByText("speaking-user").closest(".voice-overlay-widget") as HTMLElement;
    expect(within(widget!).getByText("speaking-user").closest(".voice-overlay-row")).toHaveStyle({ opacity: "0.95" });
  });

  it("applies name visibility, avatar size, and participant cap to the live widget", () => {
    const people = Array.from({ length: 4 }, (_, index) => participant(`user-${index}`, index === 0));
    render(<VoiceOverlayContent snapshot={snapshot("bottom-left", {
      participants: people, voiceOverlayAvatarSize: "large", voiceOverlayNameDisplay: "speaking", voiceOverlayMaxParticipants: 2,
    })} />);
    const widget = screen.getByText("user-0").closest(".voice-overlay-widget")!;
    expect(widget).toHaveAttribute("data-avatar-size", "large");
    expect(widget.querySelectorAll(".voice-overlay-row")).toHaveLength(2);
    expect(screen.queryByText("user-1")).not.toBeInTheDocument();
    expect(screen.queryByText("user-2")).not.toBeInTheDocument();
  });

  it("can hide names while preserving bounded avatars and status icons", () => {
    const people = [
      { ...participant("first", false), muted: true },
      participant("second", true),
    ];
    const { container } = render(<VoiceOverlayContent snapshot={snapshot("top-left", {
      participants: people, voiceOverlayNameDisplay: "never", voiceOverlayMaxParticipants: 1,
    })} />);
    expect(container.querySelectorAll(".voice-overlay-row")).toHaveLength(1);
    expect(container.querySelectorAll(".voice-overlay-avatar")).toHaveLength(1);
    expect(container.querySelector(".voice-overlay-row span")).toBeNull();
    expect(container.querySelector(".voice-overlay-row b")).toBeInTheDocument();
  });

  it("renders nothing while disabled", () => {
    const { container } = render(<VoiceOverlayContent snapshot={snapshot("top-left", { enabled: false })} />);
    expect(container.querySelector(".voice-overlay-root")).toBeNull();
  });

  it("renders nothing at the configured Off participant limit", () => {
    const { container } = render(<VoiceOverlayContent snapshot={snapshot("bottom-left", { voiceOverlayMaxParticipants: 0 })} />);
    expect(container.querySelector(".voice-overlay-root")).toBeNull();
  });

  it("constrains unscaled content to the window width after transform scaling", () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 350 });
    const { unmount } = render(<VoiceOverlayContent snapshot={snapshot("bottom-left")} />);
    const widget = screen.getByText("speaking-user").closest<HTMLElement>(".voice-overlay-widget")!;
    expect(widget.style.maxWidth).toBe(`${((350 - 16) / 1.2 / 350) * 100}vw`);
    unmount();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
  });
});
