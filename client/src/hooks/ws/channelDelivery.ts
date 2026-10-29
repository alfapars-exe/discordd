import { apiClient, getAuthGeneration } from "../../api/client";
import { getAuthSessionOwner, subscribeAuthOwnerChanges, subscribeAuthGenerationChanges } from "../../api/authSessionEvents";
import type { WSMessage } from "../../types";

const cursors = new Map<string, number>();
const queues = new Map<string, Promise<void>>();
const seen = new Set<string>();
const versions = new Map<string, number>();
function clear() { cursors.clear(); queues.clear(); seen.clear(); versions.clear(); }
subscribeAuthOwnerChanges(clear);
subscribeAuthGenerationChanges(clear);

export async function dispatchChannelDelivery(msg: WSMessage, apply: () => Promise<void>, isCurrent: () => boolean): Promise<void> {
  if (!msg.event_id || !msg.channel_sequence) { await apply(); return; }
  const d = msg.d as {channel_id?: string; id?: string};
  if (!d.channel_id) { await apply(); return; }
  const key = `${getAuthSessionOwner()}:${getAuthGeneration()}:${d.channel_id}`;
  const eventId = `${key}:${msg.event_id}`;
  const versionKey = `${key}:${msg.op === "notification_create" ? "notification:" : "message:"}${d.id}`;
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    if (!isCurrent() || seen.has(eventId) || (versions.get(versionKey) ?? 0) >= msg.channel_sequence!) return;
    await apply();
    if (!isCurrent()) return;
    seen.add(eventId); versions.set(versionKey, msg.channel_sequence!);
    if (versions.size > 50_000) versions.delete(versions.keys().next().value!);
    // Event dedupe is bounded; per-message version fences survive old ID eviction.
    if (seen.size > 10_000) seen.delete(seen.values().next().value!);
  });
  queues.set(key, next);
  try { await next; } finally { if (queues.get(key) === next) queues.delete(key); }
}

type EventPage = {events: WSMessage[]; cursor: number; has_more: boolean; reset: boolean};
export async function resyncChannelDelivery(server: string, channel: string, apply: (event: WSMessage) => Promise<void>, snapshot: () => Promise<void>, isCurrent: () => boolean) {
  const key = `${getAuthSessionOwner()}:${getAuthGeneration()}:${server}:${channel}`;
  let after = cursors.get(key) ?? 0;
  for (;;) {
    if (!isCurrent()) return;
    const response = await apiClient<EventPage>(`/servers/${server}/channels/${channel}/message-events?after_sequence=${after}`, {isCurrent, timeoutMs: 15_000});
    if (!isCurrent()) return;
    if (!response.success || !response.data) { await snapshot(); return; }
    const page = response.data;
    if (page.reset) {
      await snapshot();
      if (!isCurrent()) return;
    } else {
      for (const event of page.events) { if (!isCurrent()) return; await apply({...event, server_id: server}); }
    }
    cursors.set(key, page.cursor);
    if (!page.has_more || page.cursor <= after) return;
    after = page.cursor;
  }
}
