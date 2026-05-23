/**
 * ScreenShareViewerChip — overlay shown on the broadcaster's own screen share
 * panel listing who is currently watching them. Click to expand into a
 * popover with avatars + display names.
 *
 * Data sources:
 *  - voiceStore.screenShareViewers[userId] — list of viewer user IDs, kept in
 *    sync by the WS screen_share_viewer_update handler (and seeded from
 *    voice_states_sync on join).
 *  - memberStore (active server) — for display name + avatar lookup.
 *
 * The chip itself sits inside the panel via absolute positioning. The
 * popover renders via portal so it can escape the panel's overflow:hidden
 * (same trick ScreenShareContextMenu uses). Like that menu, the portal
 * target switches to the fullscreen element when the panel is fullscreen.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { useVoiceStore } from "../../stores/voiceStore";
import { useActiveMembers } from "../../stores/memberStore";
import Avatar from "../shared/Avatar";

type Props = {
  /** The broadcaster's user id — looked up against screenShareViewers. */
  broadcasterUserId: string;
  /** Owning panel ref; used to scope the portal when the panel is fullscreen. */
  fullscreenContainerRef: React.RefObject<HTMLElement | null>;
};

function ScreenShareViewerChip({ broadcasterUserId, fullscreenContainerRef }: Props) {
  const { t } = useTranslation("voice");

  const viewerIds = useVoiceStore(
    (s) => s.screenShareViewers[broadcasterUserId],
  );
  const members = useActiveMembers();

  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Same dynamic-portal pattern as ScreenShareContextMenu: render inside the
  // fullscreen element when this panel is fullscreen, otherwise document.body.
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    function resolve(): HTMLElement {
      const fsEl =
        typeof document !== "undefined" ? document.fullscreenElement : null;
      const panel = fullscreenContainerRef.current;
      if (fsEl && panel && fsEl === panel) return panel;
      return document.body;
    }
    setPortalTarget(resolve());
    function onChange() {
      setPortalTarget(resolve());
    }
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [fullscreenContainerRef, open]);

  // Close on outside click + Escape
  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      const target = e.target as Node;
      if (
        popoverRef.current && !popoverRef.current.contains(target) &&
        chipRef.current && !chipRef.current.contains(target)
      ) {
        setOpen(false);
      }
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    // Defer one frame so the chip click doesn't immediately trigger close.
    requestAnimationFrame(() => {
      document.addEventListener("mousedown", onClickOutside);
      document.addEventListener("keydown", onEsc);
    });
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  if (!viewerIds || viewerIds.length === 0) return null;

  function handleChipClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (open) {
      setOpen(false);
      return;
    }
    const rect = chipRef.current?.getBoundingClientRect();
    if (rect) {
      // Position popover anchored to the chip's bottom-left.
      setAnchor({ x: rect.left, y: rect.bottom + 6 });
    }
    setOpen(true);
  }

  // Resolve viewer IDs to display info. Filter out IDs we don't know about
  // (e.g., a viewer who left the server mid-watch); fall back gracefully.
  const viewerInfo = viewerIds.map((id) => {
    const m = members.find((mem) => mem.id === id);
    return {
      id,
      displayName: m?.display_name || m?.username || id,
      avatarUrl: m?.avatar_url ?? null,
    };
  });

  return (
    <>
      <button
        ref={chipRef}
        className={`screen-share-viewer-chip${open ? " is-open" : ""}`}
        onClick={handleChipClick}
        title={t("viewerListTooltip", { count: viewerIds.length })}
      >
        <svg
          width={14}
          height={14}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
        <span>{viewerIds.length}</span>
      </button>

      {open && anchor && portalTarget &&
        createPortal(
          <div
            ref={popoverRef}
            className="screen-share-viewer-popover"
            style={{ left: anchor.x, top: anchor.y }}
          >
            <div className="screen-share-viewer-popover-header">
              {t("viewerListTitle", { count: viewerIds.length })}
            </div>
            <ul className="screen-share-viewer-list">
              {viewerInfo.map((v) => (
                <li key={v.id} className="screen-share-viewer-item">
                  <Avatar
                    name={v.displayName}
                    size={24}
                    avatarUrl={v.avatarUrl}
                  />
                  <span className="screen-share-viewer-name">{v.displayName}</span>
                </li>
              ))}
            </ul>
          </div>,
          portalTarget,
        )}
    </>
  );
}

export default ScreenShareViewerChip;
