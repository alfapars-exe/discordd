import { useCallback, useMemo, useState, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { useServerStore } from "../../stores/serverStore";
import { useAuthStore } from "../../stores/authStore";
import { getAuthGeneration } from "../../api/client";
import { useUIStore } from "../../stores/uiStore";
import { useReadStateStore } from "../../stores/readStateStore";
import { useDMStore } from "../../stores/dmStore";
import { useToastStore } from "../../stores/toastStore";
import { publicAsset, resolveAssetUrl } from "../../utils/constants";
import { useKeyboardReorder } from "./keyboardReorder";
import { ALLOW_SERVER_CREATION } from "../../utils/constants";

export default function ServerRail() {
  const { t } = useTranslation("common");
  const { t: ts } = useTranslation("servers");
  const servers = useServerStore((s) => s.servers);
  const reorderServers = useServerStore((s) => s.reorderServers);
  const muted = useServerStore((s) => s.mutedServerIds);
  const destination = useUIStore((s) => s.destination);
  const counts = useReadStateStore((s) => s.unreadCounts);
  const owners = useReadStateStore((s) => s.channelServerMap);
  const dmCounts = useDMStore((s) => s.dmUnreadCounts);
  const [dragging, setDragging] = useState<string | null>(null);
  const currentUserId = useAuthStore((s) => s.user?.id ?? "");
  const activeId = destination.serverInfo?.serverId;
  const dmUnread = Object.values(dmCounts).reduce((a, b) => a + b, 0);
  const reorderItems = useMemo(() => servers.map((server) => ({ id: server.id, label: server.name })), [servers]);
  const commitKeyboardOrder = useCallback(async (ids: string[]) => {
    return reorderServers(ids.map((id, position) => ({ id, position })));
  }, [reorderServers]);
  const keyboardReorder = useKeyboardReorder(reorderItems, true, commitKeyboardOrder, `${currentUserId}:${getAuthGeneration()}`);
  async function drop(event: DragEvent, target: string) {
    event.preventDefault();
    const source = dragging;
    setDragging(null);
    if (!source || source === target) return;
    const ids = servers.map((server) => server.id).filter((id) => id !== source);
    ids.splice(ids.indexOf(target), 0, source);
    const ok = await useServerStore.getState().reorderServers(ids.map((id, position) => ({ id, position })));
    if (!ok) useToastStore.getState().addToast("error", ts("reorderError"));
  }
  return <nav className="server-rail" aria-label={ts("servers")}>
    <button className={`rail-item rail-home${!activeId ? " selected" : ""}`} title={t("friends")} aria-label={t("friends")} aria-current={!activeId ? "page" : undefined}
      onClick={() => useUIStore.getState().navigate({ type: "friends", channelId: "friends", label: t("friends") })}>
      <img src={publicAsset("hlogo.png")} alt="HiChat!" />
      {dmUnread > 0 && <span className="rail-badge">{dmUnread > 99 ? "99+" : dmUnread}</span>}
    </button>
    <div className="rail-divider" />
    {keyboardReorder.orderedItems.map(({ id }) => {
      const server = servers.find((entry) => entry.id === id);
      if (!server) return null;
      const unread = muted.has(server.id) ? 0 : Object.entries(counts).reduce((sum, [id, count]) => sum + (owners[id] === server.id ? count : 0), 0);
      return <button key={server.id} className={`rail-item${activeId === server.id ? " selected" : ""}${unread ? " unread" : ""}${muted.has(server.id) ? " muted" : ""}`}
        title={server.name} aria-label={`${server.name}${unread ? ` · ${unread} ${t("shellUnread")}` : ""}`} aria-current={activeId === server.id ? "page" : undefined}
        data-keyboard-reorder-id={server.id} aria-posinset={keyboardReorder.positionOf(server.id)} aria-setsize={servers.length}
        aria-keyshortcuts="Control+D" aria-grabbed={keyboardReorder.activeItemId === server.id}
        onKeyDown={(event) => keyboardReorder.onKeyDown(event, server.id)}
        onClick={() => useUIStore.getState().openServer(server.id)} draggable onDragStart={() => setDragging(server.id)} onDragEnd={() => setDragging(null)}
        onDragOver={(event) => { if (dragging) event.preventDefault(); }} onDrop={(event) => void drop(event, server.id)}>
        {server.icon_url ? <img src={resolveAssetUrl(server.icon_url)} alt="" /> : <span>{server.name.slice(0, 2).toLocaleUpperCase()}</span>}
        {unread > 0 && <span className="rail-badge">{unread > 99 ? "99+" : unread}</span>}
      </button>;
    })}
    {keyboardReorder.liveRegion}
    {ALLOW_SERVER_CREATION && <button className="rail-item rail-add" title={ts("addServer")} aria-label={ts("addServer")} onClick={() => undefined}>+</button>}
  </nav>;
}
