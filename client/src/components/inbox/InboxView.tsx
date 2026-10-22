/** InboxView — full-tab Inbox: every DM conversation, newest activity first. */

import { useTranslation } from "react-i18next";
import InboxList from "./InboxList";

function InboxView() {
  const { t } = useTranslation("inbox");
  return (
    <div className="inbox-view">
      <div className="inbox-view-header">
        <h2 className="inbox-view-title">{t("inbox")}</h2>
      </div>
      <div className="inbox-view-content">
        <InboxList />
      </div>
    </div>
  );
}

export default InboxView;
