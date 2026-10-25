import { describe, expect, it } from "vitest";
import type { CategoryWithChannels } from "../../types";
import { canStartThreadFromChannel } from "./Message";

const textChannel = { id: "parent", type: "text" } as CategoryWithChannels["channels"][number];
const threadChannel = { id: "nested", type: "thread" } as CategoryWithChannels["channels"][number];
const voiceChannel = { id: "voice", type: "voice" } as CategoryWithChannels["channels"][number];
const tree = (channel: CategoryWithChannels["channels"][number]): CategoryWithChannels[] => [
  { category: { id: "cat", name: "Category", position: 0 }, channels: [channel] },
];

describe("Message thread parent gating", () => {
  it("allows a known text parent only", () => {
    expect(canStartThreadFromChannel("parent", tree(textChannel), false)).toBe(true);
    expect(canStartThreadFromChannel("voice", tree(voiceChannel), false)).toBe(false);
  });

  it("rejects a known nested thread from the server tree or scoped thread cache", () => {
    expect(canStartThreadFromChannel("nested", tree(threadChannel), false)).toBe(false);
    expect(canStartThreadFromChannel("nested", undefined, true)).toBe(false);
  });

  it("keeps existing text actions available while the tree is unloaded unless the channel is a known thread", () => {
    expect(canStartThreadFromChannel("parent", undefined, false)).toBe(true);
  });
});
