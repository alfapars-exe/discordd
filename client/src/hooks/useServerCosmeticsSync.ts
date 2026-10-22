/**
 * useServerCosmeticsSync — loads the active server's member cosmetics map
 * (Faz G). Lives outside cosmeticsStore so that store imports no other store
 * (D1 emojiStore → serverStore → … → authStore cycle lesson). Mounted once
 * in AppLayout; the store de-duplicates loads and WS
 * `user_cosmetics_update` keeps a loaded map fresh.
 */

import { useEffect } from "react";
import { useServerStore } from "../stores/serverStore";
import { useCosmeticsStore } from "../stores/cosmeticsStore";

export function useServerCosmeticsSync(): void {
  const activeServerId = useServerStore((s) => s.activeServerId);
  const loadServer = useCosmeticsStore((s) => s.loadServer);

  useEffect(() => {
    if (activeServerId) void loadServer(activeServerId);
  }, [activeServerId, loadServer]);
}
