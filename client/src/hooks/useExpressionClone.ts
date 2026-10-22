/**
 * useExpressionClone — clone a `copyable` emoji/sticker into a target server
 * (Faz D2, D2-22). Wraps the clone API, upserts the new row into the right
 * store (the server also broadcasts server_{emoji|sticker}_create; upsert is
 * idempotent) and reports the result with a toast.
 *
 * Shared by ExpressionInfoPopover and ExpressionCloneSection so components
 * never call the API directly.
 */

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { cloneEmoji, cloneSticker } from "../api/expressionClone";
import { useEmojiStore } from "../stores/emojiStore";
import { useStickerStore } from "../stores/stickerStore";
import { useToastStore } from "../stores/toastStore";
import { cloneErrorKey } from "../utils/expressionClone";
import type { ExpressionKind } from "../types/expression";

export function useExpressionClone(): (
  kind: ExpressionKind,
  targetServerId: string,
  sourceId: string,
) => Promise<boolean> {
  const { t } = useTranslation("expressions");
  const addToast = useToastStore((s) => s.addToast);

  return useCallback(
    async (kind, targetServerId, sourceId) => {
      if (kind === "emoji") {
        const res = await cloneEmoji(targetServerId, sourceId);
        if (res.success && res.data) {
          useEmojiStore.getState().handleCreate(res.data);
          addToast("success", t("copied"));
          return true;
        }
        addToast("error", t(cloneErrorKey(res, kind)));
        return false;
      }
      const res = await cloneSticker(targetServerId, sourceId);
      if (res.success && res.data) {
        useStickerStore.getState().handleCreate(res.data);
        addToast("success", t("copied"));
        return true;
      }
      addToast("error", t(cloneErrorKey(res, kind)));
      return false;
    },
    [addToast, t],
  );
}
