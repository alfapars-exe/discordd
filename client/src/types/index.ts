/**
 * Application-wide TypeScript types — barrel re-export.
 *
 * Mirrors backend Go structs. Naming: PascalCase, no "I" prefix.
 *
 * Domain modules (each file owns one bounded context):
 *
 *   user.ts        — identity + presence
 *   common.ts      — reusable building blocks (ReactionGroup)
 *   channel.ts     — text/voice/audit channels + categories + perm overrides
 *   message.ts     — server-channel messages + attachments + pins
 *   role.ts        — roles + members + badges + bans
 *   server.ts      — Server (community), ServerListItem
 *   invite.ts      — invite codes
 *   voice.ts       — LiveKit voice state
 *   dm.ts          — direct messages
 *   friend.ts      — friendships
 *   p2p.ts         — WebRTC P2P calls
 *   livekit.ts     — admin LiveKit instance management + metrics
 *   admin.ts       — platform-admin list views (servers/users/reports)
 *   feedback.ts    — feedback tickets + replies
 *   applog.ts      — runtime app logs
 *   audit.ts       — moderation event feed
 *   auth.ts        — login/register/tokens
 *   api.ts         — APIResponse envelope
 *   ws.ts          — WSMessage discriminated union + WSPayloadMap
 *   e2ee.ts        — Signal Protocol device + key + envelope shapes
 *   soundboard.ts  — uploaded sound clips
 *   music.ts       — music bot identity + queue
 *
 * Existing imports (`import { Message } from "../types"`) keep working
 * via the wildcard re-exports below. Prefer importing from the specific
 * domain module in new code (`import type { Message } from "../types/message"`)
 * to keep dependency graphs explicit, but the barrel stays for compat.
 */

export * from "./user";
export * from "./common";
export * from "./channel";
export * from "./message";
export * from "./role";
export * from "./server";
export * from "./invite";
export * from "./voice";
export * from "./dm";
export * from "./friend";
export * from "./p2p";
export * from "./livekit";
export * from "./admin";
export * from "./feedback";
export * from "./applog";
export * from "./audit";
export * from "./auth";
export * from "./api";
export * from "./ws";
export * from "./e2ee";
export * from "./soundboard";
export * from "./music";
