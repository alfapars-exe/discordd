import { describe, expect, it } from "vitest";
import { buildForwardContent,canForwardToChannel } from "./forwardMessageContent";
import {Permissions} from "../../utils/permissions";
import type { ChatMessage } from "../../hooks/useChatContext";

const message = {
  id: "m1", user_id: "u1", content: "hello", edited_at: null, created_at: "2026-01-01T00:00:00Z",
  reply_to_id: null, is_pinned: false, attachments: [], reactions: [], referenced_message: null,
  author: { id: "u1", username: "alice", display_name: "Alice", avatar_url: null, status: "online", custom_status: null, created_at: "2025-01-01T00:00:00Z" },
} as ChatMessage;

describe("forward content", () => {
  it("requires known view/read/send bits and honors admin only on text channels",()=>{
    const all=Permissions.ViewChannel|Permissions.ReadMessages|Permissions.SendMessages;
    for(const bit of [Permissions.ViewChannel,Permissions.ReadMessages,Permissions.SendMessages])expect(canForwardToChannel({type:"text",effective_permissions:all&~bit})).toBe(false);
    for(const bits of [undefined,-1,NaN,Infinity,1.5,8388608])expect(canForwardToChannel({type:"text",effective_permissions:bits})).toBe(false);
    expect(canForwardToChannel({type:"text",effective_permissions:all})).toBe(true);expect(canForwardToChannel({type:"text",effective_permissions:Permissions.Admin})).toBe(true);expect(canForwardToChannel({type:"audit",effective_permissions:Permissions.Admin})).toBe(false);
  });
  it("attributes forwarded text so it cannot impersonate the current sender", () => {
    expect(buildForwardContent(message, "Forwarded from")).toBe("Forwarded from Alice:\nhello");
  });
  it("keeps attribution for attachment-only messages", () => {
    expect(buildForwardContent({ ...message, content: null }, "Forwarded from")).toBe("Forwarded from Alice");
  });
});
