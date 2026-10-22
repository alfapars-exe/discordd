/**
 * messageParsers.tsx — Pure parsing helpers for chat messages.
 *
 * Single responsibility: convert raw message text into structured React
 * output (markdown-lite, custom emojis, mentions, invite cards, GIF embeds,
 * links) without touching component state or side effects. All inputs are
 * passed in; no closures over component locals — these helpers are easy to
 * test in isolation.
 *
 * Also hosts role-derived display helpers (badge type, color) which live
 * here since they're consumed alongside content rendering.
 */

import type React from "react";
import InviteCard from "../components/chat/InviteCard";
import MarkdownSpoiler from "../components/chat/MarkdownSpoiler";
import MessageCustomEmoji from "../components/chat/MessageCustomEmoji";
import StickerMessage from "../components/chat/StickerMessage";
import type { MemberWithRoles } from "../types";
import { parseCustomEmojiToken } from "./expressionTokens";
import { parseStickerToken } from "./stickerTokens";
import { collectAtomsOutsideSpoilers, parseMarkdownLite, type MdNode } from "./markdownLite";
import "../styles/expressions.css";

/** Server invite link pattern. Captures the 16-hex invite code. */
export const INVITE_REGEX = /^https?:\/\/[^\s/]+\/invite\/([a-f0-9]{16})$/i;

/** Klipy GIF embed pattern — message body that is solely a Klipy URL. */
export const KLIPY_REGEX = /^https?:\/\/static\.klipy\.com\/[^\s]+$/;

/**
 * Captures four token kinds: custom emoji tokens <:name:id> / <a:name:id>
 * (first, so a token is never mistaken for anything else), <@id>/<@&id>
 * structured mentions, @word legacy mentions, and bare URLs. Used as the
 * markdown-lite atom pattern: every match is an opaque leaf that delimiter
 * parsing never looks inside. URLs stop at `|` so `||https://x||` keeps
 * its closing spoiler marker (and the link stays hidden + unpreviewed).
 *
 * Character class [a-z0-9] (not just hex) covers both UUID-style IDs
 * AND legacy seed role IDs from earlier database migrations. Without
 * this, role mentions seeded from an older Mqvi snapshot would render
 * as raw `<@&abc-123>` text instead of as a styled mention chip.
 */
export const TOKEN_REGEX =
  /(<a?:[a-z0-9_]{2,32}:[a-f0-9]{16}>|<@&?[a-z0-9]+>|@\w+|https?:\/\/[^\s<|]+)/gi;

/** Whole message made only of custom emoji tokens (+ whitespace) → jumbo. */
const JUMBO_ONLY = /^(?:<a?:[a-z0-9_]{2,32}:[a-f0-9]{16}>\s*)+$/;
const JUMBO_MAX_TOKENS = 27;
const URL_ATOM = /^https?:\/\//i;

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

/** Lookup tables shared by every token renderer of one message. */
type RenderCtx = {
  roleById: Map<string, { name: string; color: string }>;
  memberById: Map<string, { username: string; displayName: string | null }>;
  roleByName: Map<string, { color: string }>;
  members: MemberLike[];
  jumbo: boolean;
};

/**
 * Render one atom (custom emoji / mention / invite / URL). Unknown or
 * malformed atoms fall back to their raw text — the same per-part behavior
 * renderMessageContent had before markdown-lite.
 */
function renderToken(part: string, key: string, ctx: RenderCtx): React.ReactNode {
  // Custom emoji <:name:id> / <a:name:id>. Case-sensitive re-check: the
  // split regex is /i, but a URL may only ever carry a lowercase 16-hex id.
  const emoji = parseCustomEmojiToken(part);
  if (emoji) {
    return (
      <MessageCustomEmoji
        key={key}
        id={emoji.id}
        name={emoji.name}
        animated={emoji.animated}
        size={ctx.jumbo ? "jumbo" : "inline"}
      />
    );
  }

  // Structured role mention <@&roleId>
  const roleTokenMatch = part.match(/^<@&([a-z0-9]+)>$/);
  if (roleTokenMatch) {
    const role = ctx.roleById.get(roleTokenMatch[1]);
    if (role) {
      return (
        <span
          key={key}
          className="msg-role-mention"
          style={{ color: role.color, backgroundColor: `${role.color}20` }}
        >
          @{role.name}
        </span>
      );
    }
    return <span key={key} className="msg-mention">@unknown-role</span>;
  }

  // Structured user mention <@userId>
  const userTokenMatch = part.match(/^<@([a-z0-9]+)>$/);
  if (userTokenMatch) {
    const member = ctx.memberById.get(userTokenMatch[1]);
    if (member) {
      return (
        <span key={key} className="msg-mention">
          @{member.displayName ?? member.username}
        </span>
      );
    }
    return <span key={key} className="msg-mention">@unknown-user</span>;
  }

  // Legacy @word — try role first, then user, else leave as-is
  if (/^@\w+$/.test(part)) {
    const name = part.slice(1).toLowerCase();
    const roleInfo = ctx.roleByName.get(name);
    if (roleInfo) {
      return (
        <span
          key={key}
          className="msg-role-mention"
          style={{ color: roleInfo.color, backgroundColor: `${roleInfo.color}20` }}
        >
          {part}
        </span>
      );
    }
    const mentionedMember = ctx.members.find((m) => m.username.toLowerCase() === name);
    if (mentionedMember) {
      return (
        <span key={key} className="msg-mention">
          @{mentionedMember.display_name ?? mentionedMember.username}
        </span>
      );
    }
    return part;
  }

  // Server invite URL → invite card
  const inviteMatch = part.match(INVITE_REGEX);
  if (inviteMatch) {
    return <InviteCard key={key} code={inviteMatch[1]} />;
  }

  // Generic URL → clickable link
  if (URL_ATOM.test(part)) {
    return (
      <a key={key} href={part} target="_blank" rel="noopener noreferrer" className="msg-link">
        {part}
      </a>
    );
  }

  return part;
}

