/**
 * GifPicker — Klipy API-powered GIF search with debounce and viewport-aware positioning.
 * Uses backend proxy to keep API key server-side.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { trendingGifs, searchGifs, type GifResult } from "../../api/gif";
import { useGifFavorites, MAX_GIF_FAVORITES } from "../../hooks/useGifFavorites";
import { useToastStore } from "../../stores/toastStore";
import "../../styles/expressions.css";

type GifPickerProps = {
  onSelect: (url: string) => void;
  onClose: () => void;
};

function GifPicker({ onSelect, onClose }: GifPickerProps) {
  const { t } = useTranslation("chat");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GifResult[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isUnavailable, setIsUnavailable] = useState(false);
  const [flipped, setFlipped] = useState(false);
  const [tab, setTab] = useState<"browse" | "favorites">("browse");
  const { favorites, isFavorite, toggle } = useGifFavorites();
  const addToast = useToastStore((s) => s.addToast);

  const pickerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  // Load trending GIFs on mount
  useEffect(() => {
    async function loadTrending() {
      setIsLoading(true);
      const res = await trendingGifs(24);
      if (res.success && res.data) {
        setResults(res.data.results);
      } else if (res.error?.includes("not configured") || res.error?.includes("503")) {
        setIsUnavailable(true);
      }
      setIsLoading(false);
    }
    loadTrending();
  }, []);

  // Focus search input and check viewport overflow
  useEffect(() => {
    searchRef.current?.focus();

    if (pickerRef.current) {
      const rect = pickerRef.current.getBoundingClientRect();
      if (rect.top < 0) {
        setFlipped(true);
      }
    }
  }, []);

  // Close on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
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

  // Cleanup debounce timer
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  /** 300ms debounced search */
  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setQuery(value);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(async () => {
      setIsLoading(true);
      if (value.trim()) {
        const res = await searchGifs(value.trim(), 24);
        if (res.success && res.data) {
          setResults(res.data.results);
        }
      } else {
        // Query cleared — fall back to trending
        const res = await trendingGifs(24);
        if (res.success && res.data) {
          setResults(res.data.results);
        }
      }
      setIsLoading(false);
    }, 300);
  }, []);

  /** Pass selected GIF URL to parent and close */
  function handleGifClick(gif: GifResult) {
    onSelect(gif.url);
    onClose();
  }

  function handleFavoriteClick(e: React.MouseEvent, gif: GifResult) {
    e.stopPropagation();
    if (toggle(gif) === "full") {
      addToast("warning", t("expressions:favoritesFull", { max: MAX_GIF_FAVORITES }));
    }
  }

  function renderGrid(list: GifResult[]) {
    return (
      <div className="gif-picker-grid">
        {list.map((gif) => {
          const fav = isFavorite(gif.id);
          return (
            <div
              key={gif.id}
              className="gif-picker-item"
              onClick={() => handleGifClick(gif)}
              title={gif.title}
            >
              <img
                src={gif.preview_url}
                alt={gif.title}
                loading="lazy"
                decoding="async"
              />
              <button
                type="button"
                className="gif-fav-btn"
                aria-pressed={fav}
                aria-label={fav ? t("expressions:removeFavorite") : t("expressions:addFavorite")}
                title={fav ? t("expressions:removeFavorite") : t("expressions:addFavorite")}
                onClick={(e) => handleFavoriteClick(e, gif)}
              >
                {fav ? "★" : "☆"}
              </button>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className={`gif-picker${flipped ? " gif-picker-flipped" : ""}`} ref={pickerRef}>
      {/* Search input */}
      <div className="gif-picker-header">
        <input
          ref={searchRef}
          type="text"
          className="gif-picker-search"
          placeholder={t("gifSearch")}
          value={query}
          onChange={handleSearchChange}
          onFocus={() => setTab("browse")}
        />
        <div className="gif-picker-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            className="gif-picker-tab"
            aria-selected={tab === "browse"}
            onClick={() => setTab("browse")}
          >
            GIF
          </button>
          <button
            type="button"
            role="tab"
            className="gif-picker-tab"
            aria-selected={tab === "favorites"}
            onClick={() => setTab("favorites")}
          >
            {"★ "}{t("expressions:gifFavorites")}
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="gif-picker-body">
        {tab === "favorites" ? (
          favorites.length === 0 ? (
            <div className="gif-picker-empty">{t("expressions:noFavorites")}</div>
          ) : (
            renderGrid(favorites)
          )
        ) : isUnavailable ? (
          <div className="gif-picker-empty">{t("gifUnavailable")}</div>
        ) : isLoading && results.length === 0 ? (
          <div className="gif-picker-empty">{t("gifLoading")}</div>
        ) : results.length === 0 ? (
          <div className="gif-picker-empty">{t("gifNoResults")}</div>
        ) : (
          renderGrid(results)
        )}
      </div>

      {/* Klipy attribution — required by API TOS */}
      <div className="gif-picker-footer">
        <span className="gif-picker-powered">Powered by KLIPY</span>
      </div>
    </div>
  );
}

export default GifPicker;
