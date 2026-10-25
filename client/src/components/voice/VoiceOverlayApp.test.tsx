import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import VoiceOverlayApp from "./VoiceOverlayApp";
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("subscribes to the native overlay and releases the listener on unmount", () => {
  let receive!: (snapshot: unknown) => void;
  const unsubscribe = vi.fn();
  vi.stubGlobal("electronAPI", { onVoiceOverlayUpdate: (callback: (snapshot: unknown) => void) => { receive = callback; return unsubscribe; } });
  const { unmount } = render(<VoiceOverlayApp />);
  act(() => receive({ enabled: true, participants: [{ id: "test", name: "Test participant", avatarUrl: "", speaking: true, muted: false, deafened: false }], speakingOpacity: 100, idleOpacity: 30, scale: 100, position: "top-left", speakingOnly: false, voiceOverlayAvatarSize: "small", voiceOverlayNameDisplay: "always", voiceOverlayMaxParticipants: 25 }));
  expect(screen.getByText("Test participant")).toBeInTheDocument();
  unmount();
  expect(unsubscribe).toHaveBeenCalledExactlyOnceWith();
});

it("renders safely without a desktop bridge", () => {
  const { container } = render(<VoiceOverlayApp />);
  expect(container).toBeEmptyDOMElement();
});

it("routes the chat-actions surface through its bounded session action", () => {
  const originalUrl = window.location.pathname + window.location.search;
  window.history.replaceState({}, "", "/?surface=chat-actions");
  let receive!: (snapshot: unknown) => void;
  const send = vi.fn().mockResolvedValue(true);
  vi.stubGlobal("electronAPI", {
    sendOverlayOpenChat: send,
    onVoiceOverlayUpdate: (callback: (snapshot: unknown) => void) => { receive = callback; return vi.fn(); },
  });
  const { unmount } = render(<VoiceOverlayApp />);
  act(() => receive({ enabled: true, participants: [], speakingOpacity: 100, idleOpacity: 30, scale: 100,
    position: "top-left", speakingOnly: false, voiceOverlayAvatarSize: "small", voiceOverlayNameDisplay: "always",
    voiceOverlayMaxParticipants: 25, voiceOverlayChat: true, voiceOverlayChatActions: true,
    chatStatus: "ready", chatActionSession: "session-opaque", chatMessages: [{ id: "private-id", author: "A", text: "private text" }] }));
  act(() => screen.getByRole("button", { name: "overlayOpenChatInApp" }).click());
  expect(send).toHaveBeenCalledExactlyOnceWith("session-opaque");
  expect(JSON.stringify(send.mock.calls)).not.toContain("private text");
  unmount();
  window.history.replaceState({}, "", originalUrl || "/");
});

it("routes the chat-composer surface using only its compose session", () => {
  const originalUrl = window.location.pathname + window.location.search;
  window.history.replaceState({}, "", "/?surface=chat-composer");
  const send = vi.fn().mockResolvedValue("sent");
  vi.stubGlobal("crypto", { randomUUID: vi.fn().mockReturnValue("request-opaque") });
  vi.stubGlobal("electronAPI", {
    sendOverlayChatMessage: send,
    onVoiceOverlayUpdate: (callback: (snapshot: unknown) => void) => {
      queueMicrotask(() => callback({ enabled: true, participants: [], speakingOpacity: 100, idleOpacity: 30, scale: 100,
        position: "top-left", speakingOnly: false, voiceOverlayAvatarSize: "small", voiceOverlayNameDisplay: "always",
        voiceOverlayMaxParticipants: 25, voiceOverlayChatCompose: true, chatComposeSession: "composer-session",
        chatComposeLabel: "General", chatMessages: [{ id: "private", author: "Private", text: "must not appear" }] }));
      return vi.fn();
    },
  });
  const view = render(<VoiceOverlayApp />);
  return screen.findByRole("textbox", { name: "overlayChatMessageLabel" }).then((input) => {
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "overlayChatSend" }));
    expect(send).toHaveBeenCalledWith({ session: "composer-session", requestId: "request-opaque", text: "hello" });
    expect(screen.queryByText("must not appear")).not.toBeInTheDocument();
    view.unmount();
    window.history.replaceState({}, "", originalUrl || "/");
  });
});
