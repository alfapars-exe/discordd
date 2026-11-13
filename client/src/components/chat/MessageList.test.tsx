import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import MessageList from "./MessageList";

const virtualizer = {
  getVirtualItems: () => [{ index: 0, key: "target", start: 0 }],
  getTotalSize: () => 56,
  scrollToIndex: vi.fn(),
};
vi.mock("@tanstack/react-virtual", () => ({ useVirtualizer: () => virtualizer }));
vi.mock("./Message", () => ({ default: () => null }));

const conversation = {
  mode: "dm",
  channelId: "conversation",
  messages: [{ id: "target" }],
  members: [],
  fetchMessages: vi.fn(),
  isMessagePinned: () => false,
};
let requestJump: (id: string) => void;
vi.mock("../../hooks/useChatContext", () => ({
  useChatContext() {
    const [scrollToMessageId, setScrollToMessageId] = useState<string | null>(null);
    requestJump = setScrollToMessageId;
    return { ...conversation, scrollToMessageId, setScrollToMessageId };
  },
}));

it("keeps the reply target highlighted after consuming the jump request", () => {
  vi.useFakeTimers();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  try {
    const { container } = render(<>
      <button onClick={() => requestJump("target")}>Jump to reply</button>
      <MessageList />
    </>);
    fireEvent.click(screen.getByText("Jump to reply"));
    expect(virtualizer.scrollToIndex).toHaveBeenCalledWith(0, { align: "center" });
    act(() => vi.advanceTimersToNextFrame());
    const row = container.querySelector("#msg-target");
    expect(row).toHaveClass("msg-highlight");
    act(() => vi.advanceTimersByTime(2000));
    expect(row).not.toHaveClass("msg-highlight");
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
