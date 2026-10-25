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
import type { ChatMessage } from "../hooks/useChatContext";

export type LightboxMetadata = {
  authorName?: string;
  authorAvatarUrl?: string | null;
  createdAt?: string;
  messageId?: string;
  message?: ChatMessage;
};

export type LightboxItem = LightboxMetadata & (
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
    });

type LightboxState = {
  /** Active item — null means closed */
  item: LightboxItem | null;
  items: LightboxItem[];
  index: number;
  open: (item: LightboxItem) => void;
  openGallery: (items: LightboxItem[], index?: number) => void;
  next: () => void;
  previous: () => void;
  close: () => void;
};

export const useLightboxStore = create<LightboxState>((set) => ({
  item: null,
  items: [],
  index: 0,
  open: (item) => set({ item, items: [item], index: 0 }),
  openGallery: (items, requestedIndex = 0) => {
    if (items.length === 0) return;
    const index = Math.max(0, Math.min(requestedIndex, items.length - 1));
    set({ items, index, item: items[index] });
  },
  next: () =>
    set((state) => {
      if (state.items.length < 2) return state;
      const index = (state.index + 1) % state.items.length;
      return { index, item: state.items[index] };
    }),
  previous: () =>
    set((state) => {
      if (state.items.length < 2) return state;
      const index = (state.index - 1 + state.items.length) % state.items.length;
      return { index, item: state.items[index] };
    }),
  close: () => set({ item: null, items: [], index: 0 }),
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
