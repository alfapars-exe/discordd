import type { FriendshipWithUser } from "../types/friend";
import type { UserStatus } from "../types/user";
import { gameActivityKey } from "../stores/gameActivityStore";
import { isGameActivityId, isGameActivityName } from "./gameActivity";

const MAX_EPOCH_LENGTH = 256;
const MAX_LABEL_LENGTH = 128;
const MAX_RESULTS = 5;

export interface OverlayActivityGame {
  id: string;
  name: string;
  started_at: string;
  canonical_game_id?: "steam:730";
}

export interface OverlayActivityEntry {
  revision: number;
  game: OverlayActivityGame | null;
}

export interface OverlayActivityItem {
  userId: string;
  label: string;
  gameName: string;
}
export type AuthorizedOverlayActivity = OverlayActivityItem & { game: OverlayActivityGame; revision: number };

export interface OverlayActivityProjectionInput {
  /** Ownership metadata from the current game-activity store snapshot. */
  ownerId: string | null;
  authGeneration: number;
  currentOwnerId: string | null;
  currentAuthGeneration: number;
  /** Nonempty ready epoch; the store itself fences updates to this epoch. */
  epoch: string | null;
  entries: Readonly<Record<string, OverlayActivityEntry | undefined>>;
  friendOwnerId: string | null;
  friendAuthGeneration: number;
  friendsStatus: "idle" | "loading" | "ready" | "error";
  friends: readonly FriendshipWithUser[];
  blockedUserIds: readonly string[];
  ignoredUsers?: Readonly<Record<string, boolean>>;
  statusByUserId: Readonly<Record<string, UserStatus | undefined>>;
}

function safeLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value.trim();
  if (!label || label.length > MAX_LABEL_LENGTH
    || Array.from(label).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return null;
  return label;
}

function visibleStatus(status: unknown): status is "online" | "idle" | "dnd" {
  return status === "online" || status === "idle" || status === "dnd";
}

function validGame(value: unknown): value is OverlayActivityGame {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const game = value as Record<string, unknown>;
  return isGameActivityId(game.id)
    && isGameActivityName(game.name)
    && typeof game.started_at === "string"
    && Number.isFinite(Date.parse(game.started_at))
    && (game.canonical_game_id === undefined || game.canonical_game_id === "steam:730");
}

/**
 * Produce a small, privacy-scoped friend activity projection for the native overlay.
 * Only the global activity key is read; server-scoped grants are intentionally ignored.
 */
export function projectOverlayActivity(input: OverlayActivityProjectionInput): OverlayActivityItem[] {
  return projectAuthorizedOverlayActivity(input, MAX_RESULTS).map(({ userId, label, gameName }) => ({ userId, label, gameName }));
}

/** Same authorization for transient notices, without the five visible-widget-row cap. */
export function projectAuthorizedOverlayActivity(input: OverlayActivityProjectionInput, limit = 10_000): AuthorizedOverlayActivity[] {
  if (!input.ownerId || input.ownerId !== input.currentOwnerId
    || !Number.isSafeInteger(input.authGeneration) || input.authGeneration !== input.currentAuthGeneration
    || input.friendOwnerId !== input.currentOwnerId || input.friendAuthGeneration !== input.currentAuthGeneration
    || input.friendsStatus !== "ready"
    || typeof input.epoch !== "string" || input.epoch.length === 0 || input.epoch.length > MAX_EPOCH_LENGTH) return [];

  const blocked = new Set(input.blockedUserIds);
  const seen = new Set<string>();
  const result: AuthorizedOverlayActivity[] = [];
  for (const friend of input.friends) {
    if (result.length >= Math.min(10_000, limit)) break;
    if (friend.status !== "accepted" || !isGameActivityId(friend.user_id)
      || friend.user_id === input.ownerId || blocked.has(friend.user_id) || input.ignoredUsers?.[friend.user_id] === true || seen.has(friend.user_id)) continue;
    seen.add(friend.user_id);

    const status = Object.prototype.hasOwnProperty.call(input.statusByUserId, friend.user_id)
      ? input.statusByUserId[friend.user_id]
      : friend.user_status;
    if (!visibleStatus(status)) continue;

    const entry = input.entries[gameActivityKey(friend.user_id)];
    if (!entry || !Number.isSafeInteger(entry.revision) || entry.revision < 1 || !validGame(entry.game)) continue;

    const label = safeLabel(friend.display_name) ?? safeLabel(friend.username);
    if (!label) continue;
    result.push({ userId: friend.user_id, label, gameName: entry.game.name, game: entry.game, revision: entry.revision });
  }
  return result;
}
