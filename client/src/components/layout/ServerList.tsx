import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useSidebarStore } from "../../stores/sidebarStore";
import { useServerStore } from "../../stores/serverStore";
import { useReadStateStore } from "../../stores/readStateStore";
import { useAuthStore } from "../../stores/authStore";
import { useToastStore } from "../../stores/toastStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useActiveMembers } from "../../stores/memberStore";
import { hasPermission, Permissions } from "../../utils/permissions";
import { resolveAssetUrl } from "../../utils/constants";
import ContextMenu from "../shared/ContextMenu";
import { useContextMenu, type ContextMenuItem } from "../../hooks/useContextMenu";
import { useConfirm } from "../../hooks/useConfirm";
import { UI_SHELL_V2 } from "../../utils/uiShell";
import { getSettingsGroups } from "../settings/settingsNavigation";
import { getAuthGeneration } from "../../api/client";
import { useKeyboardReorder } from "./keyboardReorder";

type ServerListProps = {
  onAddServer: () => void;
  onCreateChannel: () => void;
  onInviteServer: (serverId: string, serverName: string, returnFocus?: HTMLElement) => void;
  onOpenEvents: (serverId: string, serverName: string) => void;
  onMuteServer: (serverId: string, x: number, y: number) => void;
  /** Renders categories + channels for the active expanded server. */
  renderServerBody: (serverId: string) => ReactNode;
};

// Chevron — module-scope component so React's reconciler keeps a
// stable identity across renders. Defining it inside ServerList's
// body (the previous shape) would re-create it every render and
// trip react-hooks/static-components.
function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <span className={`ch-tree-chevron${expanded ? " expanded" : ""}`}>
      &#x276F;
    </span>
  );
}

