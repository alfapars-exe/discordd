/**
 * MemberList — Right panel: online/offline users grouped by highest role.
 * Panel width is CSS-transitioned via .members-panel.open toggle.
 */

import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useMemberStore, useActiveMembers } from "../../stores/memberStore";
import { useUIStore } from "../../stores/uiStore";
import { useMobileStore } from "../../stores/mobileStore";
import { useServerStore } from "../../stores/serverStore";
import { useIsMobile } from "../../hooks/useMediaQuery";
import { useResizeHandle } from "../../hooks/useResizeHandle";
import { useNowTick } from "../../hooks/useNowTick";
import { resolveAssetUrl } from "../../utils/constants";
import MemberItem from "../members/MemberItem";
import { MemberSkeleton } from "../shared/Skeleton";
import { IconMembers } from "../shared/Icons";
import { partitionMembers } from "./memberGrouping";

/** Member panel width bounds (px) */
const MEMBERS_MIN = 160;
const MEMBERS_MAX = 360;
const MEMBERS_DEFAULT = 240;

/** localStorage key for collapsed section IDs */
const COLLAPSED_KEY = "mqvi_members_collapsed";

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (!raw) return new Set(["offline"]); // offline collapsed by default
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set(["offline"]);
  }
}

function saveCollapsed(collapsed: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  } catch { /* localStorage full */ }
}

function MemberList() {
  const { t } = useTranslation("common");
  const members = useActiveMembers();
  const isLoading = useMemberStore((s) => s.isLoading);
  const onlineUserIds = useMemberStore((s) => s.onlineUserIds);
  const toggleMembers = useUIStore((s) => s.toggleMembers);
  const membersOpen = useUIStore((s) => s.membersOpen);
  const closeRightDrawer = useMobileStore((s) => s.closeRightDrawer);
  const isMobile = useIsMobile();
  const activeServer = useServerStore((s) => s.activeServer);
  // Single ticking clock for the whole list — shared by every offline
  // MemberItem's "last seen X ago" label instead of one interval each.
  const nowMs = useNowTick(60_000);

  // Collapsible sections — persisted in localStorage
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);

  const toggleSection = useCallback((sectionId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(sectionId)) next.delete(sectionId);
      else next.add(sectionId);
      saveCollapsed(next);
      return next;
    });
  }, []);

  const { width, handleMouseDown, isDragging } = useResizeHandle({
    initialWidth: MEMBERS_DEFAULT,
    minWidth: MEMBERS_MIN,
    maxWidth: MEMBERS_MAX,
    direction: "left",
    storageKey: "mqvi_members_width",
  });

  // Split into online/offline, group online by role, sort — see memberGrouping.
  const { onlineGroups, ungroupedOnline, sortedOffline } = partitionMembers(
    members,
    onlineUserIds
  );

  /** Dynamic width when open, 0 when closed */
  const panelWidth = membersOpen ? width : 0;

  return (
    <div
      className={`members-panel${membersOpen ? " open" : ""}`}
      style={membersOpen ? { width: panelWidth } : undefined}
    >
      {/* FAB to re-open member list when collapsed */}
      {!membersOpen && !isMobile && (
        <button
          className="members-fab"
          onClick={toggleMembers}
          title={t("members")}
        >
          <IconMembers width={16} height={16} />
        </button>
      )}
      {/* Resize handle — left edge, only when open */}
      {membersOpen && (
        <div
          className={`resize-handle resize-handle-v${isDragging ? " active" : ""}`}
          onMouseDown={handleMouseDown}
        />
      )}
      <div className="members-inner app-panel" style={{ width }}>
        {/* ─── Header ─── */}
        <div className="members-header">
          <div className="members-header-left">
            {activeServer?.icon_url ? (
              <img
                src={resolveAssetUrl(activeServer.icon_url)}
                alt={activeServer.name}
                loading="lazy"
                decoding="async"
                className="members-header-icon"
              />
            ) : activeServer ? (
              <span className="members-header-icon-fallback">
                {activeServer.name.charAt(0).toUpperCase()}
              </span>
            ) : null}
            <h3>{t("members")}</h3>
          </div>
          <button onClick={isMobile ? closeRightDrawer : toggleMembers}>✕</button>
        </div>

        {/* ─── Member List ─── */}
        <div className="members-list">
          {/* Skeleton while loading */}
          {isLoading && members.length === 0 && (
            <MemberSkeleton count={8} />
          )}

          {/* Online — grouped by role */}
          {onlineGroups.map((group) => {
            const sectionId = `role-${group.role.id}`;
            const isCollapsed = collapsed.has(sectionId);
            return (
              <div key={group.role.id}>
                <button
                  className="member-label member-label-toggle"
                  onClick={() => toggleSection(sectionId)}
                >
                  <svg className={`member-label-chevron${isCollapsed ? " collapsed" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                  {group.role.name} — {group.members.length}
                </button>
                {!isCollapsed && group.members.map((member) => (
                  <MemberItem
                    key={member.id}
                    member={member}
                    isOnline={true}
                  />
                ))}
              </div>
            );
          })}

          {/* Ungrouped online members */}
          {ungroupedOnline.length > 0 && (
            <div>
              <button
                className="member-label member-label-toggle"
                onClick={() => toggleSection("online")}
              >
                <svg className={`member-label-chevron${collapsed.has("online") ? " collapsed" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
                {t("online")} — {ungroupedOnline.length}
              </button>
              {!collapsed.has("online") && ungroupedOnline.map((member) => (
                <MemberItem
                  key={member.id}
                  member={member}
                  isOnline={true}
                />
              ))}
            </div>
          )}

          {/* Offline section */}
          {sortedOffline.length > 0 && (
            <div>
              <button
                className="member-label member-label-toggle"
                onClick={() => toggleSection("offline")}
              >
                <svg className={`member-label-chevron${collapsed.has("offline") ? " collapsed" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
                {t("offline")} — {sortedOffline.length}
              </button>
              {!collapsed.has("offline") && sortedOffline.map((member) => (
                <MemberItem
                  key={member.id}
                  member={member}
                  isOnline={false}
                  nowMs={nowMs}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default MemberList;
