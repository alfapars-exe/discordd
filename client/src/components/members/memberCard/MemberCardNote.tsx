/**
 * MemberCardNote — private note field on another user's profile card.
 * Saves on blur or Ctrl+Enter when the text changed; shows a character
 * counter against USER_NOTE_MAX_LENGTH and the "last edited" relative time.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useUserNoteStore } from "../../../stores/userNoteStore";
import { useToastStore } from "../../../stores/toastStore";
import { USER_NOTE_MAX_LENGTH } from "../../../api/userNotes";
import { formatRelativePast } from "../../../utils/dateFormat";

type Props = {
  userId: string;
};

function MemberCardNote({ userId }: Props) {
  const { t, i18n } = useTranslation("common");
  const note = useUserNoteStore((s) => s.notesByUserId[userId]);
  const fetchNote = useUserNoteStore((s) => s.fetchNote);
  const saveNote = useUserNoteStore((s) => s.saveNote);
  const addToast = useToastStore((s) => s.addToast);
  // null = not yet synced from the store (first fetch pending).
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void fetchNote(userId);
  }, [userId, fetchNote]);

  const value = draft ?? note?.note ?? "";
  const tooLong = value.length > USER_NOTE_MAX_LENGTH;

  async function commit() {
    if (draft === null || saving) return;
    const next = draft;
    if (next === (note?.note ?? "")) {
      setDraft(null);
      return;
    }
    if (next.length > USER_NOTE_MAX_LENGTH) {
      addToast("warning", t("userNoteTooLong", { max: USER_NOTE_MAX_LENGTH }));
      return;
    }
    setSaving(true);
    const ok = await saveNote(userId, next);
    setSaving(false);
    if (ok) {
      setDraft(null);
      addToast("success", t("userNoteSaved"));
    } else {
      addToast("error", t("userNoteSaveError"));
    }
  }

  return (
    <div className="member-card-note">
      <div className="member-card-note-label">
        <span>{t("userNote")}</span>
        <span className={`member-card-note-count${tooLong ? " over" : ""}`}>
          {value.length}/{USER_NOTE_MAX_LENGTH}
        </span>
      </div>
      <textarea
        className="member-card-note-input"
        value={value}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.ctrlKey) {
            e.preventDefault();
            void commit();
          }
        }}
        placeholder={t("userNotePlaceholder")}
        aria-label={t("userNote")}
        rows={2}
        disabled={saving}
      />
      {note?.updated_at && (
        <div className="member-card-note-edited">
          {t("userNoteLastEdited", { when: formatRelativePast(note.updated_at, i18n.language) })}
        </div>
      )}
    </div>
  );
}

export default MemberCardNote;
