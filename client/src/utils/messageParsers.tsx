/**
 * messageParsers.tsx — Pure parsing helpers for chat messages.
 *
 * Single responsibility: convert raw message text into structured React
 * output (mentions, invite cards, GIF embeds, links) without touching
 * component state or side effects. All inputs are passed in; no closures
 * over component locals — these helpers are easy to test in isolation.
 *
 * Also hosts role-derived display helpers (badge type, color) which live
 * here since they're consumed alongside content rendering.
 */

import type React from "react";
import InviteCard from "../components/chat/InviteCard";
import type { MemberWithRoles } from "../types";

/** Server invite link pattern. Captures the 16-hex invite code. */
export const INVITE_REGEX = /^https?:\/\/[^\s/]+\/invite\/([a-f0-9]{16})$/i;

/** Klipy GIF embed pattern — message body that is solely a Klipy URL. */
export const KLIPY_REGEX = /^https?:\/\/static\.klipy\.com\/[^\s]+$/;

/**
 * Captures three token kinds: <@id>/<@&id> structured mentions,
 * @word legacy mentions, and bare URLs. Used with String.split to
 * yield text segments + mention/url tokens in order.
 */
export const TOKEN_REGEX = /(<@&?[a-f0-9]+>|@\w+|https?:\/\/[^\s<]+)/gi;

type RoleLike = { id: string; name: string; color: string; position: number };
type MemberLike = { id: string; username: string; display_name: string | null };

/** Highest-position role's *type*: "admin" | "mod" | null (used for avatar badge). */
export function getRoleType(member: MemberWithRoles | undefined): "admin" | "mod" | null {
  if (!member || member.roles.length === 0) return null;
  const highest = member.roles.reduce((h, r) => (r.position > h.position ? r : h));
  const name = highest.name.toLowerCase();
  if (name.includes("admin") || name.includes("owner")) return "admin";
  if (name.includes("mod")) return "mod";
  return null;
}

/** Highest-position role's color (used to tint the username). */
export function getHighestRoleColor(member: MemberWithRoles | undefined): string | undefined {
  if (!member || member.roles.length === 0) return undefined;
  const highest = member.roles.reduce((h, r) => (r.position > h.position ? r : h));
  return highest.color || undefined;
}

/**
 * Render a message body into JSX nodes:
 *   - <@id> or <@&roleId> token mentions become styled spans
 *   - legacy @username / @rolename mentions are resolved against members/roles
 *   - invite URLs become InviteCard
 *   - Klipy URLs (when the entire message is a single Klipy link) become an inline GIF
 *   - other URLs become anchor tags
 *   - everything else stays as plain text
 *
 * Pure: no component state, no React hooks. Caller passes the lookup data.
 */
export function renderMessageContent(
  text: string | null,
  roles: RoleLike[],
  members: MemberLike[],
): React.ReactNode {
  if (!text) return null;

  // Whole-message Klipy → render as inline GIF (entire link is the embed)
  const trimmed = text.trim();
  if (KLIPY_REGEX.test(trimmed)) {
    return (
      <a href={trimmed} target="_blank" rel="noopener noreferrer">
        <img src={trimmed} alt="GIF" className="msg-gif-embed" loading="lazy" />
      </a>
    );
  }

  const roleById = new Map<string, { name: string; color: string }>();
  for (const r of roles) roleById.set(r.id, { name: r.name, color: r.color });

  const memberById = new Map<string, { username: string; displayName: string | null }>();
  for (const m of members) memberById.set(m.id, { username: m.username, displayName: m.display_name });

  // Legacy: case-insensitive @rolename lookup for messages predating <@&id>
  const roleByName = new Map<string, { color: string }>();
  for (const r of roles) roleByName.set(r.name.toLowerCase(), { color: r.color });

  const parts = text.split(TOKEN_REGEX);
  return parts.map((part, i) => {
    // Structured role mention <@&roleId>
    const roleTokenMatch = part.match(/^<@&([a-f0-9]+)>$/);
    if (roleTokenMatch) {
      const role = roleById.get(roleTokenMatch[1]);
      if (role) {
        return (
          <span
            key={i}
            className="msg-role-mention"
            style={{ color: role.color, backgroundColor: `${role.color}20` }}
          >
            @{role.name}
          </span>
        );
      }
      return <span key={i} className="msg-mention">@unknown-role</span>;
    }

    // Structured user mention <@userId>
    const userTokenMatch = part.match(/^<@([a-f0-9]+)>$/);
    if (userTokenMatch) {
      const member = memberById.get(userTokenMatch[1]);
      if (member) {
        return (
          <span key={i} className="msg-mention">
            @{member.displayName ?? member.username}
          </span>
        );
      }
      return <span key={i} className="msg-mention">@unknown-user</span>;
    }

    // Legacy @word — try role first, then user, else leave as-is
    if (/^@\w+$/.test(part)) {
      const name = part.slice(1).toLowerCase();
      const roleInfo = roleByName.get(name);
      if (roleInfo) {
        return (
          <span
            key={i}
            className="msg-role-mention"
            style={{ color: roleInfo.color, backgroundColor: `${roleInfo.color}20` }}
          >
            {part}
          </span>
        );
      }
      const mentionedMember = members.find((m) => m.username.toLowerCase() === name);
      if (mentionedMember) {
        return (
          <span key={i} className="msg-mention">
            @{mentionedMember.display_name ?? mentionedMember.username}
          </span>
        );
      }
      return part;
    }

    // Server invite URL → invite card
    const inviteMatch = part.match(INVITE_REGEX);
    if (inviteMatch) {
      return <InviteCard key={i} code={inviteMatch[1]} />;
    }

    // Generic URL → clickable link
    if (/^https?:\/\//i.test(part)) {
      return (
        <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="msg-link">
          {part}
        </a>
      );
    }

    return part;
  });
}

/**
 * Extract URLs eligible for link-preview cards.
 * Excludes invite + Klipy URLs (those have their own renderers).
 * Caps at 5 to keep message height bounded.
 */
export function getMessagePreviewUrls(text: string | null | undefined): string[] {
  if (!text) return [];
  const matches = text.match(/https?:\/\/[^\s<]+/gi);
  if (!matches) return [];
  const unique = [...new Set(matches)];
  return unique.filter((u) => !INVITE_REGEX.test(u) && !KLIPY_REGEX.test(u)).slice(0, 5);
}
