/**
 * convertMentionTokens regression tests — lock the @name -> wire-token
 * conversion that runs on every send. The longest-name-first ordering and the
 * regex-escaping are the two subtle behaviours most likely to break silently.
 */

import { describe, it, expect } from "vitest";
import { convertMentionTokens } from "./mention";
import type { MentionSelection } from "../components/chat/MentionAutocomplete";

describe("convertMentionTokens", () => {
  it("converts a user mention to <@id>", () => {
    const sel: MentionSelection[] = [{ id: "u1", name: "alice", type: "user" }];
    expect(convertMentionTokens("hi @alice", sel)).toBe("hi <@u1>");
  });

  it("converts a role mention to <@&id>", () => {
    const sel: MentionSelection[] = [{ id: "r1", name: "Mods", type: "role" }];
    expect(convertMentionTokens("ping @Mods", sel)).toBe("ping <@&r1>");
  });

  it("matches the name case-insensitively", () => {
    const sel: MentionSelection[] = [{ id: "u1", name: "Alice", type: "user" }];
    expect(convertMentionTokens("@alice and @ALICE", sel)).toBe("<@u1> and <@u1>");
  });

  it("prefers the longest name so it can't partially match a shorter one", () => {
    const sel: MentionSelection[] = [
      { id: "r1", name: "Level", type: "role" },
      { id: "r2", name: "Level 3", type: "role" },
    ];
    expect(convertMentionTokens("@Level 3", sel)).toBe("<@&r2>");
  });

  it("regex-escapes special characters in names", () => {
    const sel: MentionSelection[] = [{ id: "u1", name: "a.b+c", type: "user" }];
    expect(convertMentionTokens("hey @a.b+c", sel)).toBe("hey <@u1>");
    // The literal "@axbxc" must NOT match — proves "." wasn't a wildcard.
    expect(convertMentionTokens("hey @axbxc", sel)).toBe("hey @axbxc");
  });

  it("returns the text unchanged when there are no selections", () => {
    expect(convertMentionTokens("plain @text", [])).toBe("plain @text");
  });
});
