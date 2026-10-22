/**
 * PopoverShell — body-portalled, viewport-clamped popover frame used by the
 * inbox and notification panels. Closes on outside click / Escape (same
 * listener pattern as DMMuteDurationPicker). On phones it becomes a
 * full-width sheet under the header instead of an anchored card.
 */

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useIsMobile } from "../../hooks/useMediaQuery";

export type PopoverAnchor = {
  /** Anchor button's bounding rect at open time. */
  rect: DOMRect;
  /** "below": card under the anchor (header). "right": card beside it (rail). */
  placement: "below" | "right";
};

type PopoverShellProps = {
  anchor: PopoverAnchor;
  onClose: () => void;
  ariaLabel: string;
  children: ReactNode;
};

const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 6;

function PopoverShell({ anchor, onClose, ariaLabel, children }: PopoverShellProps) {
  const isMobile = useIsMobile();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    // Deferred so the click that opened the popover doesn't immediately
    // register as an outside click.
    const raf = requestAnimationFrame(() => {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleEscape);
    });
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [onClose]);

  // Position + clamp to the viewport once the panel has a size.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    if (isMobile) {
      panel.style.top = `${anchor.rect.bottom + ANCHOR_GAP}px`;
      panel.style.left = "";
      return;
    }
    const { width, height } = panel.getBoundingClientRect();
    let left: number;
    let top: number;
    if (anchor.placement === "right") {
      left = anchor.rect.right + ANCHOR_GAP;
      top = anchor.rect.top;
    } else {
      left = anchor.rect.left;
      top = anchor.rect.bottom + ANCHOR_GAP;
    }
    const maxLeft = window.innerWidth - width - VIEWPORT_MARGIN;
    const maxTop = window.innerHeight - height - VIEWPORT_MARGIN;
    panel.style.left = `${Math.max(VIEWPORT_MARGIN, Math.min(left, maxLeft))}px`;
    panel.style.top = `${Math.max(VIEWPORT_MARGIN, Math.min(top, maxTop))}px`;
  }, [anchor, isMobile]);

  return createPortal(
    <div
      ref={panelRef}
      className={`inbox-popover${isMobile ? " mobile" : ""}`}
      role="dialog"
      aria-label={ariaLabel}
    >
      {children}
    </div>,
    document.body
  );
}

export default PopoverShell;
