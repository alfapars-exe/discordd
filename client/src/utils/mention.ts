import type { MentionSelection } from "../components/chat/MentionAutocomplete";

/**
 * Convert "@name" mentions in composed text into the wire tokens the server
 * expects: <@userId> for users, <@&roleId> for roles.
 *
 * Selections are sorted longest-name-first so a shorter name can't partially
 * match inside a longer one (e.g. "@Level 3" must not become "<@&id> 3" via a
 * "Level" selection), and each name is regex-escaped before the
 * case-insensitive replace.
 *
 * Pure — selections are passed in rather than read from a ref — so it is
 * unit-testable without React. Extracted verbatim from MessageInput.
 */
export function convertMentionTokens(text: string, selections: MentionSelection[]): string {
  let result = text;
  // Sort longest name first to prevent partial matches
  const sorted = [...selections].sort((a, b) => b.name.length - a.name.length);
  for (const m of sorted) {
    const token = m.type === "role" ? `<@&${m.id}>` : `<@${m.id}>`;
    // Replace all occurrences of @name (case-insensitive)
    const escaped = m.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(`@${escaped}`, "gi"), token);
  }
  return result;
}
