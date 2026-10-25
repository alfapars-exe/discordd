import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { GroupDMMessage } from "../../types/groupDM";
import GroupDMMessageBody from "./GroupDMMessageBody";

const gate = vi.hoisted(() => ({ visible: false, inspect: vi.fn() }));
vi.mock("../chat/UnclassifiedMediaGate", () => ({ default: (props: { children: ReactNode }) => {
  gate.inspect(props);
  return gate.visible ? props.children : <span>media withheld</span>;
} }));
vi.mock("../chat/StickerMessage", () => ({ default: ({ id }: { id: string }) => <span data-testid="sticker">{id}</span> }));
vi.mock("../chat/MessageCustomEmoji", () => ({ default: () => <span data-testid="custom-emoji" /> }));
const message = (content: string | null): GroupDMMessage => ({ id: "message", group_id: "group", user_id: "peer", content, edited_at: null } as GroupDMMessage);
beforeEach(() => { gate.visible = false; gate.inspect.mockClear(); });

it("renders shared formatting without classifying plain text or native emoji as media", () => {
  render(<GroupDMMessageBody message={message("**hello** 🙂")} members={[]} />);
  expect(screen.getByText("hello").tagName).toBe("STRONG");
  expect(gate.inspect).not.toHaveBeenCalled();
});

it("does not mount a GIF image until the private-media gate permits it", () => {
  const source = message("https://static.klipy.com/test.gif");
  const view = render(<GroupDMMessageBody message={source} members={[]} />);
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  expect(gate.inspect).toHaveBeenCalledWith(expect.objectContaining({ privateConversation: true, sourceKind: "group", sourceChannelId: "group", messageId: "message",
    mediaInputs: [{ url: source.content, mimeType: "image/gif" }] }));
  gate.visible = true;
  view.rerender(<GroupDMMessageBody message={source} members={[]} />);
  expect(screen.getByRole("img", { name: "GIF" })).toHaveAttribute("src", source.content);
});

it.each([
  ["<sticker:cat:0123456789abcdef>", "sticker", "/api/uploads/stickers/0123456789abcdef.png"],
  ["<:cat:0123456789abcdef>", "custom-emoji", "/api/uploads/emojis/0123456789abcdef.png"],
])("gates expression media before rendering %s", (content, testId, url) => {
  const view = render(<GroupDMMessageBody message={message(content)} members={[]} />);
  expect(screen.queryByTestId(testId)).not.toBeInTheDocument();
  expect(gate.inspect).toHaveBeenCalledWith(expect.objectContaining({ mediaInputs: [{ url, mimeType: "image/png" }] }));
  gate.visible = true;
  view.rerender(<GroupDMMessageBody message={message(content)} members={[]} />);
  expect(screen.getByTestId(testId)).toBeInTheDocument();
});

it("never renders a failed decrypted body even when an old plaintext value remains", () => {
  render(<GroupDMMessageBody message={{ ...message("stale private text"), decryption_error: "version_unavailable" }} members={[]} />);
  expect(screen.queryByText("stale private text")).not.toBeInTheDocument();
  expect(gate.inspect).not.toHaveBeenCalled();
});

it.each(["`<:cat:0123456789abcdef>`", "```\n<:cat:0123456789abcdef>\n```"])("does not classify literal expression code as media: %s", (content) => {
  render(<GroupDMMessageBody message={message(content)} members={[]} />);
  expect(gate.inspect).not.toHaveBeenCalled();
  expect(screen.queryByTestId("custom-emoji")).not.toBeInTheDocument();
});
