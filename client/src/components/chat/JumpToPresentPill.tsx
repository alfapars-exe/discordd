/**
 * JumpToPresentPill — floating "Jump to present" button shown over the
 * message list while a jumped-to window has newer messages after it.
 */

import { useTranslation } from "react-i18next";

type JumpToPresentPillProps = {
  onClick: () => void;
};

function JumpToPresentPill({ onClick }: JumpToPresentPillProps) {
  const { t } = useTranslation("saved");
  return (
    <button type="button" className="jump-present-pill" onClick={onClick}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="6 9 12 15 18 9" />
      </svg>
      <span>{t("jumpToPresent")}</span>
    </button>
  );
}

export default JumpToPresentPill;
