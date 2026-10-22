/**
 * EmojiAutocomplete — `:shortcode` popup for custom server emojis (Faz D1).
 *
 * Same keyboard contract as MentionAutocomplete (document-level capture
 * listener for Arrow/Enter/Tab/Escape; auto-close on empty results so the
 * composer's synchronous `emojiActiveRef` never swallows an Enter).
 * Current server's emojis rank first, then prefix matches before substring.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useEmojiCatalog } from "../../hooks/useEmojiCatalog";
import type { CustomEmojiRef } from "../../utils/expressionTokens";
import CustomEmoji from "../shared/CustomEmoji";

type EmojiAutocompleteProps = {
  /** Text after the `:` trigger (already lower-case slug characters). */
  query: string;
  /** Server the composer belongs to (null in DMs). */
  serverId: string | null | undefined;
  onSelect: (emoji: CustomEmojiRef) => void;
  onClose: () => void;
};

const MAX_RESULTS = 8;

type Item = CustomEmojiRef & { serverName: string; rank: number };

function EmojiAutocomplete({ query, serverId, onSelect, onClose }: EmojiAutocompleteProps) {
  const { t } = useTranslation("expressions");
  const catalog = useEmojiCatalog(true);
  const [activeIndex, setActiveIndex] = useState(0);

  const results = useMemo<Item[]>(() => {
    const q = query.toLowerCase();
    const items: Item[] = [];
    for (const server of catalog.servers) {
      const serverBonus = server.id === serverId ? 0 : 2;
      for (const e of server.emojis) {
        const idx = e.name.indexOf(q);
        if (idx < 0) continue;
        items.push({
          name: e.name,
          id: e.id,
          animated: e.animated,
          serverName: server.name,
          rank: serverBonus + (idx === 0 ? 0 : 1),
        });
      }
    }
    items.sort((a, b) => a.rank - b.rank || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return items.slice(0, MAX_RESULTS);
  }, [query, catalog.servers, serverId]);

  // Reset highlight when the query changes (render-time guarded setState —
  // same pattern as MentionAutocomplete).
  const [lastQuery, setLastQuery] = useState(query);
  if (query !== lastQuery) {
    setLastQuery(query);
    setActiveIndex(0);
  }

  useEffect(() => {
    if (results.length === 0) onClose();
  }, [results.length, onClose]);

  const pick = useCallback(
    (item: Item) => onSelect({ name: item.name, id: item.id, animated: item.animated }),
    [onSelect],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (results.length === 0) return;
      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          setActiveIndex((prev) => (prev > 0 ? prev - 1 : results.length - 1));
          break;
        case "ArrowDown":
          e.preventDefault();
          setActiveIndex((prev) => (prev < results.length - 1 ? prev + 1 : 0));
          break;
        case "Enter":
        case "Tab": {
          e.preventDefault();
          const item = results[activeIndex];
          if (item) pick(item);
          break;
        }
        case "Escape":
          e.preventDefault();
          onClose();
          break;
      }
    },
    [results, activeIndex, pick, onClose],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [handleKeyDown]);

  if (results.length === 0) return null;

  return (
    <div className="mention-popup emoji-autocomplete" role="listbox" aria-label={t("emojiAutocompleteLabel")}>
      {results.map((item, index) => (
        <button
          key={item.id}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          className={`mention-item${index === activeIndex ? " active" : ""}`}
          onMouseDown={(e) => {
            e.preventDefault();
            pick(item);
          }}
          onMouseEnter={() => setActiveIndex(index)}
        >
          <span className="emoji-autocomplete-img">
            <CustomEmoji id={item.id} name={item.name} animated={item.animated} still />
          </span>
          <span className="mention-item-name">:{item.name}:</span>
          <span className="emoji-autocomplete-server">{item.serverName}</span>
        </button>
      ))}
    </div>
  );
}

export default EmojiAutocomplete;
