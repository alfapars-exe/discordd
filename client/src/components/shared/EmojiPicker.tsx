/** EmojiPicker — @emoji-mart/react wrapper with viewport-aware positioning.
 *
 * Both `@emoji-mart/react` (Picker) and `@emoji-mart/data` (~480 KiB JSON of
 * every emoji + keywords) are dynamic-imported here. The picker is only ever
 * mounted in response to a user gesture (button click in MessageInput,
 * ChannelTree etc.), so paying the bundle cost lazily costs nothing in UX but
 * removes ~499 KiB from the initial /login payload — that was the largest
 * single waste in the Lighthouse audit (Mayıs 28 2026). Vite's manualChunks
 * still groups both into the "emoji" chunk; the difference is the chunk is
 * now async-only, so it is no longer preloaded from index.html.
 */

import { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { useEmojiCatalog } from "../../hooks/useEmojiCatalog";
import { resolveAssetUrl } from "../../utils/constants";
import { EMOJI_ID, buildEmojiToken, emojiStaticUrl } from "../../utils/expressionTokens";
import type { ServerEmoji } from "../../types/expression";

const Picker = lazy(() => import("@emoji-mart/react"));

type EmojiPickerProps = {
  /**
   * Receives a native unicode emoji, or — when `customEmojis` is on and a
   * server emoji is picked — its content token `<:name:id>` / `<a:name:id>`.
   */
  onSelect: (emoji: string) => void;
  onClose: () => void;
  /** Show the viewer's member-server custom emojis as extra categories. */
  customEmojis?: boolean;
};

/** emoji-mart v5 custom category shape (the React wrapper is untyped). */
type MartCustomCategory = {
  id: string;
  name: string;
  emojis: { id: string; name: string; keywords: string[]; skins: { src: string }[] }[];
};

/** Subset of emoji-mart's onEmojiSelect payload this wrapper reads. */
type MartSelection = { id?: string; native?: string };

function EmojiPicker({ onSelect, onClose, customEmojis = false }: EmojiPickerProps) {
  const { i18n } = useTranslation();
  const pickerRef = useRef<HTMLDivElement>(null);
  const [flipped, setFlipped] = useState(false);
  const [data, setData] = useState<unknown>(null);
  const catalog = useEmojiCatalog(customEmojis);

  // One emoji-mart category per member server. Pickers always show the
  // static PNG (Karar D-22) — emoji-mart renders `skins[0].src` as <img>
  // even with set="native" (emoji-mart 5.6 Emoji component: `emojiSkin.src`
  // takes precedence over the native glyph).
  const { custom, customById } = useMemo(() => {
    const byId = new Map<string, ServerEmoji>();
    if (!customEmojis) return { custom: undefined, customById: byId };
    const categories: MartCustomCategory[] = catalog.servers
      .map((s) => ({
      id: `server_${s.id}`,
      name: s.name,
      // Same id gate as CustomEmoji: only a 16-hex id may reach a URL.
      emojis: s.emojis.filter((e) => EMOJI_ID.test(e.id)).map((e) => {
        byId.set(e.id, e);
        return {
          id: e.id,
          name: e.display_name,
          keywords: [e.name],
          skins: [{ src: resolveAssetUrl(emojiStaticUrl(e.id)) }],
        };
      }),
      }))
      .filter((c) => c.emojis.length > 0);
    return { custom: categories.length > 0 ? categories : undefined, customById: byId };
  }, [customEmojis, catalog.servers]);

  // emoji-mart only honours `custom` at construction time cheaply (a later
  // change resets the whole grid), so wait for the catalog fetch to settle.
  const catalogPending = customEmojis && catalog.status === "loading";
  const pickerReady = data !== null && !catalogPending;

  // emoji-mart data is a static JSON module — `.default` is the dataset.
  // Effect cleanup guards against StrictMode double-mount in dev.
  useEffect(() => {
    let active = true;
    void import("@emoji-mart/data").then((mod) => {
      if (active) setData(mod.default);
    });
    return () => {
      active = false;
    };
  }, []);

  // Flip picker downward if it overflows the viewport top. Runs after data
  // loads (Picker mounts then), otherwise the rect is zero-sized.
  useEffect(() => {
    if (!pickerReady || !pickerRef.current) return;
    const raf = requestAnimationFrame(() => {
      if (!pickerRef.current) return;
      const rect = pickerRef.current.getBoundingClientRect();
      if (rect.top < 0) {
        setFlipped(true);
      } else if (rect.bottom > window.innerHeight) {
        setFlipped(false);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [pickerReady]);

  // Close on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        onClose();
      }
    }

    // Defer to avoid the same click that opened the picker immediately closing it
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleEmojiSelect = useCallback(
    (emoji: MartSelection) => {
      if (emoji.native) {
        onSelect(emoji.native);
      } else {
        const picked = emoji.id ? customById.get(emoji.id) : undefined;
        if (!picked) return;
        onSelect(buildEmojiToken({ name: picked.name, id: picked.id, animated: picked.animated }));
      }
      onClose();
    },
    [onSelect, onClose, customById]
  );

  // Pierce shadow DOM to make internal background transparent for frosted glass.
  // Re-runs when data arrives because Picker only mounts after that.
  useEffect(() => {
    if (!pickerReady || !pickerRef.current) return;
    const el = pickerRef.current.querySelector("em-emoji-picker");
    if (!el?.shadowRoot) return;
    const style = document.createElement("style");
    style.textContent = "#root { background-color: transparent !important; } .sticky { background-color: transparent !important; }";
    el.shadowRoot.appendChild(style);
    return () => { style.remove(); };
  }, [pickerReady]);

  return (
    <div
      className={`emoji-picker${flipped ? " emoji-picker-flipped" : ""}`}
      ref={pickerRef}
    >
      {pickerReady && (
        <Suspense fallback={null}>
          <Picker
            data={data}
            custom={custom}
            onEmojiSelect={handleEmojiSelect}
            locale={i18n.language === "tr" ? "tr" : "en"}
            theme="dark"
            set="native"
            previewPosition="none"
            skinTonePosition="search"
            perLine={8}
            maxFrequentRows={2}
            navPosition="bottom"
            emojiSize={28}
            emojiButtonSize={36}
          />
        </Suspense>
      )}
    </div>
  );
}

export default EmojiPicker;
