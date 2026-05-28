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

import { useState, useEffect, useRef, useCallback, lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";

const Picker = lazy(() => import("@emoji-mart/react"));

type EmojiPickerProps = {
  onSelect: (emoji: string) => void;
  onClose: () => void;
};

function EmojiPicker({ onSelect, onClose }: EmojiPickerProps) {
  const { i18n } = useTranslation();
  const pickerRef = useRef<HTMLDivElement>(null);
  const [flipped, setFlipped] = useState(false);
  const [data, setData] = useState<unknown>(null);

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
    if (!data || !pickerRef.current) return;
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
  }, [data]);

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
    (emoji: { native: string }) => {
      onSelect(emoji.native);
      onClose();
    },
    [onSelect, onClose]
  );

  // Pierce shadow DOM to make internal background transparent for frosted glass.
  // Re-runs when data arrives because Picker only mounts after that.
  useEffect(() => {
    if (!data || !pickerRef.current) return;
    const el = pickerRef.current.querySelector("em-emoji-picker");
    if (!el?.shadowRoot) return;
    const style = document.createElement("style");
    style.textContent = "#root { background-color: transparent !important; } .sticky { background-color: transparent !important; }";
    el.shadowRoot.appendChild(style);
    return () => { style.remove(); };
  }, [data]);

  return (
    <div
      className={`emoji-picker${flipped ? " emoji-picker-flipped" : ""}`}
      ref={pickerRef}
    >
      {data && (
        <Suspense fallback={null}>
          <Picker
            data={data}
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
