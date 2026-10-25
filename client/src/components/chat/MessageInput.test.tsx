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
import type { ChatContextValue, ChatMessage } from "../../hooks/useChatContext";
import { CONVERSATION_COMMAND_EVENT, type ConversationCommand } from "../../utils/conversationCommands";

// ─── Mock hooks + heavy child components ───

const mockSendMessage = vi.fn();
const mockSetReplyingTo = vi.fn();
const mockSendTyping = vi.fn();
const mockRunMusicCommand = vi.fn().mockResolvedValue({ handled: false });
const typingHook = vi.hoisted(() => ({ insert: null as null | ((key: string) => boolean), enabled: false }));
vi.mock("../../hooks/useFocusComposerOnTyping", () => ({
  useFocusComposerOnTyping: (_target: unknown, _ref: unknown, insert: (key: string) => boolean, enabled: boolean) => {
    typingHook.insert = insert;
    typingHook.enabled = enabled;
  },
}));

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
    hasMoreAfter: false,
    replyingTo: null,
    scrollToMessageId: null,
    typingUsers: [],
    sendMessage: mockSendMessage,
    editMessage: vi.fn(),
    deleteMessage: vi.fn(),
    fetchMessages: vi.fn(),
    fetchOlderMessages: vi.fn(),
    fetchNewerMessages: vi.fn(),
    jumpToPresent: vi.fn(),
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
vi.mock("../shared/StickerPicker", () => ({ default: () => null }));
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
import { useComposerDraftStore } from "../../stores/composerDraftStore";

