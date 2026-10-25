/**
 * MobileDrawer — Slide-in drawer from left or right edge.
 *
 * Portaled to document.body. Locks body scroll while open.
 * Backdrop click or swipe in closing direction closes the drawer.
 */

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useSwipeGesture } from "../../hooks/useSwipeGesture";
import { UI_SHELL_V2 } from "../../utils/uiShell";

type MobileDrawerProps = {
  isOpen: boolean;
  onClose: () => void;
  side: "left" | "right";
  children: React.ReactNode;
};

function MobileDrawer({ isOpen, onClose, side, children }: MobileDrawerProps) {
  const { t } = useTranslation("common");
  const drawerRef = useRef<HTMLDivElement>(null);
  // Lock body scroll while open
  useEffect(() => {
    if (isOpen) {
      const previousOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = previousOverflow;
      };
    }
  }, [isOpen]);

  useEffect(() => {
    if (!UI_SHELL_V2 || !isOpen) return;
    const drawer = drawerRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Drawer children may open body portals (settings, user cards, menus).
    // Let those higher layers own focus and Escape until they close.
    const nestedLayer = () => Array.from(document.querySelectorAll<HTMLElement>(
      '[role="dialog"], [role="alertdialog"], .modal-backdrop, .emoji-picker, .ctx-menu, .member-card, .sb-float-popup, .sp-overlay, .quick-switcher-overlay'
    )).find((element) => element !== drawer && !element.matches(".mobile-drawer")
      && !element.contains(drawer) && !element.closest('[inert], [aria-hidden="true"]'));
    const focusable = () => Array.from(drawer?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]'
    ) ?? []).filter((element) => !element.closest('[hidden], [inert], [aria-hidden="true"]'));
    const frame = requestAnimationFrame(() => {
      if (!nestedLayer()) (focusable()[0] ?? drawer)?.focus();
    });

    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || nestedLayer()) return;
      if (event.key === "Escape") {
        const target = event.target instanceof HTMLElement ? event.target : null;
        if (target?.matches('input[type="search"]') && (target as HTMLInputElement).value) return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      } else if (event.key === "Tab") {
        const elements = focusable();
        const first = elements[0];
        const last = elements[elements.length - 1];
        if (!first) { event.preventDefault(); drawer?.focus(); return; }
        if (event.shiftKey && (document.activeElement === first || !drawer?.contains(document.activeElement))) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !drawer?.contains(document.activeElement))) {
          event.preventDefault(); first.focus();
        }
      }
    }
    function containFocus(event: FocusEvent) {
      if (!nestedLayer() && !drawer?.contains(event.target as Node)) (focusable()[0] ?? drawer)?.focus();
    }
    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("focusin", containFocus);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("focusin", containFocus);
      if (!nestedLayer()) {
        if (previousFocus?.isConnected && !previousFocus.closest('[inert], [aria-hidden="true"]')) previousFocus.focus();
        else document.querySelector<HTMLElement>(`[aria-controls="mobile-drawer-${side}"]`)?.focus();
      }
    };
  }, [isOpen, onClose, side]);

  // Swipe to close: left drawer → swipe left, right drawer → swipe right
  const swipeHandlers = useSwipeGesture({
    onSwipeLeft: side === "left" ? onClose : undefined,
    onSwipeRight: side === "right" ? onClose : undefined,
    threshold: 30,
    velocityThreshold: 0.15,
  });

  return createPortal(
    <>
      <div
        className={`mobile-drawer-backdrop${isOpen ? " open" : ""}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={drawerRef}
        id={`mobile-drawer-${side}`}
        className={`mobile-drawer ${side}${isOpen ? " open" : ""}`}
        role={UI_SHELL_V2 ? "dialog" : undefined}
        aria-modal={UI_SHELL_V2 && isOpen ? true : undefined}
        aria-label={UI_SHELL_V2 ? t(side === "left" ? "navigation" : "members") : undefined}
        aria-hidden={UI_SHELL_V2 ? !isOpen : undefined}
        inert={UI_SHELL_V2 ? !isOpen : undefined}
        tabIndex={UI_SHELL_V2 ? -1 : undefined}
        {...swipeHandlers}
      >
        {children}
      </div>
    </>,
    document.body
  );
}

export default MobileDrawer;
