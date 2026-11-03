import { beforeEach, expect, it, vi } from "vitest";
import type { WSMessage } from "../../types";

const auth = vi.hoisted(() => ({
  owner: "owner",
  generation: 1,
  clearOwner: () => {},
  clearGeneration: () => {},
}));
vi.mock("../../api/client", () => ({ getAuthGeneration: () => auth.generation }));
vi.mock("../../api/authSessionEvents", () => ({
  getAuthSessionOwner: () => auth.owner,
  subscribeAuthOwnerChanges: (listener: () => void) => { auth.clearOwner = listener; },
  subscribeAuthGenerationChanges: (listener: () => void) => { auth.clearGeneration = listener; },
}));

import { dispatchDMDelivery } from "./dmDelivery";

function event(sequence = "1", id = "message", channel = "dm"): WSMessage {
  return { op: "dm_message_delete", event_id: `dm:${channel}:${sequence}`, dm_sequence: sequence, d: { dm_channel_id: channel, id } };
}
const current = () => true;

beforeEach(() => {
  auth.owner = "owner";
  auth.generation = 1;
  auth.clearOwner();
  auth.clearGeneration();
});

it("deduplicates both concurrent and later redelivery before applying it", async () => {
  let finish!: () => void;
  const apply = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const first = dispatchDMDelivery(event(), apply, current);
  const duplicate = dispatchDMDelivery(event(), apply, current);
  await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce());
  finish();
  await Promise.all([first, duplicate]);
  await dispatchDMDelivery(event(), apply, current);
  expect(apply).toHaveBeenCalledOnce();
});

it("serializes a conversation while allowing a different conversation to proceed", async () => {
  const order: string[] = [];
  let finish!: () => void;
  const first = dispatchDMDelivery(event(), () => new Promise<void>(resolve => { finish = () => { order.push("first"); resolve(); }; }), current);
  const second = dispatchDMDelivery(event("2"), async () => { order.push("second"); }, current);
  await dispatchDMDelivery(event("1", "message", "other"), async () => { order.push("other"); }, current);
  expect(order).toEqual(["other"]);
  finish();
  await Promise.all([first, second]);
  expect(order).toEqual(["other", "first", "second"]);
});

it("compares BIGINT sequences without rounding and keeps entity fences separate", async () => {
  const apply = vi.fn(async () => {});
  await dispatchDMDelivery(event("9007199254740993"), apply, current);
  await dispatchDMDelivery(event("9007199254740992"), apply, current);
  await dispatchDMDelivery(event("9007199254740994"), apply, current);
  await dispatchDMDelivery(event("1", "another-message"), apply, current);
  expect(apply).toHaveBeenCalledTimes(3);
});

it("does not let pin or reaction state hide an earlier content event", async () => {
  const apply = vi.fn(async () => {});
  await dispatchDMDelivery({ op: "dm_message_unpin", event_id: "dm:3", dm_sequence: "3", d: { dm_channel_id: "dm", message_id: "message" } }, apply, current);
  await dispatchDMDelivery({ op: "dm_reaction_update", event_id: "dm:2", dm_sequence: "2", d: { dm_channel_id: "dm", dm_message_id: "message", reactions: [] } }, apply, current);
  await dispatchDMDelivery(event(), apply, current);
  expect(apply).toHaveBeenCalledTimes(3);
});

it("retries a failed application without poisoning the conversation queue", async () => {
  const apply = vi.fn().mockRejectedValueOnce(new Error("temporary failure")).mockResolvedValue(undefined);
  await expect(dispatchDMDelivery(event(), apply, current)).rejects.toThrow("temporary failure");
  await dispatchDMDelivery(event(), apply, current);
  await dispatchDMDelivery(event(), apply, current);
  expect(apply).toHaveBeenCalledTimes(2);
});

it("fences old-session work and clears dedupe on login and account changes", async () => {
  let finish!: () => void;
  let capturedCurrent!: () => boolean;
  const first = dispatchDMDelivery(event(), guard => new Promise<void>(resolve => { capturedCurrent = guard; finish = resolve; }), current);
  await vi.waitFor(() => expect(capturedCurrent).toBeDefined());
  const queued = vi.fn(async () => {});
  const second = dispatchDMDelivery(event("2"), queued, current);
  auth.generation++;
  auth.clearGeneration();
  expect(capturedCurrent()).toBe(false);
  const apply = vi.fn(async () => {});
  await dispatchDMDelivery(event(), apply, current);
  finish();
  await Promise.all([first, second]);
  expect(queued).not.toHaveBeenCalled();
  await dispatchDMDelivery(event(), apply, current);
  expect(apply).toHaveBeenCalledOnce();
  auth.owner = "other-owner";
  auth.clearOwner();
  await dispatchDMDelivery(event(), apply, current);
  expect(apply).toHaveBeenCalledTimes(2);
});

it("does not consume an event skipped by a stale connection", async () => {
  const apply = vi.fn(async () => {});
  await dispatchDMDelivery(event(), apply, () => false);
  await dispatchDMDelivery(event(), apply, current);
  expect(apply).toHaveBeenCalledOnce();
});

it("keeps legacy frames and unrelated event domains unchanged", async () => {
  const apply = vi.fn(async () => {});
  const legacy = { ...event(), event_id: undefined, dm_sequence: undefined };
  await dispatchDMDelivery(legacy, apply, current);
  await dispatchDMDelivery(legacy, apply, current);
  const typing: WSMessage = { op: "dm_typing_start", d: { dm_channel_id: "dm", user_id: "user", username: "name" } };
  await dispatchDMDelivery(typing, apply, current);
  expect(apply).toHaveBeenCalledTimes(3);
});
