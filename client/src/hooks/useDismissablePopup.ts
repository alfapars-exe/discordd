/**
 * useDismissablePopup — shared click-outside + Escape dismissal wiring for
 * floating popups/panels. Extracted from UserBar (soundboard popup) and
 * ScreenShareQualityPopup, which each hand-rolled the same two listeners.
 */

import { useEffect, type RefObject } from "react";

type DismissablePopupOptions = {
  /** Popup is currently open — listeners only attach while true. */
  active: boolean;
  /** Popup container; clicks inside it don't dismiss. */
  ref: RefObject<HTMLElement | null>;
  /** Optional anchor (toggle button); clicks on it don't dismiss. */
  anchorEl?: HTMLElement | null;
  onDismiss: () => void;
  /**
   * Attach the mousedown listener one frame late. Needed when the popup
   * opens from a mousedown on its anchor — attaching synchronously would
   * catch the very click that opened it and close immediately.
   */
  deferFrame?: boolean;
};

export function useDismissablePopup({
  active,
  ref,
  anchorEl,
  onDismiss,
  deferFrame,
}: DismissablePopupOptions): void {
  useEffect(() => {
    if (!active) return;
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      if (ref.current?.contains(target)) return;
      if (anchorEl?.contains(target)) return;
      onDismiss();
    }
    let raf = 0;
    if (deferFrame) {
      raf = requestAnimationFrame(() =>
        document.addEventListener("mousedown", handleClick),
      );
    } else {
      document.addEventListener("mousedown", handleClick);
    }
    return () => {
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [active, ref, anchorEl, onDismiss, deferFrame]);

  useEffect(() => {
    if (!active) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onDismiss();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [active, onDismiss]);
}
