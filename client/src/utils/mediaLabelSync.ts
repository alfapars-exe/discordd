import { getAuthGeneration } from "../api/client";
import type { MediaLabelReference } from "../api/mediaLabels";
import { useAuthStore } from "../stores/authStore";

export type MediaLabelChange = MediaLabelReference & { user_id: string };
type Source = Pick<MediaLabelReference, "source_kind" | "channel_id" | "message_id">;
type Listener = { owner: string; source: Source; generation: number; notify: () => void };
// Only mounted consumers are retained; no labels or unbounded message history.
const listeners = new Set<Listener>();
export function subscribeMediaLabelChanges(owner: string, source: Source, notify: () => void) {
  const listener = { owner, source, generation: getAuthGeneration(), notify };
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function invalidateMediaLabels(owner: string, source?: Source) {
  if (!owner || useAuthStore.getState().user?.id !== owner) return;
  const generation = getAuthGeneration();
  for (const listener of [...listeners]) {
    if (listener.owner !== owner || listener.generation !== generation) continue;
    if (source && (listener.source.source_kind !== source.source_kind || listener.source.channel_id !== source.channel_id || listener.source.message_id !== source.message_id)) continue;
    listener.notify();
  }
}
export function receiveMediaLabelChange(input: unknown) {
  if (!input || typeof input !== "object") return;
  const entry = input as Partial<MediaLabelChange>;
  if (!["channel", "dm", "group"].includes(entry.source_kind ?? "")) return;
  if (![entry.user_id, entry.channel_id, entry.message_id, entry.revision].every((value) => typeof value === "string" && value.length > 0 && value.length <= 128)) return;
  if (typeof entry.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(entry.fingerprint)) return;
  invalidateMediaLabels(entry.user_id!, entry as MediaLabelChange);
}
