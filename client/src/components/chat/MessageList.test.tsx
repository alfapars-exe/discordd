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

vi.mock("../../stores/authStore", () => ({
  useAuthStore: (select: (state: { user: { id: string } }) => unknown) =>
    select({ user: { id: "reader" } }),
}));

const conversation = {
  mode: "dm",
  channelId: "conversation",
  messages: [{ id: "target", mentions: ["reader"] }],
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

it.each(["reply", "mention"])("highlights the %s target after navigation", (source) => {
  vi.useFakeTimers();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  try {
    const { container } = render(<>
      <aside><div id="msg-target" /></aside>
      <button onClick={() => requestJump("target")}>Jump to reply</button>
      <MessageList />
    </>);
    const button = screen.getByRole("button", { name: source === "reply" ? "Jump to reply" : "1" });
    fireEvent.click(button);
    if (source === "mention") expect(button).not.toBeInTheDocument();
    expect(virtualizer.scrollToIndex).toHaveBeenCalledWith(0, { align: "center" });
    act(() => vi.advanceTimersToNextFrame());
    const row = container.querySelector(".messages-scroll #msg-target");
    expect(container.querySelector("aside #msg-target")).not.toHaveClass("msg-highlight");
    expect(row).toHaveClass("msg-highlight");
    act(() => vi.advanceTimersByTime(2000));
    expect(row).not.toHaveClass("msg-highlight");
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