function ServerList({
  onAddServer,
  onCreateChannel,
  onInviteServer,
  onOpenEvents,
  onMuteServer,
  renderServerBody,
}: ServerListProps) {
  const { t: tServers } = useTranslation("servers");
  const { t: tCh } = useTranslation("channels");
  const { t: tE2EE } = useTranslation("e2ee");

  const toggleSection = useSidebarStore((s) => s.toggleSection);
  const expandSection = useSidebarStore((s) => s.expandSection);
  const expandedSections = useSidebarStore((s) => s.expandedSections);

  const servers = useServerStore((s) => s.servers);
  const activeServerId = useServerStore((s) => s.activeServerId);
  const setActiveServer = useServerStore((s) => s.setActiveServer);
  const reorderServers = useServerStore((s) => s.reorderServers);
  const mutedServerIds = useServerStore((s) => s.mutedServerIds);
  const unmuteServer = useServerStore((s) => s.unmuteServer);
  const activeServer = useServerStore((s) => s.activeServer);
  const leaveServer = useServerStore((s) => s.leaveServer);
  const toggleServerE2EE = useServerStore((s) => s.toggleE2EE);

  const markAllAsRead = useReadStateStore((s) => s.markAllAsRead);
  const getServerUnreadTotal = useReadStateStore((s) => s.getServerUnreadTotal);
  const openSettings = useSettingsStore((s) => s.openSettings);
  const addToast = useToastStore((s) => s.addToast);
  const currentUser = useAuthStore((s) => s.user);
  const members = useActiveMembers();

  const confirmDialog = useConfirm();
  const { menuState, openMenu, closeMenu } = useContextMenu();

  const currentMember = members.find((m) => m.id === currentUser?.id);
  const canManageChannels = currentMember
    ? hasPermission(currentMember.effective_permissions, Permissions.ManageChannels)
    : false;
  const canManageInvites = currentMember
    ? hasPermission(currentMember.effective_permissions, Permissions.ManageInvites)
    : false;

  function isSectionExpanded(key: string): boolean {
    return expandedSections[key] ?? true;
  }

  // State + ref pair for the dragged server:
  //   state → renders the .srv-dragging className (reactive)
  //   ref   → read synchronously inside drop / drag-over handlers
  // The previous render-time `.current` read fell foul of
  // react-hooks/refs because refs aren't reactive.
  const [draggingServerId, setDraggingServerId] = useState<string | null>(null);
  const dragServerIdRef = useRef<string | null>(null);
  const [serverDropIndicator, setServerDropIndicator] = useState<{
    serverId: string;
    position: "above" | "below";
  } | null>(null);
  const serverReorderItems = useMemo(() => servers.map((server) => ({ id: server.id, label: server.name })), [servers]);
  const commitServerKeyboardOrder = useCallback(async (ids: string[]) => {
    const items = ids.map((id, position) => ({ id, position }));
    return reorderServers(items);
  }, [reorderServers]);
  const keyboardReorder = useKeyboardReorder(serverReorderItems, true, commitServerKeyboardOrder, `${currentUser?.id ?? ""}:${getAuthGeneration()}`);

  function handleServerDragStart(e: React.DragEvent, serverId: string) {
    e.stopPropagation();
    dragServerIdRef.current = serverId;
    setDraggingServerId(serverId);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/server", serverId);
  }

  function handleServerDragOver(e: React.DragEvent, serverId: string) {
    if (!dragServerIdRef.current) return;
    if (dragServerIdRef.current === serverId) {
      e.preventDefault();
      setServerDropIndicator(null);
      return;
    }

    e.preventDefault();
    e.dataTransfer.dropEffect = "move";

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const pos: "above" | "below" = e.clientY < midY ? "above" : "below";
    setServerDropIndicator({ serverId, position: pos });
  }

  function handleServerDragLeave() {
    setServerDropIndicator(null);
  }

  function handleServerDrop(e: React.DragEvent, targetServerId: string) {
    e.preventDefault();
    setServerDropIndicator(null);

    const dragId = dragServerIdRef.current;
    dragServerIdRef.current = null;
    setDraggingServerId(null);

    if (!dragId || dragId === targetServerId) return;

    const ordered = [...servers];
    const dragIdx = ordered.findIndex((s) => s.id === dragId);
    const targetIdx = ordered.findIndex((s) => s.id === targetServerId);
    if (dragIdx === -1 || targetIdx === -1) return;

    const [dragged] = ordered.splice(dragIdx, 1);

    let insertIdx = ordered.findIndex((s) => s.id === targetServerId);
    if (insertIdx === -1) insertIdx = ordered.length;

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (e.clientY >= midY) insertIdx += 1;

    ordered.splice(insertIdx, 0, dragged);

    const items = ordered.map((s, idx) => ({ id: s.id, position: idx }));
    reorderServers(items).then((ok) => {
      if (!ok) addToast("error", tServers("reorderError"));
    });
  }

  function handleServerDragEnd() {
    dragServerIdRef.current = null;
    setDraggingServerId(null);
    setServerDropIndicator(null);
  }

  function handleServerClick(serverId: string) {
    if (serverId === activeServerId) return;
    setActiveServer(serverId);
  }

  function handleServerContextMenu(e: React.MouseEvent, serverId: string, serverName: string) {
    const returnFocus = e.currentTarget as HTMLElement;
    const isMuted = mutedServerIds.has(serverId);
    const isOwner = activeServer?.owner_id === currentUser?.id && activeServer?.id === serverId;
    const canInvite = serverId !== activeServerId || canManageInvites;
    const firstSettingsTab = serverId === activeServerId && currentMember
      ? UI_SHELL_V2
        ? getSettingsGroups(currentMember.effective_permissions, false, false, "server")[0]?.items[0]?.id
        : hasPermission(currentMember.effective_permissions, Permissions.Admin) ? "server-general" : undefined
      : undefined;

    const items: ContextMenuItem[] = [
      ...(firstSettingsTab
        ? [{ label: tServers("serverSettings"), onClick: () => openSettings(firstSettingsTab) }]
        : []),
      {
        label: tServers("markAllAsRead"),
        onClick: async () => {
          const ok = await markAllAsRead(serverId);
          if (ok) addToast("success", tServers("allMarkedAsRead"));
        },
      },
      ...(canInvite
        ? [{ label: tServers("inviteFriends"), onClick: () => onInviteServer(serverId, serverName, returnFocus) }]
        : []),
      ...(serverId === activeServerId
        ? [{ label: tServers("serverEvents"), onClick: () => onOpenEvents(serverId, serverName) }]
        : []),
      ...(isOwner
        ? [{
            label: activeServer?.e2ee_enabled ? tE2EE("disableE2EE") : tE2EE("enableE2EE"),
            onClick: async () => {
              const newState = !activeServer?.e2ee_enabled;
              const confirmed = await confirmDialog({
                title: newState ? tE2EE("enableE2EE") : tE2EE("disableE2EE"),
                message: newState ? tE2EE("enableE2EEConfirmServer") : tE2EE("disableE2EEConfirmServer"),
                confirmLabel: newState ? tE2EE("enableE2EE") : tE2EE("disableE2EE"),
                danger: !newState,
              });
              if (!confirmed) return;
              const ok = await toggleServerE2EE(serverId, newState);
              if (ok) {
                addToast("success", newState ? tE2EE("e2eeEnabled") : tE2EE("e2eeDisabled"));
              } else {
                addToast("error", tE2EE("e2eeToggleFailed"));
              }
            },
          }]
        : []),
      isMuted
        ? {
            label: tServers("unmuteServer"),
            onClick: async () => {
              const ok = await unmuteServer(serverId);
              if (ok) addToast("success", tServers("serverUnmuted"));
            },
            separator: true,
          }
        : {
            label: tServers("muteServer"),
            onClick: () => onMuteServer(serverId, e.clientX, e.clientY),
            separator: true,
          },
      {
        label: tServers("leaveServer"),
        danger: true,
        disabled: isOwner,
        onClick: async () => {
          if (isOwner) return;
          if (!confirm(tServers("leaveServerConfirmDesc"))) return;
          const ok = await leaveServer(serverId);
          if (ok) addToast("success", tServers("serverLeft"));
        },
        separator: true,
      },
    ];

    openMenu(e, items);
  }

  if (UI_SHELL_V2) {
    const server = servers.find((item) => item.id === activeServerId);
    return <>
      {server && <section className="server-context" aria-label={server.name}>
        <div className="server-context-header">
          <button onClick={(event) => handleServerContextMenu(event, server.id, server.name)} aria-haspopup="menu">
            <span>{server.name}</span><span aria-hidden="true">⌄</span>
          </button>
          {canManageChannels && <button className="server-context-create" onClick={onCreateChannel} title={tCh("createChannelOrCategory")} aria-label={tCh("createChannelOrCategory")}>+</button>}
        </div>
        {renderServerBody(server.id)}
      </section>}
      <ContextMenu state={menuState} onClose={closeMenu} />
    </>;
  }

  return (
    <>
      <div className="ch-tree-section">
        <button
          className="ch-tree-section-header"
          onClick={() => toggleSection("servers")}
        >
          <Chevron expanded={isSectionExpanded("servers")} />
          <span>{tServers("servers")}</span>
        </button>

        {isSectionExpanded("servers") && (
          <div className="ch-tree-section-body">
            <button
              className="ch-tree-item ch-tree-add-server"
              onClick={onAddServer}
            >
              <span className="ch-tree-icon">+</span>
              <span className="ch-tree-label">{tServers("addServer")}</span>
            </button>

            {keyboardReorder.orderedItems.flatMap(({ id }) => {
              const srv = servers.find((serverItem) => serverItem.id === id);
              if (!srv) return [];
              const serverId = srv.id;
              const srvKey = `srv:${serverId}`;
              const isActive = serverId === activeServerId;
              const srvExpanded = isSectionExpanded(srvKey);

              function handleSrvHeaderClick() {
                if (!isActive) {
                  handleServerClick(serverId);
                  expandSection(srvKey);
                } else {
                  toggleSection(srvKey);
                }
              }

              const srvDropPos = serverDropIndicator?.serverId === srv.id ? serverDropIndicator.position : null;
              const isSrvDragging = draggingServerId === srv.id;

              return (
                <div
                  key={srv.id}
                  className={`ch-tree-server-group${isSrvDragging ? " srv-dragging" : ""}${srvDropPos === "above" ? " srv-drop-above" : ""}${srvDropPos === "below" ? " srv-drop-below" : ""}`}
                  draggable
                  onDragStart={(e) => handleServerDragStart(e, srv.id)}
                  onDragOver={(e) => handleServerDragOver(e, srv.id)}
                  onDragLeave={handleServerDragLeave}
                  onDrop={(e) => handleServerDrop(e, srv.id)}
                  onDragEnd={handleServerDragEnd}
                >
                  <div className="ch-tree-server-header-row">
                    <button
                      className={`ch-tree-server-header${isActive ? " active" : ""}${mutedServerIds.has(srv.id) ? " muted" : ""}`}
                      data-keyboard-reorder-id={srv.id}
                      aria-posinset={keyboardReorder.positionOf(srv.id)}
                      aria-setsize={servers.length}
                      aria-keyshortcuts="Control+D"
                      aria-grabbed={keyboardReorder.activeItemId === srv.id}
                      onKeyDown={(event) => keyboardReorder.onKeyDown(event, srv.id)}
                      onClick={handleSrvHeaderClick}
                      onContextMenu={(e) => handleServerContextMenu(e, srv.id, srv.name)}
                    >
                      <Chevron expanded={srvExpanded && isActive} />
                      {srv.icon_url ? (
                        <img
                          src={resolveAssetUrl(srv.icon_url)}
                          alt={srv.name}
                          loading="lazy"
                          decoding="async"
                          className="ch-tree-server-icon"
                        />
                      ) : (
                        <span className="ch-tree-server-icon-fallback">
                          {srv.name.charAt(0).toUpperCase()}
                        </span>
                      )}
                      <span className="ch-tree-server-name">{srv.name}</span>
                      {!mutedServerIds.has(srv.id) && (() => {
                        const total = getServerUnreadTotal(srv.id);
                        return total > 0 ? (
                          <span className="ch-tree-server-badge">{total > 99 ? "99+" : total}</span>
                        ) : null;
                      })()}
                    </button>
                    {isActive && canManageChannels && (
                      <button
                        className="ch-tree-server-add"
                        title={tCh("createChannelOrCategory")}
                        onClick={(e) => {
                          e.stopPropagation();
                          onCreateChannel();
                        }}
                      >
                        +
                      </button>
                    )}
                  </div>

                  {isActive && srvExpanded && renderServerBody(srv.id)}
                </div>
              );
            })}
            {keyboardReorder.liveRegion}
          </div>
        )}
      </div>

      <ContextMenu state={menuState} onClose={closeMenu} />
    </>
  );
}

export default ServerList;
