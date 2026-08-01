/**
 * MessageInput — send-path regression pins.
 *
 * The critical behavior this file guards is the ref-based double-send
 * guard (isSendingRef). A previous state-only guard let a hammered
 * Enter fire handleSend twice in the same tick because React hadn't
 * flushed setIsSending yet — creating a duplicate message on the
 * server. The ref version runs synchronously and closes the race.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ChatContextValue } from "../../hooks/useChatContext";

// ─── Mock hooks + heavy child components ───

const mockSendMessage = vi.fn();
const mockSetReplyingTo = vi.fn();
const mockSendTyping = vi.fn();
const mockRunMusicCommand = vi.fn().mockResolvedValue(false);

function makeChatContext(overrides: Partial<ChatContextValue> = {}): ChatContextValue {
  return {
    mode: "channel",
    channelId: "ch-1",
    channelName: "general",
    serverId: "s-1",
    messages: [],
    isLoading: false,
    isLoadingMore: false,
    hasMore: false,
    replyingTo: null,
    scrollToMessageId: null,
    typingUsers: [],
    sendMessage: mockSendMessage,
    editMessage: vi.fn(),
    deleteMessage: vi.fn(),
    fetchMessages: vi.fn(),
    fetchOlderMessages: vi.fn(),
    toggleReaction: vi.fn(),
    setReplyingTo: mockSetReplyingTo,
    setScrollToMessageId: vi.fn(),
    sendTyping: mockSendTyping,
    pinMessage: vi.fn(),
    unpinMessage: vi.fn(),
    isMessagePinned: () => false,
    addFilesRef: { current: null },
    canSend: true,
    canManageMessages: false,
    showRoleColors: false,
    members: [],
    ...overrides,
  };
}

let currentContext: ChatContextValue = makeChatContext();
vi.mock("../../hooks/useChatContext", () => ({
  useChatContext: () => currentContext,
}));

vi.mock("../../hooks/useMusicSlashCommand", () => ({
  useMusicSlashCommand: () => mockRunMusicCommand,
}));

vi.mock("../../hooks/useAttachmentRejectionToast", () => ({
  useAttachmentRejectionToast: () => vi.fn(),
}));

vi.mock("../shared/EmojiPicker", () => ({
  default: () => null,
}));
vi.mock("../shared/GifPicker", () => ({
  default: () => null,
}));
vi.mock("./FilePreview", () => ({
  default: () => null,
}));
vi.mock("./MentionAutocomplete", () => ({
  default: () => null,
}));
vi.mock("./ReplyBar", () => ({
  default: () => null,
}));

// initReactI18next is re-exported because MessageInput's imports (via
// utils/dateFormat + utils/apiError) transitively load src/i18n/index.ts,
// which calls .use(initReactI18next) — omitting it makes i18next throw
// "No initReactI18next export is defined on the react-i18next mock".
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

import MessageInput from "./MessageInput";

function Wrapper({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

beforeEach(() => {
  mockSendMessage.mockReset();
  mockSetReplyingTo.mockReset();
  mockSendTyping.mockReset();
  mockRunMusicCommand.mockReset();
  mockRunMusicCommand.mockResolvedValue(false);
  currentContext = makeChatContext();
});

describe("MessageInput", () => {
  it("Enter sends the trimmed content", async () => {
    mockSendMessage.mockResolvedValue(true);
    render(<MessageInput />, { wrapper: Wrapper });

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "hello world" } });
    });
    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
    });

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage.mock.calls[0]![0]).toContain("hello world");
  });

  it("Shift+Enter inserts a newline instead of sending", async () => {
    render(<MessageInput />, { wrapper: Wrapper });
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "line one" } });
    });
    await act(async () => {
      fireEvent.keyDown(textarea, {
        key: "Enter",
        code: "Enter",
        shiftKey: true,
      });
    });
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("Enter with empty/whitespace input does nothing", async () => {
    render(<MessageInput />, { wrapper: Wrapper });
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "   " } });
    });
    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
    });
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("double-send guard: two Enters in the same tick fire sendMessage once", async () => {
    // Controlled promise — sendMessage stays "in flight" until we resolve it,
    // so both Enter presses land while isSendingRef is true.
    let resolveSend: (v: boolean) => void = () => {};
    mockSendMessage.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSend = resolve;
        })
    );

    render(<MessageInput />, { wrapper: Wrapper });
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "hammer" } });
    });

    // Fire two Enters back-to-back with no await in between — simulates
    // a fast double-tap or a stuck-key repeat.
    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
      fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
    });

    expect(mockSendMessage).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSend(true);
    });
  });

  it("failed send preserves the composer content (draft is not lost)", async () => {
    // Success clears the input; failure keeps it. sendWithRetryAndToast
    // already toasted the error — MessageInput's job here is not to
    // eat the user's text.
    mockSendMessage.mockResolvedValue(false);

    render(<MessageInput />, { wrapper: Wrapper });
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "important draft" } });
    });
    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
    });

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    // Value must still be present so the user can retry manually.
    expect(textarea.value).toBe("important draft");
  });

  it("Enter during IME composition does not send (avoids Japanese/Korean/Chinese Enter-to-confirm)", async () => {
    render(<MessageInput />, { wrapper: Wrapper });
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "こんにちは" } });
    });
    // isComposing must be reachable on nativeEvent — testing-library's
    // fireEvent.keyDown surfaces the native KeyboardEvent to the handler.
    await act(async () => {
      fireEvent.keyDown(textarea, {
        key: "Enter",
        code: "Enter",
        isComposing: true,
      });
    });
    expect(mockSendMessage).not.toHaveBeenCalled();
  });
});

describe("MessageInput — timeout gate (B5)", () => {
  function timedOutContext(overrides: Partial<ChatContextValue> = {}) {
    return makeChatContext({
      selfTimeoutExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      ...overrides,
    });
  }

  it("renders the timeout banner", () => {
    currentContext = timedOutContext();
    render(<MessageInput />, { wrapper: Wrapper });
    expect(screen.getByText("common:youAreTimedOut")).toBeInTheDocument();
  });

  it("uses the timed-out placeholder instead of the normal one", () => {
    currentContext = timedOutContext();
    render(<MessageInput />, { wrapper: Wrapper });
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.placeholder).toBe("timedOutPlaceholder");
  });

  it("disables the send button even with content in the box", async () => {
    currentContext = timedOutContext();
    render(<MessageInput />, { wrapper: Wrapper });
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "hello" } });
    });
    expect(screen.getByTitle("sendMessage")).toBeDisabled();
  });

  it("Enter does not call sendMessage", async () => {
    currentContext = timedOutContext();
    render(<MessageInput />, { wrapper: Wrapper });
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "hello" } });
    });
    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
    });
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("does not run a slash command (music-bot escape hatch is closed)", async () => {
    currentContext = timedOutContext();
    render(<MessageInput />, { wrapper: Wrapper });
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "/play x" } });
    });
    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
    });
    expect(mockRunMusicCommand).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
  });
});
