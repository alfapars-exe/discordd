/**
 * useMobileKeyboardOffset — keep the message input visible while the on-
 * screen keyboard is open.
 *
 * The browser's layout viewport (100vh / 100dvh) does not shrink when the
 * iOS / Android software keyboard opens, so a fixed bottom-anchored element
 * (chat composer) gets occluded by the keyboard. The visual viewport API
 * exposes the actually-visible region; we read it on every resize/scroll
 * and write the keyboard height to a CSS variable. Layout CSS uses that
 * variable (--keyboard-offset) to lift the app body by the keyboard's
 * height so the composer stays in view.
 *
 * Cheap (visualViewport events fire once per layout change), no-op on
 * desktop where there is no software keyboard, and graceful when the API
 * is missing (older browsers — composer just sits where it always did).
 */

import { useEffect } from "react";

export function useMobileKeyboardOffset(): void {
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!vv) return;

    function update() {
      if (!vv) return;
      // window.innerHeight is the layout viewport (stable, doesn't react to
      // the keyboard). vv.height is the visual viewport (shrinks when the
      // keyboard takes screen space). The diff is the keyboard's height,
      // floored at 0 so we never produce a negative offset.
      const offset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      document.documentElement.style.setProperty(
        "--keyboard-offset",
        `${Math.round(offset)}px`,
      );
    }

    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      document.documentElement.style.removeProperty("--keyboard-offset");
    };
  }, []);
}
