/** ConnectionBanner — WebSocket connection status indicator (connecting/disconnected/offline). */

import { useTranslation } from "react-i18next";
import { MAX_RECONNECT_ATTEMPTS, type ConnectionStatus } from "../../hooks/useWebSocket";

type ConnectionBannerProps = {
  status: ConnectionStatus;
  /** Current reconnect attempt (0 = initial connect or connected) */
  reconnectAttempt: number;
};

function ConnectionBanner({ status, reconnectAttempt }: ConnectionBannerProps) {
  const { t } = useTranslation("common");

  if (status === "connected") return null;

  function handleRefresh() {
    window.location.reload();
  }

  /** Banner text with retry count or disconnected/offline message */
  function getBannerText(): string {
    if (status === "offline") {
      return t("connectionOffline");
    }
    if (status === "disconnected") {
      return t("connectionFailed");
    }
    // connecting — initial attempt (0) or retry
    if (reconnectAttempt > 0) {
      return t("connectionRetrying", { attempt: reconnectAttempt, max: MAX_RECONNECT_ATTEMPTS });
    }
    return t("connectionConnecting");
  }

  return (
    <div className={`connection-banner ${status}`}>
      <span className="connection-banner-text">
        {getBannerText()}
      </span>
      {/* Refresh is pointless while the client itself is offline — the
          reconnect resumes automatically on the browser "online" event. */}
      {status !== "offline" && (
        <button className="connection-banner-btn" onClick={handleRefresh}>
          {t("connectionRefresh")}
        </button>
      )}
    </div>
  );
}

export default ConnectionBanner;
