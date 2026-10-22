/**
 * ExpressionInfoPopover — info card for a custom emoji / sticker clicked in
 * a message (Faz D2, Karar D2-22).
 *
 * - The item is looked up ONLY in the viewer's member catalog. When it is not
 *   there (the viewer is not in the source server) we show just `:name:` and
 *   a generic "from another server" line — never the server's name (D-5 /
 *   D2-15 privacy: the token alone must not reveal where it lives).
 * - "Add to {active server}" is offered only when `canCloneHere` allows it
 *   (catalog item, copyable, not itself a clone, different server,
 *   ManageExpressions on the active server, not already cloned there).
 *   DMs have no target server → no button. The server re-checks everything.
 * - All user-controlled strings render as React text nodes only.
 */

import { useContext, useMemo, useState, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { ChatContext } from "../../hooks/useChatContext";
import { useEmojiCatalog } from "../../hooks/useEmojiCatalog";
import { useStickerCatalog } from "../../hooks/useStickerCatalog";
import { useExpressionClone } from "../../hooks/useExpressionClone";
import { useAuthStore } from "../../stores/authStore";
import { useEmojiStore } from "../../stores/emojiStore";
import { useActiveMembers } from "../../stores/memberStore";
import { useServerStore } from "../../stores/serverStore";
import { useStickerStore } from "../../stores/stickerStore";
import { canCloneHere } from "../../utils/expressionClone";
import type { ExpressionKind, ServerEmoji, ServerSticker } from "../../types/expression";
import PopoverShell, { type PopoverAnchor } from "../inbox/PopoverShell";
import CustomEmoji from "../shared/CustomEmoji";
import StickerImage from "../shared/StickerImage";
import "../../styles/expressions.css";

type ExpressionInfoPopoverProps = {
  kind: ExpressionKind;
  id: string;
  name: string;
  animated: boolean;
  anchor: PopoverAnchor;
  onClose: () => void;
};

const EMPTY: never[] = [];

/** Keep clicks/touches inside the (body-portalled) card from reaching the message row. */
function stop(e: SyntheticEvent) {
  e.stopPropagation();
}

function ExpressionInfoPopover({ kind, id, name, animated, anchor, onClose }: ExpressionInfoPopoverProps) {
  const { t } = useTranslation("expressions");
  const emojiCatalog = useEmojiCatalog(kind === "emoji");
  const stickerCatalog = useStickerCatalog(kind === "sticker");
  const servers = useServerStore((s) => s.servers);
  const activeServerId = useServerStore((s) => s.activeServerId);
  const chat = useContext(ChatContext);
  const userId = useAuthStore((s) => s.user?.id);
  const members = useActiveMembers();
  const clone = useExpressionClone();
  const [pending, setPending] = useState(false);

  // Clone target: the active server, only while viewing one of its channels.
  const targetServerId =
    chat && chat.mode === "channel" && chat.serverId && chat.serverId === activeServerId
      ? activeServerId
      : null;
  const perms = members.find((m) => m.id === userId)?.effective_permissions ?? 0;

  const item: ServerEmoji | ServerSticker | null = useMemo(() => {
    if (kind === "sticker") return stickerCatalog.byId[id] ?? null;
    for (const list of Object.values(emojiCatalog.byServer)) {
      const hit = list.find((e) => e.id === id);
      if (hit) return hit;
    }
    return null;
  }, [kind, id, emojiCatalog.byServer, stickerCatalog.byId]);

  const existingEmojis = useEmojiStore((s) => (targetServerId ? s.byServer[targetServerId] : undefined));
  const existingStickers = useStickerStore((s) =>
    targetServerId ? s.byServer[targetServerId] : undefined,
  );
  const existing = (kind === "emoji" ? existingEmojis : existingStickers) ?? EMPTY;

  const showClone = canCloneHere(item, { activeServerId: targetServerId, perms, existing });
  const sourceServerName = item ? servers.find((s) => s.id === item.server_id)?.name : undefined;
  const targetServerName = targetServerId
    ? servers.find((s) => s.id === targetServerId)?.name ?? ""
    : "";
  const sticker = kind === "sticker" && item ? (item as ServerSticker) : null;

  const handleClone = async () => {
    if (!item || !targetServerId || pending) return;
    setPending(true);
    await clone(kind, targetServerId, item.id);
    setPending(false);
  };

  return (
    <PopoverShell anchor={anchor} onClose={onClose} ariaLabel={t(kind === "sticker" ? "stickers" : "emojis")}>
      <div
        className="expression-popover"
        onClick={stop}
        onKeyDown={stop}
        onContextMenu={stop}
        onTouchStart={stop}
        onTouchMove={stop}
        onTouchEnd={stop}
      >
        <div className="expression-popover-preview">
          {kind === "sticker" ? (
            <StickerImage id={id} name={name} animated={animated} size="picker" />
          ) : (
            <span className="msg-emoji-jumbo">
              <CustomEmoji id={id} name={name} animated={animated} size="jumbo" />
            </span>
          )}
        </div>
        <div className="expression-popover-body">
          {item ? (
            <>
              <div className="expression-popover-title">{item.display_name}</div>
              <div className="expression-popover-code">:{item.name}:</div>
              {sourceServerName && (
                <div className="expression-popover-meta">
                  {t("sourceServer", { server: sourceServerName })}
                </div>
              )}
              <div className="expression-popover-badges">
                {item.cloned_from !== null ? (
                  <span className="emoji-settings-badge">{t("cloneOf")}</span>
                ) : (
                  item.copyable && <span className="emoji-settings-badge">{t("copyableBadge")}</span>
                )}
              </div>
              {sticker && sticker.description && (
                <div className="expression-popover-desc">{sticker.description}</div>
              )}
              {sticker && sticker.tags.length > 0 && (
                <div className="expression-popover-tags">
                  {sticker.tags.map((tag) => (
                    <span key={tag} className="expression-popover-tag">
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="expression-popover-code">:{name}:</div>
              <div className="expression-popover-meta">{t("fromOtherServer")}</div>
            </>
          )}
          {showClone && (
            <button
              type="button"
              className="settings-btn expression-popover-clone"
              disabled={pending}
              onClick={() => void handleClone()}
            >
              {t("addToServer", { server: targetServerName })}
            </button>
          )}
        </div>
      </div>
    </PopoverShell>
  );
}

export default ExpressionInfoPopover;
