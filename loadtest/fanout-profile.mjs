import { createFanoutObserver } from "./fanout-observer.mjs";

const id = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
function integer(env, name, fallback) {
  const value = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
export function readFanoutProfile(env, connection) {
  if (!Object.keys(env).some(key => key.startsWith("FANOUT_") && env[key] !== "")) return null;
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?\/?$/.test(connection.baseURL)) throw new Error("fanout_requires_loopback");
  if (!id(env.FANOUT_SERVER_ID)) throw new Error("fanout_invalid_server");
  let userIds;
  try { userIds = JSON.parse(env.FANOUT_USER_IDS); } catch { throw new Error("fanout_invalid_senders"); }
  const profile = { probeId: env.FANOUT_PROBE_ID, channelId: env.FANOUT_CHANNEL_ID, userIds,
    messagesPerSender: integer(env, "FANOUT_MESSAGES_PER_SENDER", 5),
    delayMs: integer(env, "FANOUT_START_DELAY_SECONDS", 20) * 1000,
    intervalMs: integer(env, "FANOUT_MESSAGE_INTERVAL_MS", 2000), serverId: env.FANOUT_SERVER_ID,
  };
  createFanoutObserver(profile);
  if (userIds.length !== connection.vus || connection.userCount !== connection.vus) throw new Error("fanout_requires_distinct_users");
  const ramp = /^(\d+)s$/.exec(connection.rampUp);
  const lastSend = profile.delayMs + (profile.messagesPerSender - 1) * profile.intervalMs;
  if (!ramp || profile.delayMs < (Number(ramp[1]) + 5) * 1000 || profile.intervalMs < 1000 ||
      lastSend > connection.holdSeconds * 1000 - 5000) throw new Error("fanout_invalid_schedule");
  return profile;
}

function acceptedMessage(response, actor, channel) {
  try {
    const body = response.json();
    return response.status === 201 && body.success === true && id(body.data?.id) &&
      body.data.user_id === actor && body.data.channel_id === channel ? body.data : null;
  } catch { return null; }
}

export function createFanoutSession(profile, { vu, baseURL, accessToken, http, check, metrics, hash, log }) {
  const observer = createFanoutObserver(profile), actor = profile.userIds[(vu - 1) % profile.userIds.length];
  const acknowledged = new Map();
  for (const metric of Object.values(metrics)) metric.add(0);
  const send = sequence => {
    const content = JSON.stringify({ probe: profile.probeId, sender: actor, sequence });
    const response = http.post(`${baseURL}/api/servers/${encodeURIComponent(profile.serverId)}/channels/${encodeURIComponent(profile.channelId)}/messages`,
      JSON.stringify({ content, client_message_id: hash(JSON.stringify([profile.probeId, actor, sequence])) }),
      { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } });
    const message = acceptedMessage(response, actor, profile.channelId);
    const ok = check(response, { "fanout message accepted with correct actor/channel": () => message !== null });
    if (ok) { acknowledged.set(sequence, message.id); metrics.sent.add(1); }
  };
  return {
    start(socket) {
      for (let sequence = 1; sequence <= profile.messagesPerSender; sequence++) {
        socket.setTimeout(() => send(sequence), profile.delayMs + (sequence - 1) * profile.intervalMs);
      }
    },
    observe(frame) {
      const result = observer.observe(frame);
      if (result.kind === "accepted") metrics.received.add(1);
      if (result.kind === "duplicate") metrics.duplicates.add(1);
      if (result.kind === "invalid") metrics.invalid.add(1);
    },
    finish() {
      const summary = observer.snapshot(), receipts = observer.receipts();
      const own = receipts.filter(row => row[0] === actor);
      const agrees = acknowledged.size === profile.messagesPerSender && own.length === profile.messagesPerSender &&
        own.every(([, sequence, messageId]) => acknowledged.get(sequence) === messageId);
      const ok = check(summary, {
        "fanout received all expected unique deliveries": value => value.complete,
        "fanout HTTP and own WebSocket IDs agree": () => agrees,
      });
      if (ok) metrics.receivers.add(1);
      log("FANOUT_RECEIPT " + JSON.stringify({ receiver: actor, digest: hash(JSON.stringify(receipts)), summary, acknowledged: [...acknowledged] }));
      return { summary, agrees };
    },
  };
}