/** AST → React nodes. Only element creation + text children — never raw HTML. */
function renderNodes(nodes: MdNode[], ctx: RenderCtx, keyPrefix: string): React.ReactNode[] {
  return nodes.map((node, i) => {
    const key = `${keyPrefix}${i}`;
    switch (node.type) {
      case "text":
        return node.value;
      case "atom":
        return renderToken(node.value, key, ctx);
      case "code":
        return <code key={key}>{node.value}</code>;
      case "codeBlock":
        return (
          <pre key={key} className="msg-code-block">
            <code>{node.value}</code>
          </pre>
        );
      case "strong":
        return <strong key={key}>{renderNodes(node.children, ctx, `${key}.`)}</strong>;
      case "em":
        return <em key={key}>{renderNodes(node.children, ctx, `${key}.`)}</em>;
      case "spoiler":
        return (
          <MarkdownSpoiler key={key}>{renderNodes(node.children, ctx, `${key}.`)}</MarkdownSpoiler>
        );
    }
    return null;
  });
}

function isJumboEmojiMessage(trimmed: string): boolean {
  if (!JUMBO_ONLY.test(trimmed)) return false;
  let count = 0;
  for (const ch of trimmed) if (ch === "<") count++;
  return count <= JUMBO_MAX_TOKENS;
}

/**
 * Render a message body into JSX nodes:
 *   - Klipy URLs (when the entire message is a single Klipy link) become an inline GIF
 *   - markdown-lite: **bold**, *italic* / _italic_, `code`, ```blocks```, ||spoilers||
 *   - <:name:id> / <a:name:id> custom emoji tokens become images (jumbo when alone)
 *   - <@id> or <@&roleId> token mentions become styled spans
 *   - legacy @username / @rolename mentions are resolved against members/roles
 *   - invite URLs become InviteCard
 *   - other URLs become anchor tags
 *   - everything else stays as plain text (React text nodes only)
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

  // Whole-message sticker token (Faz D2) — anchored exact match only; a
  // token inside other text stays literal text.
  const sticker = parseStickerToken(trimmed);
  if (sticker) {
    return <StickerMessage id={sticker.id} name={sticker.name} animated={sticker.animated} />;
  }

  const roleById = new Map<string, { name: string; color: string }>();
  for (const r of roles) roleById.set(r.id, { name: r.name, color: r.color });

  const memberById = new Map<string, { username: string; displayName: string | null }>();
  for (const m of members) memberById.set(m.id, { username: m.username, displayName: m.display_name });

  // Legacy: case-insensitive @rolename lookup for messages predating <@&id>
  const roleByName = new Map<string, { color: string }>();
  for (const r of roles) roleByName.set(r.name.toLowerCase(), { color: r.color });

  const jumbo = isJumboEmojiMessage(trimmed);
  const ctx: RenderCtx = { roleById, memberById, roleByName, members, jumbo };
  const rendered = renderNodes(parseMarkdownLite(text, TOKEN_REGEX), ctx, "");

  if (jumbo) return <span className="msg-emoji-jumbo">{rendered}</span>;
  return rendered;
}

/**
 * Extract URLs eligible for link-preview cards.
 * Excludes invite + Klipy URLs (those have their own renderers) and every
 * URL inside code or a spoiler (a preview card would reveal a hidden link).
 * Caps at 5 to keep message height bounded.
 */
export function getMessagePreviewUrls(text: string | null | undefined): string[] {
  if (!text) return [];
  const atoms = collectAtomsOutsideSpoilers(parseMarkdownLite(text, TOKEN_REGEX));
  const urls = atoms.filter((a) => URL_ATOM.test(a));
  if (urls.length === 0) return [];
  const unique = [...new Set(urls)];
  return unique.filter((u) => !INVITE_REGEX.test(u) && !KLIPY_REGEX.test(u)).slice(0, 5);
}
