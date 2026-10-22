/**
 * InboxList — DM conversation rows shared by the Inbox popover (capped) and
 * the full Inbox tab. Message requests (incoming pending DMs) render first
 * under their own heading, then the normal conversations.
 */

import { useTranslation } from "react-i18next";
import Avatar from "../shared/Avatar";
import { useInboxDMs, type InboxDMRow } from "../../hooks/useInboxDMs";

type InboxListProps = {
  limit?: number;
  /** Called after a row is opened (popovers close themselves here). */
  onNavigate?: () => void;
};

function InboxRow({ row, onOpen }: { row: InboxDMRow; onOpen: (row: InboxDMRow) => void }) {
  const { t } = useTranslation("inbox");
  const { dm, name, preview, isOwn, unread } = row;
  return (
    <button
      type="button"
      className={`inbox-row${unread > 0 ? " unread" : ""}${dm.is_muted ? " muted" : ""}`}
      onClick={() => onOpen(row)}
    >
      <Avatar name={name} avatarUrl={dm.other_user.avatar_url} size={32} isCircle />
      <span className="inbox-row-body">
        <span className="inbox-row-name">{name}</span>
        <span className="inbox-row-preview">
          {isOwn && preview && <span className="inbox-row-you">{t("youPrefix")} </span>}
          {preview}
        </span>
      </span>
      {unread > 0 && <span className="inbox-row-badge">{unread > 99 ? "99+" : unread}</span>}
    </button>
  );
}

function InboxList({ limit, onNavigate }: InboxListProps) {
  const { t } = useTranslation("inbox");
  const { requests, conversations, openDM } = useInboxDMs(limit);

  function handleOpen(row: InboxDMRow) {
    openDM(row);
    onNavigate?.();
  }

  if (requests.length === 0 && conversations.length === 0) {
    return <div className="inbox-empty">{t("empty")}</div>;
  }

  return (
    <div className="inbox-list">
      {requests.length > 0 && (
        <>
          <div className="inbox-group-label">
            {t("messageRequests")}
            <span className="inbox-group-count">{requests.length}</span>
          </div>
          {requests.map((row) => (
            <InboxRow key={row.dm.id} row={row} onOpen={handleOpen} />
          ))}
        </>
      )}
      {conversations.map((row) => (
        <InboxRow key={row.dm.id} row={row} onOpen={handleOpen} />
      ))}
    </div>
  );
}

export default InboxList;
