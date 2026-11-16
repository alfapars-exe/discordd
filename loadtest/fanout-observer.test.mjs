import assert from "node:assert/strict";
import test from "node:test";
import { createFanoutObserver } from "./fanout-observer.mjs";

const profile = () => ({ probeId: "probe-1", channelId: "channel-1", userIds: ["alice", "bob"], messagesPerSender: 2 });
const frame = (sender, sequence, id = `${sender}-${sequence}`) => ({ op: "message_create", data: {
  id, channel_id: "channel-1", user_id: sender,
  content: JSON.stringify({ probe: "probe-1", sender, sequence }),
} });
function receiveAll(observer) {
  for (const sender of ["alice", "bob"]) for (const sequence of [1, 2]) observer.observe(frame(sender, sequence));
}

test("every sender must deliver every sequence before the receiver is complete", () => {
  const observer = createFanoutObserver(profile());
  observer.observe(frame("alice", 1));
  assert.equal(observer.snapshot().complete, false);
  assert.equal(observer.snapshot().missing, 3);
  observer.observe(frame("bob", 1)); observer.observe(frame("bob", 2)); observer.observe(frame("alice", 2));
  const result = observer.snapshot();
  assert.equal(result.complete, true); assert.equal(result.received, 4); assert.equal(result.missing, 0);
  assert.deepEqual(result.perSender.map(row => row.received), [2, 2]);
});

test("a late duplicate poisons a previously complete receiver", () => {
  const observer = createFanoutObserver(profile()); receiveAll(observer);
  assert.equal(observer.snapshot().complete, true);
  observer.observe(frame("alice", 1));
  assert.equal(observer.snapshot().complete, false);
  assert.equal(observer.snapshot().duplicates, 1); assert.equal(observer.snapshot().received, 4);
});
test("a second ID for the same logical message is a duplicate", () => {
  const observer = createFanoutObserver(profile()); observer.observe(frame("alice", 1));
  assert.equal(observer.observe(frame("alice", 1, "different-id")).kind, "duplicate");
  assert.equal(observer.snapshot().missing, 3);
});
test("reusing an ID for a different logical message cannot fill a missing slot", () => {
  const observer = createFanoutObserver(profile()); observer.observe(frame("alice", 1, "shared-id"));
  assert.equal(observer.observe(frame("bob", 1, "shared-id")).kind, "duplicate");
  assert.equal(observer.snapshot().received, 1);
});
test("reordered delivery remains complete and is counted separately", () => {
  const observer = createFanoutObserver(profile());
  observer.observe(frame("alice", 2)); observer.observe(frame("alice", 1));
  observer.observe(frame("bob", 1)); observer.observe(frame("bob", 2));
  assert.equal(observer.snapshot().complete, true); assert.equal(observer.snapshot().outOfOrder, 1);
});
test("other operations, channels, probes and malformed JSON do not satisfy delivery", () => {
  const observer = createFanoutObserver(profile());
  observer.observe({ op: "heartbeat_ack" });
  observer.observe({ ...frame("alice", 1), data: { ...frame("alice", 1).data, channel_id: "other" } });
  observer.observe({ ...frame("alice", 1), data: { ...frame("alice", 1).data, content: '{"probe":"other"}' } });
  observer.observe({ op: "message_create", data: { channel_id: "channel-1", content: "malformed" } });
  assert.equal(observer.snapshot().ignored, 4); assert.equal(observer.snapshot().missing, 4);
});
for (const [name, message] of [
  ["unknown sender", frame("stranger", 1)],
  ["sequence zero", frame("alice", 0)],
  ["sequence past end", frame("alice", 3)],
  ["noninteger sequence", frame("alice", 1.5)],
  ["missing ID", frame("alice", 1, "")],
]) test(`rejects ${name} inside the matching probe`, () => {
  const observer = createFanoutObserver(profile());
  assert.equal(observer.observe(message).kind, "invalid");
  assert.equal(observer.snapshot().received, 0); assert.equal(observer.snapshot().invalid, 1);
});
test("payload sender and authoritative event actor must match", () => {
  const observer = createFanoutObserver(profile()), message = frame("alice", 1);
  message.data.user_id = "bob";
  assert.equal(observer.observe(message).kind, "invalid");
});
test("configuration and returned snapshots cannot mutate receiver accounting", () => {
  const options = profile(), observer = createFanoutObserver(options);
  options.userIds[0] = "stranger";
  observer.snapshot().perSender[0].received = 999;
  receiveAll(observer); assert.equal(observer.snapshot().complete, true);
});
for (const [name, patch] of [
  ["empty scope", { probeId: "" }], ["invalid channel", { channelId: "/other" }],
  ["no senders", { userIds: [] }], ["duplicate senders", { userIds: ["alice", "alice"] }],
  ["negative count", { messagesPerSender: -1 }], ["oversized accounting", { messagesPerSender: 5001 }],
]) test(`rejects ${name} before any network work`, () => {
  assert.throws(() => createFanoutObserver({ ...profile(), ...patch }), /fanout_invalid_/);
});

test("rejects a sparse sender list instead of accepting an undefined actor", () => {
  assert.throws(() => createFanoutObserver({ ...profile(), userIds: new Array(1), messagesPerSender: 1 }), /fanout_invalid_senders/);
});
