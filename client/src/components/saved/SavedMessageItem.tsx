/**
 * SavedMessageItem — one bookmark: author, origin (channel · server / DM),
 * text (or the E2EE / attachments fallback), an inline note, and the
 * jump / remove actions. Attachment previews are deliberately NOT rendered —
 * the saved ref only carries a count.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import Avatar from "../shared/Avatar";
import SpamPreview from "../chat/SpamPreview";
import { useSavedStore } from "../../stores/savedStore";
import { useOpenAtMessage } from "../../hooks/useOpenAtMessage";
import { formatRelativePast } from "../../utils/dateFormat";
import type { SavedMessage } from "../../types";

type SavedMessageItemProps = {
  item: SavedMessage;
};

function SavedMessageItem({ item }: SavedMessageItemProps) {
  const { t, i18n } = useTranslation("saved");
  const remove = useSavedStore((s) => s.remove);
  const setNote = useSavedStore((s) => s.setNote);
  const { openAtMessage, openAtDMMessage } = useOpenAtMessage();
  const [noteDraft, setNoteDraft] = useState(item.note ?? "");

  // Stub rows (deleted / no longer readable) carry no ref: only Remove works.
  const ref = item.unavailable ? null : item.message ?? item.dm_message;
  const gone = !ref;
  const authorName = ref?.author?.display_name || ref?.author?.username || "";

  const origin = !ref
    ? ""
    : item.message
      ? t("inChannel", { channel: item.message.channel_name, server: item.message.server_name })
      : t("inDM");

  let body: string | null = null;
  if (ref) {
    if (ref.content) body = ref.content;
    else if (ref.encryption_version === 1) body = t("encrypted");
  }

  function handleJump() {
    if (gone) return;
    if (item.message) {
      void openAtMessage(
        item.message.server_id, item.message.channel_id, item.message.id, item.message.channel_name
      );
    } else if (item.dm_message) {
      void openAtDMMessage(item.dm_message.dm_channel_id, item.dm_message.id);
    }
  }

  function commitNote() {
    const next = noteDraft.trim();
    if (next === (item.note ?? "")) return;
    void setNote(item.id, next);
  }

  return (
    <div className="saved-item">
      <div className="saved-item-header">
        {ref && <Avatar name={authorName} avatarUrl={ref.author?.avatar_url ?? null} size={28} isCircle />}
        <span className="saved-item-meta">
          {ref && <span className="saved-item-author">{authorName}</span>}
          {origin && <span className="saved-item-origin">{origin}</span>}
        </span>
        {ref && (
          <span className="saved-item-time">{formatRelativePast(ref.created_at, i18n.language)}</span>
        )}
      </div>

      {gone ? (
        <p className="saved-item-gone">{t(item.unavailable ? "unavailable" : "messageGone")}</p>
      ) : (
        <>
          {body && <p className="saved-item-body"><SpamPreview kind={item.message ? "channel" : "dm"} message={ref}>{body}</SpamPreview></p>}
          {ref.attachment_count > 0 && (
            <p className="saved-item-attachments">
              {t("attachments", { count: ref.attachment_count })}
            </p>
          )}
        </>
      )}

      {!gone && (
        <textarea
          className="saved-item-note"
          value={noteDraft}
          onChange={(e) => setNoteDraft(e.target.value)}
          onBlur={commitNote}
          placeholder={t("notePlaceholder")}
          aria-label={t("editNote")}
          rows={1}
        />
      )}

      <div className="saved-item-actions">
        {!gone && (
          <button type="button" className="saved-item-btn" onClick={handleJump}>
            {t("jump")}
          </button>
        )}
        <button
          type="button"
          className="saved-item-btn saved-item-btn--danger"
          onClick={() => void remove(item.id)}
        >
          {t("unsave")}
        </button>
      </div>
    </div>
  );
}

export default SavedMessageItem;
