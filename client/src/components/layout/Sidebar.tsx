/**
 * Sidebar — Expanded (resizable 180-500px) or collapsed (52px).
 * Width persisted in localStorage. Voice control props forwarded to UserBar.
 */

import type { CSSProperties } from "react";
import { useSidebarStore } from "../../stores/sidebarStore";
import { useResizeHandle } from "../../hooks/useResizeHandle";
import { useIsMobile } from "../../hooks/useMediaQuery";
import SidebarHeader from "./SidebarHeader";
import ChannelTree from "./ChannelTree";
import CollapsedSidebar from "./CollapsedSidebar";
import UserBar from "./UserBar";
import ServerRail from "./ServerRail";
import { UI_SHELL_V2 } from "../../utils/uiShell";
/** Sidebar width bounds (px) — default matches Discord's --custom-guild-sidebar-width */
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 500;
const SIDEBAR_DEFAULT = 375;

type SidebarProps = {
  onJoinVoice: (channelId: string) => void;
  onToggleMute: () => void;
  onToggleDeafen: () => void;
  onToggleScreenShare: () => void;
  onDisconnect: () => void;
};

function Sidebar({
  onJoinVoice,
  onToggleMute,
  onToggleDeafen,
  onToggleScreenShare,
  onDisconnect,
}: SidebarProps) {
  const isExpanded = useSidebarStore((s) => s.isExpanded);
  const isMobile = useIsMobile();

  const { width, handleMouseDown, isDragging } = useResizeHandle({
    initialWidth: UI_SHELL_V2 ? 280 : SIDEBAR_DEFAULT,
    minWidth: UI_SHELL_V2 ? 240 : SIDEBAR_MIN,
    maxWidth: UI_SHELL_V2 ? 360 : SIDEBAR_MAX,
    direction: "right",
    storageKey: UI_SHELL_V2 ? "hichat_context_sidebar_width_v2" : "mqvi_sidebar_width",
  });

  // Always expanded on mobile (inside drawer)
  if (!UI_SHELL_V2 && !isExpanded && !isMobile) {
    return <CollapsedSidebar />;
  }

  if (UI_SHELL_V2) return <aside className="shell-navigation" style={{ "--context-width": `${width}px` } as CSSProperties}>
    <ServerRail />
    <div className="shell-context-sidebar">
      <SidebarHeader />
      <ChannelTree onJoinVoice={onJoinVoice} />
      {!isMobile && <div role="separator" aria-orientation="vertical" className={`resize-handle resize-handle-v${isDragging ? " active" : ""}`} onMouseDown={handleMouseDown} />}
    </div>
    <div className="shell-user-dock"><UserBar onToggleMute={onToggleMute} onToggleDeafen={onToggleDeafen} onToggleScreenShare={onToggleScreenShare} onDisconnect={onDisconnect} /></div>
  </aside>;

  return (
    <div className="sidebar" style={{ width, "--guild-sidebar-width": `${width}px` } as CSSProperties}>
      <div className="sb-main app-panel">
        <SidebarHeader />
        <ChannelTree onJoinVoice={onJoinVoice} />
      </div>
      <div className="sb-dock app-panel">
        <UserBar
          onToggleMute={onToggleMute}
          onToggleDeafen={onToggleDeafen}
          onToggleScreenShare={onToggleScreenShare}
          onDisconnect={onDisconnect}
        />
      </div>

      {/* Resize handle */}
      <div
        className={`resize-handle resize-handle-v${isDragging ? " active" : ""}`}
        onMouseDown={handleMouseDown}
      />
    </div>
  );
}

export default Sidebar;
