/** MemberCardSelfStatus — self status picker section of the MemberCard
 *  popover (online / idle / dnd / invisible). Rendered only when the
 *  viewer opens their own card; the parent owns the isMe guard. */

import { useTranslation } from "react-i18next";
import type { UserStatus } from "../../../types";

const SELF_STATUS_OPTIONS: {
  value: "online" | "idle" | "dnd" | "offline";
  labelKey: string;
  colorClass: string;
}[] = [
  { value: "online", labelKey: "online", colorClass: "ub-sp-green" },
  { value: "idle", labelKey: "idle", colorClass: "ub-sp-yellow" },
  { value: "dnd", labelKey: "dnd", colorClass: "ub-sp-red" },
  { value: "offline", labelKey: "invisible", colorClass: "ub-sp-gray" },
];

type Props = {
  manualStatus: UserStatus;
  handleSetStatus: (status: "online" | "idle" | "dnd" | "offline") => void;
};

function MemberCardSelfStatus({ manualStatus, handleSetStatus }: Props) {
  const { t } = useTranslation("common");

  return (
    <>
      <div className="mc-divider" />
      <div className="mc-section-title">{t("setStatus")}</div>
      <div className="mc-status-list">
        {SELF_STATUS_OPTIONS.map((opt) => {
          const isActive = manualStatus === opt.value;
          return (
            <button
              key={opt.value}
              className={`mc-status-item${isActive ? " active" : ""}`}
              onClick={() => handleSetStatus(opt.value)}
              type="button"
            >
              <span className={`ub-sp-dot ${opt.colorClass}`} />
              <span className="mc-status-label">{t(opt.labelKey)}</span>
              {isActive && (
                <svg className="mc-status-check" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z" />
                </svg>
              )}
            </button>
          );
        })}
      </div>
    </>
  );
}

export default MemberCardSelfStatus;
