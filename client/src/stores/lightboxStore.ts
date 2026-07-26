/**
 * Lightbox Store — Global fullscreen image preview state.
 *
 * A single <ImageLightbox /> host mounts in AppLayout's overlay fragment;
 * attachment tiles (plaintext, encrypted, link-preview) open it through
 * this store. The viewer must live OUTSIDE the message rows: the list is
 * virtualized, so the triggering tile can unmount (scroll-out) while the
 * preview stays open.
 */

import { create } from "zustand";

export type LightboxItem =
  | {
      kind: "remote";
      /** Current <img> src (may already carry the tile's cache-bust param). */
      src: string;
      /** Canonical URL for the "open original" / download links. */
      href: string;
      filename: string;
      /** /api/uploads/* cookie-auth image: retry once after token refresh on error. */
      authRetry?: boolean;
      /** Third-party URL (Tenor/Klipy link previews): suppress the referrer. */
      noReferrer?: boolean;
    }
  | {
      kind: "blob";
      /**
       * The decrypted File object — NOT the tile's blob URL. The tile
       * revokes its URL on unmount, which would blank the viewer mid-look;
       * a File is a plain heap object that survives, and the lightbox
       * creates (and revokes) its own object URL from it.
       */
      file: File;
      filename: string;
    };

type LightboxState = {
  /** Active item — null means closed */
  item: LightboxItem | null;
  open: (item: LightboxItem) => void;
  close: () => void;
};

export const useLightboxStore = create<LightboxState>((set) => ({
  item: null,
  open: (item) => set({ item }),
  close: () => set({ item: null }),
}));

/**
 * True for an unmodified left-click. Call sites intercept ONLY these —
 * middle-click, ctrl/cmd-click (new tab) and right-click (save image as)
 * keep the anchor's native behavior.
 */
export function isPlainLeftClick(e: {
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): boolean {
  return e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey;
}
