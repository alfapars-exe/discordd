/** InboxView — full-tab Inbox: every DM conversation, newest activity first. */

import { useTranslation } from "react-i18next";
import InboxList from "./InboxList";
import SpamInbox from "./SpamInbox";
import { useState } from "react";
import { useAuthStore } from "../../stores/authStore";
import { useInboxDMs } from "../../hooks/useInboxDMs";
import { useInboxReadTopShortcut } from "../../hooks/useInboxReadTopShortcut";

function InboxView({ panelId }: { panelId?: string }) {
  const { t } = useTranslation("inbox");
  const [spam, setSpam] = useState(false);
  const userId = useAuthStore((s) => s.user?.id);
  const { requests, conversations } = useInboxDMs();
  useInboxReadTopShortcut(!spam, panelId, requests, conversations);
  return (
    <div className="inbox-view">
      <div className="inbox-view-header">
        <h2 className="inbox-view-title">{t("inbox")}</h2>
        <button type="button" aria-pressed={spam} onClick={() => setSpam((value) => !value)}>{t(spam ? "inbox" : "spam")}</button>
      </div>
      <div className="inbox-view-content">
        {spam ? <SpamInbox key={userId} /> : <InboxList />}
      </div>
    </div>
  );
}

export default InboxView;
