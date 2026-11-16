const MAX_EXPECTED_MESSAGES = 10_000;
const identifier = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);

function validateProfile({ probeId, channelId, userIds, messagesPerSender }) {
  if (!identifier(probeId) || !identifier(channelId)) throw new Error("fanout_invalid_scope");
  if (!Array.isArray(userIds) || userIds.length < 1 || userIds.length > 1000 ||
      Array.from(userIds).some(id => !identifier(id)) || new Set(userIds).size !== userIds.length) {
    throw new Error("fanout_invalid_senders");
  }
  if (!Number.isSafeInteger(messagesPerSender) || messagesPerSender < 1 ||
      userIds.length * messagesPerSender > MAX_EXPECTED_MESSAGES) throw new Error("fanout_invalid_message_count");
  return { probeId, channelId, userIds: [...userIds], messagesPerSender };
}

function readProbe(frame, profile) {
  if (frame?.op !== "message_create" || frame.data?.channel_id !== profile.channelId ||
      typeof frame.data.content !== "string" || frame.data.content.length > 4096) return null;
  let payload;
  try { payload = JSON.parse(frame.data.content); } catch { return null; }
  return payload?.probe === profile.probeId ? { message: frame.data, payload } : null;
}

function validRecord({ message, payload }, lanes, messagesPerSender) {
  return identifier(message.id) && lanes.has(message.user_id) && message.user_id === payload.sender &&
    Number.isSafeInteger(payload.sequence) && payload.sequence >= 1 && payload.sequence <= messagesPerSender;
}

/** Bounded receiver-side delivery accounting. Reordering is diagnostic;
 * completeness requires every sender/sequence exactly once, with unique IDs.
 * Snapshotting never seals the receiver: a late duplicate must still fail it.
 */
export function createFanoutObserver(options) {
  const profile = validateProfile(options);
  const lanes = new Map(profile.userIds.map(id => [id, { seen: new Set(), highest: 0 }]));
  const messageIds = new Set();
  const counts = { received: 0, duplicates: 0, invalid: 0, ignored: 0, outOfOrder: 0 };
  return {
    observe(frame) {
      const record = readProbe(frame, profile);
      if (!record) { counts.ignored++; return { kind: "ignored" }; }
      if (!validRecord(record, lanes, profile.messagesPerSender)) { counts.invalid++; return { kind: "invalid" }; }
      const { message, payload } = record, lane = lanes.get(message.user_id);
      if (messageIds.has(message.id) || lane.seen.has(payload.sequence)) {
        counts.duplicates++;
        return { kind: "duplicate" };
      }
      if (payload.sequence < lane.highest) counts.outOfOrder++;
      lane.highest = Math.max(lane.highest, payload.sequence);
      lane.seen.add(payload.sequence); messageIds.add(message.id); counts.received++;
      return { kind: "accepted", sender: message.user_id, sequence: payload.sequence };
    },
    snapshot() {
      const expected = profile.userIds.length * profile.messagesPerSender;
      return {
        ...counts, expected, missing: expected - counts.received,
        complete: counts.received === expected && counts.duplicates === 0 && counts.invalid === 0,
        perSender: [...lanes].map(([userId, lane]) => ({ userId, received: lane.seen.size, missing: profile.messagesPerSender - lane.seen.size })),
      };
    },
  };
}
