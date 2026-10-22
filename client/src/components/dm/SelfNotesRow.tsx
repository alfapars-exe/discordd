/**
 * SelfNotesRow — pinned "My Notes" row above the DM list. Opens the user's
 * self-DM channel (created server-side on first click). The self channel is
 * filtered out of the normal DM list and the inbox so this is its only entry.
 */

import { useTranslation } from "react-i18next";
import { useDMStore } from "../../stores/dmStore";
import { useAuthStore } from "../../stores/authStore";

type SelfNotesRowProps = {
  /** Same signature as DMSection's handleDMClick: (channelId, tabLabel). */
  onOpen: (dmId: string, label: string) => void;
};

function SelfNotesRow({ onOpen }: SelfNotesRowProps) {
  const { t } = useTranslation("dm");
  const currentUserId = useAuthStore((s) => s.user?.id);
  const ensureSelfChannel = useDMStore((s) => s.ensureSelfChannel);
  const selfChannelId = useDMStore(
    (s) => s.channels.find((ch) => ch.other_user.id === currentUserId)?.id ?? null
  );
  const isActive = useDMStore((s) => s.selectedDMId !== null && s.selectedDMId === selfChannelId);

  async function handleClick() {
    const id = selfChannelId ?? (await ensureSelfChannel());
    if (id) onOpen(id, t("myNotes"));
  }

  return (
    <button
      type="button"
      className={`ch-tree-item ch-tree-dm ch-tree-dm--self${isActive ? " active" : ""}`}
      onClick={() => void handleClick()}
      title={t("myNotesHint")}
    >
      <span className="ch-tree-dm-self-icon" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
        </svg>
      </span>
      <span className="ch-tree-label">{t("myNotes")}</span>
    </button>
  );
}

export default SelfNotesRow;
