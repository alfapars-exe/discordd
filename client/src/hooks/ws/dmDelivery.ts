import { getAuthGeneration } from "../../api/client";
import { getAuthSessionOwner, subscribeAuthGenerationChanges, subscribeAuthOwnerChanges } from "../../api/authSessionEvents";
import { dmSourceSequence } from "../../utils/dmSourceOrder";
import type { WSMessage } from "../../types";

const queues = new Map<string, Promise<void>>();
const seen = new Set<string>();
const versions = new Map<string, bigint>();

function clear() {
  queues.clear();
  seen.clear();
  versions.clear();
}
subscribeAuthOwnerChanges(clear);
subscribeAuthGenerationChanges(clear);

/** Independent state domains must not hide each other's updates. In particular,
 * a pin/reaction event must not fence an earlier content event for that message. */
function deliveryTarget(msg: WSMessage): { channel: string; entity: string } | null {
  switch (msg.op) {
    case "dm_message_create":
    case "dm_message_update":
    case "dm_message_delete":
      return { channel: msg.d.dm_channel_id, entity: `message:${msg.d.id}` };
    case "dm_message_pin":
      return { channel: msg.d.dm_channel_id, entity: `pin:${msg.d.message.id}` };
    case "dm_message_unpin":
      return { channel: msg.d.dm_channel_id, entity: `pin:${msg.d.message_id}` };
    case "dm_reaction_update":
      return { channel: msg.d.dm_channel_id, entity: `reaction:${msg.d.dm_message_id}` };
    case "dm_read":
      return { channel: msg.d.dm_channel_id, entity: `read:${msg.d.user_id}` };
    case "dm_channel_update":
      return { channel: msg.d.id, entity: "channel" };
    case "dm_channel_status_change":
      return { channel: msg.d.dm_channel_id, entity: "status" };
    case "notification_create":
      return msg.d.dm_channel_id ? { channel: msg.d.dm_channel_id, entity: `notification:${msg.d.id}` } : null;
    default:
      return null;
  }
}

/** The outbox can publish again after a successful send but a failed ACK.
 * Serialize before decryption, not just before store writes: Whisper envelopes
 * are single-use. Keep the fences across reconnects, but never across accounts. */
export async function dispatchDMDelivery(
  msg: WSMessage,
  apply: (isCurrent: () => boolean) => Promise<void>,
  isCurrent: () => boolean,
): Promise<void> {
  const sequence = dmSourceSequence(msg.dm_sequence);
  const target = deliveryTarget(msg);
  if (!msg.event_id || sequence === null || !target) {
    await apply(isCurrent);
    return;
  }
  const owner = getAuthSessionOwner();
  const generation = getAuthGeneration();
  const current = () => getAuthSessionOwner() === owner && getAuthGeneration() === generation;
  const key = JSON.stringify([owner, generation, target.channel]);
  const eventId = `${key}:${msg.event_id}`;
  const versionKey = `${key}:${target.entity}`;
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    if (!isCurrent() || !current() || seen.has(eventId) || (versions.get(versionKey) ?? 0n) >= sequence) return;
    // Once accepted, finish in this auth session even if the socket reconnects.
    // Cancelling after decryption consumes the ratchet but loses its plaintext,
    // so the same event cannot safely be decrypted again on the new socket.
    await apply(current);
    if (!current()) return;
    seen.add(eventId);
    versions.set(versionKey, sequence);
    // Bound memory while retaining per-entity fences after an event ID expires.
    if (seen.size > 10_000) seen.delete(seen.values().next().value!);
    if (versions.size > 50_000) versions.delete(versions.keys().next().value!);
  });
  queues.set(key, next);
  try {
    await next;
  } finally {
    if (queues.get(key) === next) queues.delete(key);
  }
}
