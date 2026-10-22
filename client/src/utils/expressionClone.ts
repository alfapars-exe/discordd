/**
 * expressionClone — pure client rules for the `copyable` clone flow
 * (Faz D2, Karar D2-22). UX only: the server re-checks every gate
 * (target ManageExpressions, source membership, copyable, same-server,
 * caps, name collisions).
 */

import { hasPermission, Permissions } from "./permissions";
import type { APIResponse } from "../types";
import type { ExpressionKind } from "../types/expression";

export type CloneableItem = {
  id: string;
  server_id: string;
  copyable: boolean;
  cloned_from: string | null;
};

export type CloneContext = {
  /** Active server (clone target); null in DMs / home. */
  activeServerId: string | null;
  /** Caller's effective permissions on the active server. */
  perms: number;
  /** Items of the same kind already on the active server. */
  existing: readonly Pick<CloneableItem, "cloned_from">[];
};

/** Whether "add to {active server}" may be offered for this catalog item. */
export function canCloneHere(item: CloneableItem | null | undefined, ctx: CloneContext): boolean {
  if (!item) return false;
  if (!ctx.activeServerId) return false;
  if (!item.copyable || item.cloned_from !== null) return false;
  if (item.server_id === ctx.activeServerId) return false;
  if (!hasPermission(ctx.perms, Permissions.ManageExpressions)) return false;
  return !alreadyCloned(item.id, ctx.existing);
}

/** True when the target already holds a clone of `sourceId`. */
export function alreadyCloned(
  sourceId: string,
  existing: readonly Pick<CloneableItem, "cloned_from">[],
): boolean {
  return existing.some((e) => e.cloned_from === sourceId);
}

const CLONE_ERROR_KEYS: Record<string, string> = {
  EXPRESSION_NOT_COPYABLE: "notCopyable",
  EXPRESSION_CLONE_SAME_SERVER: "cloneSameServer",
  EXPRESSION_NOT_FOUND: "expressionNotFound",
  EXPRESSION_NAME_TAKEN: "nameTaken",
};

/** Map a failed clone response to an `expressions` i18n key. */
export function cloneErrorKey(
  res: Pick<APIResponse, "code" | "status">,
  kind: ExpressionKind,
): string {
  if (res.code === "EXPRESSION_LIMIT_REACHED") {
    return kind === "sticker" ? "stickerLimitReached" : "limitReached";
  }
  if (res.code && CLONE_ERROR_KEYS[res.code]) return CLONE_ERROR_KEYS[res.code];
  if (res.status === 409) return "nameTaken";
  if (res.status === 404) return "expressionNotFound";
  return "cloneFailed";
}
