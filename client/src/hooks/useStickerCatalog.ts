/**
 * useStickerCatalog — member-filtered view over stickerStore (Faz D2, D2-19).
 *
 * Mirror of useEmojiCatalog: lazily triggers `ensureLoaded` for the current
 * member-server id set and hides servers the user is no longer in
 * (serverStore order). Lives outside stickerStore so the store itself
 * imports no other store.
 */

import { useEffect, useMemo } from "react";
import { useStickerStore, type StickerLoadStatus } from "../stores/stickerStore";
import { serverIdSignature } from "../stores/emojiStore";
import { useServerStore } from "../stores/serverStore";
import type { ServerSticker } from "../types/expression";

export type StickerCatalogServer = { id: string; name: string; stickers: ServerSticker[] };

export type StickerCatalog = {
  servers: StickerCatalogServer[];
  byServer: Record<string, ServerSticker[]>;
  byId: Record<string, ServerSticker>;
  status: StickerLoadStatus;
};

export function useStickerCatalog(enabled: boolean): StickerCatalog {
  const servers = useServerStore((s) => s.servers);
  const byServer = useStickerStore((s) => s.byServer);
  const status = useStickerStore((s) => s.status);
  const ensureLoaded = useStickerStore((s) => s.ensureLoaded);

  const sig = useMemo(() => serverIdSignature(servers.map((s) => s.id)), [servers]);

  useEffect(() => {
    if (!enabled || !sig) return;
    void ensureLoaded(sig.split(","));
  }, [enabled, sig, ensureLoaded]);

  return useMemo(() => {
    const memberByServer: Record<string, ServerSticker[]> = {};
    const memberById: Record<string, ServerSticker> = {};
    const list: StickerCatalogServer[] = [];
    for (const s of servers) {
      const stickers = byServer[s.id];
      if (!stickers || stickers.length === 0) continue;
      memberByServer[s.id] = stickers;
      for (const st of stickers) memberById[st.id] = st;
      list.push({ id: s.id, name: s.name, stickers });
    }
    return { servers: list, byServer: memberByServer, byId: memberById, status };
  }, [servers, byServer, status]);
}