function Wrapper({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

beforeEach(() => {
  useComposerDraftStore.getState().reset();
  mockSendMessage.mockReset();
  mockSetReplyingTo.mockReset();
  mockSendTyping.mockReset();
  mockRunMusicCommand.mockReset();
  mockRunMusicCommand.mockResolvedValue({ handled: false });
  currentContext = makeChatContext();
});

describe("MessageInput", () => {
  it("inserts a background typing character once at the draft selection without sending", () => {
    render(<MessageInput />);
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "hello world" } });
    input.setSelectionRange(6, 11);
    expect(typingHook.enabled).toBe(true);
    let inserted = false;
    act(() => { inserted = typingHook.insert!("x"); });
    expect(inserted).toBe(true);
    expect(input).toHaveValue("hello x");
    expect(mockSendMessage).not.toHaveBeenCalled();
  });
  it("does not mutate a draft from an unmounted background-typing callback", () => {
    const view = render(<MessageInput />);
    const insert = typingHook.insert!;
    view.unmount();
    expect(insert("x")).toBe(false);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });
  function command(command: ConversationCommand, channelId = "ch-1") {
    const event = new CustomEvent(CONVERSATION_COMMAND_EVENT, { detail:{command,target:{kind:"channel",id:channelId,serverId:"s-1"}},cancelable:true });
    act(()=>{window.dispatchEvent(event);});
    return event.defaultPrevented;
  }
  it("scopes picker commands to the active composer and keeps one picker open", () => {
    const {container}=render(<MessageInput />);
    expect(command("emoji", "another-channel")).toBe(false);
    expect(container.querySelector(".input-emoji-picker-wrap")).toBeNull();
    expect(command("emoji")).toBe(true);
    expect(container.querySelector(".input-emoji-picker-wrap")).not.toBeNull();
    expect(command("gif")).toBe(true);
    expect(container.querySelector(".input-emoji-picker-wrap")).toBeNull();
    expect(container.querySelectorAll(".input-gif-picker-wrap")).toHaveLength(1);
    expect(command("sticker")).toBe(true);
    expect(container.querySelectorAll(".input-gif-picker-wrap")).toHaveLength(1);
  });
  it("uses the existing file chooser and refuses composer commands without send permission", () => {
    let view=render(<MessageInput />);
    const click=vi.spyOn(view.container.querySelector<HTMLInputElement>('input[type="file"]')!,"click").mockImplementation(()=>{});
    expect(command("upload")).toBe(true);expect(click).toHaveBeenCalledOnce();
    view.unmount();
    currentContext=makeChatContext({canSend:false});
    view=render(<MessageInput />);
    expect(command("emoji")).toBe(false);expect(command("upload")).toBe(false);
    expect(screen.getByTitle("attachFile")).toBeDisabled();
    expect(view.container.querySelector(".input-emoji-picker-wrap")).toBeNull();
  });
  it("restores separate channel and DM drafts, including queued files, after unmount", async () => {
    let view = render(<MessageInput />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "channel A draft" } });
    const file = new File(["image"], "queued.png", { type: "image/png" });
    act(() => currentContext.addFilesRef.current?.([file]));
    view.unmount();
    currentContext = makeChatContext({ channelId: "ch-2" });
    view = render(<MessageInput />);
    expect(screen.getByRole("textbox")).toHaveValue("");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "channel B draft" } });
    view.unmount();
    currentContext = makeChatContext({ mode: "dm", serverId: undefined });
    view = render(<MessageInput />);
    expect(screen.getByRole("textbox")).toHaveValue("");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "private DM draft" } });
    view.unmount();
    currentContext = makeChatContext();
    view = render(<MessageInput />);
    expect(screen.getByRole("textbox")).toHaveValue("channel A draft");
    mockSendMessage.mockResolvedValue(true);
    await act(async () => fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" }));
    expect(mockSendMessage).toHaveBeenCalledWith("channel A draft", [file], undefined);
    view.unmount();
    currentContext = makeChatContext({ mode: "dm", serverId: undefined });
    render(<MessageInput />);
    expect(screen.getByRole("textbox")).toHaveValue("private DM draft");
  });

  it("keeps the send lock across remount and does not clear another conversation on completion", async () => {
    let resolve!: (success: boolean) => void;
    mockSendMessage.mockImplementation(() => new Promise<boolean>((done) => { resolve = done; }));
    let view = render(<MessageInput />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "send from A" } });
    await act(async () => fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" }));
    view.unmount();
    view = render(<MessageInput />);
    expect(screen.getByRole("textbox")).toHaveAttribute("readonly");
    await act(async () => fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" }));
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    view.unmount();
    currentContext = makeChatContext({ channelId: "ch-2" });
    view = render(<MessageInput />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "B stays intact" } });
    await act(async () => resolve(true));
    expect(screen.getByRole("textbox")).toHaveValue("B stays intact");
    view.unmount();
    currentContext = makeChatContext();
    render(<MessageInput />);
    expect(screen.getByRole("textbox")).toHaveValue("");
  });

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

  it.each(["success", "failed", "pending"])("handles music %s without posting the command as chat", async (outcome) => {
    mockRunMusicCommand.mockResolvedValue({ handled: true, outcome });
    render(<MessageInput />);
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "/play https://youtu.be/example" } });
    await act(async () => fireEvent.keyDown(textarea, { key: "Enter" }));
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(textarea).toHaveValue(outcome === "success" ? "" : "/play https://youtu.be/example");
    expect(mockRunMusicCommand).toHaveBeenCalledTimes(1);
    expect(textarea).not.toHaveAttribute("readonly");
  });

  it.each(["success", "pending"])("preserves unrelated files and reply after music %s", async (outcome) => {
    mockRunMusicCommand.mockResolvedValueOnce({ handled: true, outcome });
    render(<MessageInput />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/skip" } });
    const file = new File(["image"], "keep.png", { type: "image/png" });
    const reply = { id: "reply-1" } as ChatMessage;
    act(() => currentContext.addFilesRef.current?.([file]));
    const draftKey = Object.keys(useComposerDraftStore.getState().drafts)[0]!;
    act(() => useComposerDraftStore.getState().patch(draftKey, { replyingTo: reply }));
    await act(async () => fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" }));
    expect(useComposerDraftStore.getState().drafts[draftKey]).toMatchObject({
      content: outcome === "success" ? "" : "/skip", files: [file], replyingTo: reply, sending: null,
    });
    expect(mockRunMusicCommand).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).not.toHaveBeenCalled();

    // Files and reply still belong to the next deliberate ordinary message.
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Here is the file" } });
    mockSendMessage.mockResolvedValue(true);
    await act(async () => fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" }));
    expect(mockSendMessage).toHaveBeenCalledWith("Here is the file", [file], reply.id);
  });

  it("preserves the new session draft when an old music command completes", async () => {
    let complete!: (value: { handled: true; outcome: "success" }) => void;
    mockRunMusicCommand.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    render(<MessageInput />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/skip" } });
    await act(async () => fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" }));
    act(() => useComposerDraftStore.getState().reset());
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "new session draft" } });
    await act(async () => complete({ handled: true, outcome: "success" }));
    expect(screen.getByRole("textbox")).toHaveValue("new session draft");
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
    expect(screen.getByRole("button", { name: "common:sendMessage" })).toBeDisabled();
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
