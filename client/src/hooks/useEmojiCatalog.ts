/**
 * useEmojiCatalog — member-filtered view over emojiStore (Faz D1, D-17).
 *
 * Every emoji surface (picker, `:` autocomplete, reactions) goes through
 * this hook: it lazily triggers `ensureLoaded` for the current member-server
 * id set and hides servers the user is no longer in (serverStore order).
 * Lives outside emojiStore so the store itself imports no other store.
 */

import { useEffect, useMemo } from "react";
import { useEmojiStore, serverIdSignature, type EmojiLoadStatus } from "../stores/emojiStore";
import { useServerStore } from "../stores/serverStore";
import type { ServerEmoji } from "../types/expression";

export type EmojiCatalogServer = { id: string; name: string; emojis: ServerEmoji[] };

export type EmojiCatalog = {
  servers: EmojiCatalogServer[];
  byServer: Record<string, ServerEmoji[]>;
  status: EmojiLoadStatus;
};

export function useEmojiCatalog(enabled: boolean): EmojiCatalog {
  const servers = useServerStore((s) => s.servers);
  const byServer = useEmojiStore((s) => s.byServer);
  const status = useEmojiStore((s) => s.status);
  const ensureLoaded = useEmojiStore((s) => s.ensureLoaded);

  const sig = useMemo(() => serverIdSignature(servers.map((s) => s.id)), [servers]);

  useEffect(() => {
    if (!enabled || !sig) return;
    void ensureLoaded(sig.split(","));
  }, [enabled, sig, ensureLoaded]);

  return useMemo(() => {
    const memberByServer: Record<string, ServerEmoji[]> = {};
    const list: EmojiCatalogServer[] = [];
    for (const s of servers) {
      const emojis = byServer[s.id];
      if (!emojis || emojis.length === 0) continue;
      memberByServer[s.id] = emojis;
      list.push({ id: s.id, name: s.name, emojis });
    }
    return { servers: list, byServer: memberByServer, status };
  }, [servers, byServer, status]);
}

/** Non-hook snapshot of the member-filtered catalog (composer send path). */
export function getMemberEmojiCatalog(): Record<string, ServerEmoji[]> {
  const memberIds = new Set(useServerStore.getState().servers.map((s) => s.id));
  const out: Record<string, ServerEmoji[]> = {};
  for (const [sid, list] of Object.entries(useEmojiStore.getState().byServer)) {
    if (memberIds.has(sid)) out[sid] = list;
  }
  return out;
}
