/**
 * MessageInput — attachment count cap (MAX_FILES).
 *
 * The server (handlers/message.go, handlers/dm.go —
 * LimitedParseMultipartFormN n=10) 400s the whole send once a request
 * carries more than 10 files. Before this cap existed, the composer let
 * users pile on any number of attachments and only found out from an
 * opaque "bad request" after hitting send. This pins: selecting past the
 * limit truncates to the first MAX_FILES and warns, across both the file
 * dialog and the drag-drop (addFilesRef) path — and does NOT warn when
 * under the limit.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ChatContextValue } from "../../hooks/useChatContext";

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

vi.mock("../shared/EmojiPicker", () => ({ default: () => null }));
vi.mock("../shared/GifPicker", () => ({ default: () => null }));
vi.mock("./MentionAutocomplete", () => ({ default: () => null }));
vi.mock("./ReplyBar", () => ({ default: () => null }));

// See MessageInput.test.tsx for why initReactI18next must be re-exported here.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

vi.mock("../../stores/toastStore", async () => {
  const { create } = await import("zustand");
  return {
    useToastStore: create(() => ({ addToast: vi.fn() })),
  };
});

import MessageInput from "./MessageInput";
import { useToastStore } from "../../stores/toastStore";
import { MAX_FILES } from "../../utils/constants";

function Wrapper({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

/** Zero-byte files so validateFiles never rejects on size — only count matters here. */
function makeFiles(count: number, prefix = "file"): File[] {
  return Array.from({ length: count }, (_, i) => new File([], `${prefix}${i}.txt`));
}

beforeEach(() => {
  mockSendMessage.mockReset();
  mockSetReplyingTo.mockReset();
  mockSendTyping.mockReset();
  mockRunMusicCommand.mockReset();
  mockRunMusicCommand.mockResolvedValue(false);
  currentContext = makeChatContext();
  useToastStore.setState({ addToast: vi.fn() });
});

describe("MessageInput — MAX_FILES cap", () => {
  it("selecting 11 files via the file dialog keeps only the first 10 and warns", async () => {
    const { container } = render(<MessageInput />, { wrapper: Wrapper });
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;

    await act(async () => {
      fireEvent.change(fileInput, { target: { files: makeFiles(11) } });
    });

    const previewItems = container.querySelectorAll(".file-preview-item");
    expect(previewItems.length).toBe(MAX_FILES);
    expect(useToastStore.getState().addToast).toHaveBeenCalledWith(
      "warning",
      "tooManyFiles"
    );
  });

  it("selecting exactly MAX_FILES does not warn", async () => {
    const { container } = render(<MessageInput />, { wrapper: Wrapper });
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;

    await act(async () => {
      fireEvent.change(fileInput, { target: { files: makeFiles(MAX_FILES) } });
    });

    const previewItems = container.querySelectorAll(".file-preview-item");
    expect(previewItems.length).toBe(MAX_FILES);
    expect(useToastStore.getState().addToast).not.toHaveBeenCalled();
  });

  it("drag-drop (addFilesRef) truncates to the running total and warns on overflow", async () => {
    const { container } = render(<MessageInput />, { wrapper: Wrapper });

    // 7 dropped first — under the cap, no warning yet.
    await act(async () => {
      currentContext.addFilesRef.current?.(makeFiles(7, "drop-a-"));
    });
    expect(useToastStore.getState().addToast).not.toHaveBeenCalled();

    // 5 more dropped — only 3 slots remain, so 2 are dropped and it warns.
    await act(async () => {
      currentContext.addFilesRef.current?.(makeFiles(5, "drop-b-"));
    });

    const previewItems = container.querySelectorAll(".file-preview-item");
    expect(previewItems.length).toBe(MAX_FILES);
    expect(useToastStore.getState().addToast).toHaveBeenCalledWith(
      "warning",
      "tooManyFiles"
    );
  });
});
