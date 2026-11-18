import { expect, it } from "vitest";
import { initialUpdateCheckerState, updateCheckerState, type UpdateCheckerEvent, type UpdateCheckerState } from "./updateCheckerState";

function run(...events: UpdateCheckerEvent[]): UpdateCheckerState {
  return events.reduce(updateCheckerState, initialUpdateCheckerState);
}

it("moves a failed incomplete download back to idle and accepts a complete retry", () => {
  const failed = run({ type: "available", version: "2.0.0" }, { type: "progress", percent: 42.6 }, { type: "error" });
  expect(failed).toMatchObject({ status: "idle", update: null, progress: 0, downloaded: null });
  const retry = [{ type: "available", version: "2.0.0" }, { type: "downloaded", version: "2.0.0" }] satisfies UpdateCheckerEvent[];
  expect(retry.reduce(updateCheckerState, failed)).toMatchObject({ status: "ready", update: { version: "2.0.0" }, progress: 100 });
});

it.each([false, true])("does not alter a completed version on duplicate or check events (snoozed=%s)", snoozed => {
  let state = run({ type: "downloaded", version: "2.0.0" });
  if (snoozed) state = updateCheckerState(state, { type: "dismiss" });
  for (const event of [
    { type: "available", version: "2.0.0" }, { type: "downloaded", version: "2.0.0" },
    { type: "progress", percent: 12 }, { type: "error" },
  ] satisfies UpdateCheckerEvent[]) expect(updateCheckerState(state, event)).toBe(state);
});

it("an obsolete snooze cannot resurrect an installer after another version becomes available", () => {
  const snoozed = run({ type: "downloaded", version: "2.0.0" }, { type: "dismiss" });
  const newer = updateCheckerState(snoozed, { type: "available", version: "3.0.0" });
  expect(newer).toMatchObject({ status: "downloading", update: { version: "3.0.0" }, downloaded: null, snoozeToken: null });
  expect(updateCheckerState(newer, { type: "resume", token: snoozed.snoozeToken! })).toBe(newer);
});

it("only the latest dismiss timer can restore a ready installer", () => {
  const first = run({ type: "downloaded", version: "2.0.0" }, { type: "dismiss" });
  const second = updateCheckerState(first, { type: "dismiss" });
  expect(updateCheckerState(second, { type: "resume", token: first.snoozeToken! })).toBe(second);
  expect(updateCheckerState(second, { type: "resume", token: second.snoozeToken! })).toMatchObject({ status: "ready", update: { version: "2.0.0" }, progress: 100, snoozeToken: null });
});

it("a snooze without a downloaded installer cannot manufacture a ready state", () => {
  const state = run({ type: "dismiss" });
  expect(updateCheckerState(state, { type: "resume", token: state.snoozeToken! })).toMatchObject({ status: "idle", update: null, downloaded: null, snoozeToken: null });
});

it("a newly completed version replaces the old snooze and ignores its queued resume", () => {
  const snoozed = run({ type: "downloaded", version: "2.0.0" }, { type: "dismiss" });
  const ready = updateCheckerState(snoozed, { type: "downloaded", version: "3.0.0" });
  expect(ready).toMatchObject({ status: "ready", update: { version: "3.0.0" }, progress: 100, snoozeToken: null });
  expect(updateCheckerState(ready, { type: "resume", token: snoozed.snoozeToken! })).toBe(ready);
});

it("rounds in-flight progress while preserving download ownership", () => {
  expect(run({ type: "available", version: "2.0.0" }, { type: "progress", percent: 42.6 })).toMatchObject({ status: "downloading", update: { version: "2.0.0" }, progress: 43 });
});
