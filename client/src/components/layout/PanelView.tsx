/**
 * PanelView — Renders a single split panel.
 *
 * VS Code-style drop zones: dragging a tab shows 5 drop regions (center/edges).
 * Edge drops split the panel; center drops move the tab here.
 * Drag events are captured on the container; DropZoneOverlay is visual only.
 *
 * Tab types: text -> ChatArea, voice/screen -> VoiceRoom, dm -> DMChat, etc.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useUIStore } from "../../stores/uiStore";
import { useChannelStore } from "../../stores/channelStore";
import { useThreadStore } from "../../stores/threadStore";
import { useIsMobile } from "../../hooks/useMediaQuery";
import PanelTabBar from "./PanelTabBar";
import ChatArea from "./ChatArea";
import VoiceRoom from "../voice/VoiceRoom";
import DMChat from "../dm/DMChat";
import FriendsView from "../friends/FriendsView";
import InboxView from "../inbox/InboxView";
import NotificationsView from "../inbox/NotificationsView";
import SavedMessagesView from "../saved/SavedMessagesView";
import P2PCallScreen from "../p2p/P2PCallScreen";
import AuditChannel from "../audit/AuditChannel";
import DropZoneOverlay from "./DropZoneOverlay";
import { calculateZone } from "./dropZone";
import type { DropZone } from "./dropZone";

type PanelViewProps = {
  panelId: string;
  sendTyping: (channelId: string) => void;
  sendDMTyping: (dmChannelId: string) => void;
};

function PanelView({ panelId, sendTyping, sendDMTyping }: PanelViewProps) {
  const { t } = useTranslation("chat");
  const { t: tCommon } = useTranslation("common");
  const openTab = useUIStore((s) => s.openTab);
  const toggleQuickSwitcher = useUIStore((s) => s.toggleQuickSwitcher);
  const isMobile = useIsMobile();
  const panel = useUIStore((s) => s.panels[panelId]);
  const setActivePanel = useUIStore((s) => s.setActivePanel);
  const splitPanel = useUIStore((s) => s.splitPanel);
  const moveTab = useUIStore((s) => s.moveTab);

  const categories = useChannelStore((s) => s.categories);
  const threadsByID = useThreadStore((s) => s.byID);

  const activeTab = panel?.tabs.find((t) => t.id === panel.activeTabId);

  const channel = activeTab
    ? categories.flatMap((cg) => cg.channels).find((ch) => ch.id === activeTab.channelId) ?? threadsByID[activeTab.channelId]
    : null;

  // ─── Drag state ───
  const [activeZone, setActiveZone] = useState<DropZone | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Enter counter — prevents false dragLeave from nested children
  const enterCountRef = useRef(0);

  // Clean up overlay on dragend OR drop (covers stopPropagation from tab bar)
  useEffect(() => {
    function clearOverlay() {
      setActiveZone(null);
      enterCountRef.current = 0;
    }
    document.addEventListener("dragend", clearOverlay);
    document.addEventListener("drop", clearOverlay);
    return () => {
      document.removeEventListener("dragend", clearOverlay);
      document.removeEventListener("drop", clearOverlay);
    };
  }, []);

  const handleFocus = useCallback(() => {
    setActivePanel(panelId);
  }, [panelId, setActivePanel]);

  // ─── Drag event handlers ───

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    // Only accept tab drags
    if (!e.dataTransfer.types.includes("text/tab-id")) return;
    e.preventDefault();
    enterCountRef.current += 1;

    if (enterCountRef.current === 1 && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      setActiveZone(calculateZone(e.clientX, e.clientY, rect));
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("text/tab-id")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";

    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    setActiveZone(calculateZone(e.clientX, e.clientY, rect));
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    enterCountRef.current -= 1;

    if (enterCountRef.current <= 0) {
      enterCountRef.current = 0;
      setActiveZone(null);
    }
  }, []);

  /**
   * handleDrop — center: moveTab, edges: splitPanel.
   * Same-panel rules: center=no-op, edge with single tab=no-op.
   */
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      enterCountRef.current = 0;
      setActiveZone(null);

      const tabId = e.dataTransfer.getData("text/tab-id");
      const fromPanelId = e.dataTransfer.getData("text/panel-id");
      if (!tabId || !fromPanelId || !containerRef.current) return;

      const rect = containerRef.current.getBoundingClientRect();
      const zone = calculateZone(e.clientX, e.clientY, rect);

      // Same-panel guard
      if (fromPanelId === panelId) {
        if (zone === "center") return;
        if (!panel || panel.tabs.length < 2) return;
      }

      switch (zone) {
        case "center":
          moveTab(fromPanelId, panelId, tabId);
          break;
        case "left":
          splitPanel(panelId, "horizontal", tabId, "before", fromPanelId);
          break;
        case "right":
          splitPanel(panelId, "horizontal", tabId, "after", fromPanelId);
          break;
        case "top":
          splitPanel(panelId, "vertical", tabId, "before", fromPanelId);
          break;
        case "bottom":
          splitPanel(panelId, "vertical", tabId, "after", fromPanelId);
          break;
      }
    },
    [panelId, panel, splitPanel, moveTab]
  );

  if (!panel) return null;

  // Disable drag-drop on mobile — HTML5 DnD doesn't work with touch
  const dragHandlers = isMobile
    ? {}
    : {
        onDragEnter: handleDragEnter,
        onDragOver: handleDragOver,
        onDragLeave: handleDragLeave,
        onDrop: handleDrop,
      };

  return (
    <div
      ref={containerRef}
      className="split-pane"
      style={{ flex: 1, position: "relative" }}
      onClick={handleFocus}
      {...dragHandlers}
    >
      {/* Drop zone overlay — hidden on mobile */}
      {!isMobile && <DropZoneOverlay activeZone={activeZone} />}

      {/* Tab bar */}
      <PanelTabBar panelId={panelId} />

      {/* Content */}
      {!activeTab ? (
        <div className="no-channel home-welcome">
          <div className="home-welcome-icon" aria-hidden="true">#</div>
          <h1>{tCommon("welcomeHome")}</h1>
          <p>{tCommon("welcomeHomeHint")}</p>
          <div className="home-welcome-actions">
            <button className="ch-tree-empty-action" onClick={() => openTab("friends", "friends", tCommon("friends"))}>{tCommon("friends")}</button>
            <button className="ch-tree-empty-action" onClick={toggleQuickSwitcher}>{tCommon("quickSwitcherPlaceholder")}</button>
          </div>
          <span>{t("noChannel")}</span>
        </div>
      ) : activeTab.type === "text" ? (
        <ChatArea channelId={activeTab.channelId} channel={channel ?? null} serverId={activeTab.serverInfo?.serverId} sendTyping={sendTyping} />
      ) : activeTab.type === "dm" ? (
        <DMChat channelId={activeTab.channelId} sendDMTyping={sendDMTyping} />
      ) : activeTab.type === "friends" ? (
        <FriendsView />
      ) : activeTab.type === "inbox" ? (
        <InboxView panelId={panelId} />
      ) : activeTab.type === "notifications" ? (
        <NotificationsView />
      ) : activeTab.type === "saved" ? (
        <SavedMessagesView />
      ) : activeTab.type === "p2p" ? (
        <P2PCallScreen />
      ) : activeTab.type === "audit" ? (
        <AuditChannel
          channelId={activeTab.channelId}
          serverId={activeTab.serverInfo?.serverId}
        />
      ) : (
        <div className="voice-room">
          {channel && (
            <div className="channel-bar">
              <span className="ch-hash">
                {activeTab.type === "voice" ? "\uD83D\uDD0A" : "\uD83D\uDDA5"}
              </span>
              <span className="ch-name">{channel.name}</span>
            </div>
          )}
          <VoiceRoom />
        </div>
      )}
    </div>
  );
}

export default PanelView;
