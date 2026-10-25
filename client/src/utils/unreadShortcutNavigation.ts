import { getUnreadCounts } from "../api/readState";
import { getChannels } from "../api/channels";
import { useAuthStore } from "../stores/authStore";
import { useServerStore } from "../stores/serverStore";
import { useChannelStore } from "../stores/channelStore";
import { useUIStore } from "../stores/uiStore";
import { useToastStore } from "../stores/toastStore";
import i18n from "../i18n";

let generation = 0;
let pending: AbortController | undefined;
/** Fresh server data, including servers whose channel tree has never been opened.
 * Never changes read state or voice membership. Failed snapshots are not used. */
export async function navigateUnreadChannel(direction: 1 | -1, mentionsOnly = false): Promise<void> {
  const request = ++generation;
  pending?.abort();
  pending = undefined;
  const owner = useAuthStore.getState().user;
  const destination = useUIStore.getState().destination;
  if (!owner || document.querySelector("dialog[open], .settings-overlay, .modal-backdrop, .report-overlay")) return;
  const controller = new AbortController();
  pending = controller;
  const servers = useServerStore.getState().servers;
  const results: { id: string; name: string; type: "text" | "audit"; server: typeof servers[number]; unread: boolean }[][] = servers.map(() => []);
  const current = () => request === generation && useAuthStore.getState().user === owner && useUIStore.getState().destination === destination;
  let cursor = 0;
  try {
    // Bound fan-out regardless of joined server count.
    await Promise.all(Array.from({ length: Math.min(4, servers.length) }, async () => {
      while (cursor < servers.length && current()) {
        const index = cursor++;
        const server = servers[index];
        if (useServerStore.getState().mutedServerIds.has(server.id)) continue;
        const options = { signal: controller.signal, timeoutMs: 15_000, isCurrent: current };
        const counts = await getUnreadCounts(server.id, options);
        if (!counts.success || !counts.data) throw new Error("unread snapshot unavailable");
        if (mentionsOnly && counts.data.some((item) => typeof item.mention_count !== "number")) throw new Error("server does not support mention counts");
        const unread = new Set(counts.data.filter((item) => item.unread_count > 0 && (!mentionsOnly || (item.mention_count ?? 0) > 0)).map((item) => item.channel_id));
        // Keep the current server's full order so an already-read active channel
        // remains the navigation anchor, rather than always selecting the first.
        if (!unread.size && destination.serverInfo?.serverId !== server.id) continue;
        if (!current()) return;
        const tree = await getChannels(server.id, options);
        if (!tree.success || !tree.data) throw new Error("channel snapshot unavailable");
        results[index] = tree.data.flatMap((category) => category.channels).flatMap((channel) =>
          (channel.type === "text" || channel.type === "audit") && !channel.archived_at
            ? [{ id: channel.id, name: channel.name, type: channel.type, server, unread: unread.has(channel.id) }] : []);
      }
    }));
    if (!current() || document.querySelector("dialog[open], .settings-overlay, .modal-backdrop, .report-overlay")) return;
    const ordered = results.flat();
    const anchor = ordered.findIndex((item) => item.id === destination.channelId);
    for (let step = 1; step <= ordered.length; step++) {
      const index = anchor < 0 ? (direction === 1 ? step - 1 : ordered.length - step) : (anchor + direction * step + ordered.length) % ordered.length;
      const channel = ordered[index];
      const liveServers = useServerStore.getState();
      if (!channel.unread || channel.id === destination.channelId || liveServers.mutedServerIds.has(channel.server.id) || useChannelStore.getState().mutedChannelIds.has(channel.id) || !liveServers.servers.some((server) => server.id === channel.server.id)) continue;
      useUIStore.getState().navigate({ type: channel.type, channelId: channel.id, label: channel.name, serverInfo: { serverId: channel.server.id, serverName: channel.server.name, serverIconUrl: channel.server.icon_url } });
      return;
    }
    useToastStore.getState().addToast("info", i18n.t(mentionsOnly ? "common:shortcutNoUnreadMentions" : "common:shortcutNoUnreadChannels"));
  } catch {
    if (current()) {
      generation++;
      controller.abort();
      useToastStore.getState().addToast("error", i18n.t("common:shortcutUnreadFailed"));
    }
  } finally {
    if (pending === controller) pending = undefined;
  }
}
