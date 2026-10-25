import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useOpenAtMessage } from "../../hooks/useOpenAtMessage";
import { useServerStore } from "../../stores/serverStore";
import { useDMStore } from "../../stores/dmStore";
import { useUIStore } from "../../stores/uiStore";
import { parseMessageRoute } from "../../utils/messageLinks";

/** Consumes a copied message URL once and leaves the app on its canonical route. */
export default function MessageDeepLinkHandler() {
  const location = useLocation();
  const navigate = useNavigate();
  const { openAtMessage, openAtDMMessage } = useOpenAtMessage();
  const servers = useServerStore((state) => state.servers);
  const handledPath = useRef<string | null>(null);
  const target = parseMessageRoute(location.pathname);

  useEffect(() => {
    if (!target || handledPath.current === location.pathname) return;

    // Server lists arrive with the ready event. Waiting when the list is
    // empty avoids opening a legacy tab without enough server identity to
    // switch workspaces. DM links do not depend on that list.
    if (target.kind === "channel" && servers.length === 0) return;

    handledPath.current = location.pathname;
    const open = async () => {
      if (target.kind === "channel") {
        const membership = servers.find((server) => server.id === target.serverId);
        if (membership) useServerStore.getState().setActiveServer(target.serverId);
        await openAtMessage(target.serverId, target.channelId, target.messageId);
      } else {
        const opened = await openAtDMMessage(target.channelId, target.messageId);
        if (!opened) {
          // A guessed/inaccessible DM id must not leave a fabricated empty
          // conversation selected after the generic unavailable toast.
          useDMStore.getState().selectDM(null);
          useUIStore.getState().resetNavigation();
        }
      }
      navigate("/channels", { replace: true });
    };
    void open();
  }, [location.pathname, navigate, openAtDMMessage, openAtMessage, servers, target]);

  return null;
}
