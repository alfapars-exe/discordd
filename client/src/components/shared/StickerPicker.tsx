/**
 * StickerPicker — composer sticker picker (Faz D2, D2-21).
 *
 * Lists the member-filtered sticker catalog grouped by server, with a
 * Turkish-aware search over display name / shortcode / tags. Selecting a
 * sticker hands the whole-message token to `onSelect` (the composer sends it
 * immediately, like a GIF). Thumbnails are always the static PNG.
 * Positioning mirrors GifPicker (`.gif-picker` frame, flips below when it
 * would leave the viewport); Escape and outside click close it.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStickerCatalog } from "../../hooks/useStickerCatalog";
import { buildStickerToken, matchStickerQuery } from "../../utils/stickerTokens";
import StickerImage from "./StickerImage";
import "../../styles/expressions.css";

type StickerPickerProps = {
  onSelect: (token: string) => void;
  onClose: () => void;
};

function StickerPicker({ onSelect, onClose }: StickerPickerProps) {
  const { t } = useTranslation("expressions");
  const catalog = useStickerCatalog(true);
  const [query, setQuery] = useState("");
  const [flipped, setFlipped] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
    if (pickerRef.current && pickerRef.current.getBoundingClientRect().top < 0) setFlipped(true);
  }, []);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) onClose();
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    const timer = setTimeout(() => document.addEventListener("mousedown", handleClickOutside), 0);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const groups = useMemo(
    () =>
      catalog.servers
        .map((s) => ({ ...s, stickers: s.stickers.filter((st) => matchStickerQuery(st, query)) }))
        .filter((s) => s.stickers.length > 0),
    [catalog.servers, query],
  );

  return (
    <div
      className={`gif-picker sticker-picker${flipped ? " gif-picker-flipped" : ""}`}
      ref={pickerRef}
      role="dialog"
      aria-label={t("stickerPicker")}
    >
      <div className="gif-picker-header">
        <input
          ref={searchRef}
          type="text"
          className="gif-picker-search"
          placeholder={t("stickerSearch")}
          aria-label={t("stickerSearch")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="gif-picker-body">
        {groups.length === 0 ? (
          <div className="gif-picker-empty">{t("noStickers")}</div>
        ) : (
          groups.map((g) => (
            <section key={g.id} className="sticker-picker-group">
              <h4 className="sticker-picker-server">{g.name}</h4>
              <div className="sticker-picker-grid">
                {g.stickers.map((st) => (
                  <button
                    key={st.id}
                    type="button"
                    className="sticker-picker-item"
                    aria-label={st.display_name}
                    title={st.display_name}
                    onClick={() =>
                      onSelect(buildStickerToken({ name: st.name, id: st.id, animated: st.animated }))
                    }
                  >
                    <StickerImage id={st.id} name={st.name} animated={st.animated} still size="picker" />
                  </button>
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

export default StickerPicker;
