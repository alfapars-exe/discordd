import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logToServer = vi.hoisted(() => vi.fn());
vi.mock("../api/clientLog", () => ({ logToServer }));

import {
  VOICE_JOIN_MICROPHONE_GRACE_MS,
  abandonVoiceJoinTiming,
  beginVoiceJoinTiming,
  markVoiceJoinConnected,
  markVoiceJoinMicrophone,
  markVoiceJoinReady,
  markVoiceJoinToken,
  resetVoiceJoinTiming,
  settleVoiceJoinRequest,
} from "./voiceJoinTiming";

let clock = 0;
/** Moves both the monotonic clock and the fake timers forward. */
function pass(ms: number): void {
  clock += ms;
  vi.advanceTimersByTime(ms);
}
const reports = () => logToServer.mock.calls.map(call => call[2] as Record<string, unknown>);

beforeEach(() => {
  vi.useFakeTimers();
  clock = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  logToServer.mockReset();
  resetVoiceJoinTiming();
});

afterEach(() => {
  resetVoiceJoinTiming();
  expect(vi.getTimerCount()).toBe(0);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("voice join timing", () => {
  it("reports one line with every stage once the microphone is published", () => {
    beginVoiceJoinTiming(7, "join");
    pass(800); markVoiceJoinToken(7, "fetched");
    pass(1200); markVoiceJoinConnected(7);
    pass(400); markVoiceJoinReady(7);
    expect(logToServer).not.toHaveBeenCalled();
    pass(300); markVoiceJoinMicrophone(7);

    expect(logToServer).toHaveBeenCalledExactlyOnceWith("info", "voice_join_timing", {
      kind: "join", outcome: "ready", stage: "microphone", credentials: "fetched",
      token_ms: 800, connected_ms: 2000, ready_ms: 2400, microphone_ms: 2700, elapsed_ms: undefined,
    });
    expect(vi.getTimerCount()).toBe(0);

    // Nothing after the report reopens or repeats it.
    markVoiceJoinReady(7); markVoiceJoinMicrophone(7); settleVoiceJoinRequest(7); abandonVoiceJoinTiming(7);
    pass(VOICE_JOIN_MICROPHONE_GRACE_MS * 2);
    expect(logToServer).toHaveBeenCalledOnce();
  });

  it("reports a muted join without a microphone figure after the grace period", () => {
    beginVoiceJoinTiming(1, "join");
    pass(100); markVoiceJoinToken(1, "fetched");
    pass(100); markVoiceJoinConnected(1);
    pass(100); markVoiceJoinReady(1);
    pass(VOICE_JOIN_MICROPHONE_GRACE_MS - 1);
    expect(logToServer).not.toHaveBeenCalled();
    pass(1);
    expect(reports()).toEqual([expect.objectContaining({ outcome: "ready", stage: "ready", ready_ms: 300, microphone_ms: undefined })]);
    markVoiceJoinMicrophone(1);
    expect(logToServer).toHaveBeenCalledOnce();
  });

  it("reports at ready when the microphone mark came first", () => {
    beginVoiceJoinTiming(1, "rejoin");
    pass(50); markVoiceJoinToken(1, "fetched");
    pass(50); markVoiceJoinConnected(1);
    pass(50); markVoiceJoinMicrophone(1);
    expect(logToServer).not.toHaveBeenCalled();
    pass(50); markVoiceJoinReady(1);
    expect(reports()).toEqual([expect.objectContaining({ kind: "rejoin", stage: "microphone", microphone_ms: 150, ready_ms: 200 })]);
  });

  it("records whether a move used embedded credentials", () => {
    beginVoiceJoinTiming(3, "move");
    markVoiceJoinToken(3, "embedded");
    markVoiceJoinToken(3, "fetched"); // a second mark never rewrites the first
    pass(10); markVoiceJoinMicrophone(3); markVoiceJoinReady(3);
    expect(reports()).toEqual([expect.objectContaining({ kind: "move", credentials: "embedded", token_ms: 0 })]);
  });

  it("reports a join that never got credentials as abandoned, once", () => {
    beginVoiceJoinTiming(4, "join");
    pass(500);
    settleVoiceJoinRequest(4);
    expect(logToServer).toHaveBeenCalledExactlyOnceWith("info", "voice_join_timing", {
      kind: "join", outcome: "abandoned", stage: "start", credentials: undefined,
      token_ms: undefined, connected_ms: undefined, ready_ms: undefined, microphone_ms: undefined, elapsed_ms: 500,
    });
    settleVoiceJoinRequest(4); abandonVoiceJoinTiming(4);
    expect(logToServer).toHaveBeenCalledOnce();
  });

  it("keeps a committed attempt open when its request settles, and reports where a leave stopped it", () => {
    beginVoiceJoinTiming(5, "switch");
    pass(200); markVoiceJoinToken(5, "fetched");
    settleVoiceJoinRequest(5);
    expect(logToServer).not.toHaveBeenCalled();
    pass(300); markVoiceJoinConnected(5);
    pass(100); abandonVoiceJoinTiming(5);
    expect(reports()).toEqual([expect.objectContaining({
      kind: "switch", outcome: "abandoned", stage: "connected", token_ms: 200, connected_ms: 500, elapsed_ms: 600,
    })]);
  });

  it("drops a superseded attempt and ignores its late marks", () => {
    beginVoiceJoinTiming(1, "join");
    pass(100); markVoiceJoinToken(1, "fetched");
    beginVoiceJoinTiming(2, "switch");
    expect(logToServer).not.toHaveBeenCalled();

    // The old request, room and session finish later.
    markVoiceJoinConnected(1); markVoiceJoinReady(1); markVoiceJoinMicrophone(1);
    settleVoiceJoinRequest(1); abandonVoiceJoinTiming(1);
    expect(logToServer).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    pass(40); markVoiceJoinToken(2, "fetched");
    pass(60); markVoiceJoinConnected(2);
    pass(10); markVoiceJoinMicrophone(2); markVoiceJoinReady(2);
    expect(reports()).toEqual([expect.objectContaining({ kind: "switch", outcome: "ready", token_ms: 40, connected_ms: 100, ready_ms: 110 })]);
  });

  it("still reports an attempt that was ready when it is superseded or its session ends", () => {
    beginVoiceJoinTiming(1, "join");
    markVoiceJoinToken(1, "fetched"); markVoiceJoinConnected(1);
    pass(100); markVoiceJoinReady(1);
    beginVoiceJoinTiming(2, "switch");
    expect(reports()).toEqual([expect.objectContaining({ kind: "join", outcome: "ready", stage: "ready", ready_ms: 100 })]);
    expect(vi.getTimerCount()).toBe(0);

    markVoiceJoinToken(2, "fetched"); markVoiceJoinConnected(2);
    pass(100); markVoiceJoinReady(2);
    abandonVoiceJoinTiming(2);
    expect(reports()[1]).toEqual(expect.objectContaining({ kind: "switch", outcome: "ready", stage: "ready", elapsed_ms: undefined }));
    expect(logToServer).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores marks for a generation that is not the open attempt", () => {
    markVoiceJoinToken(9, "fetched"); markVoiceJoinReady(9); abandonVoiceJoinTiming(9);
    beginVoiceJoinTiming(3, "join");
    markVoiceJoinToken(2, "fetched"); markVoiceJoinConnected(4); markVoiceJoinReady(2); markVoiceJoinMicrophone(4);
    settleVoiceJoinRequest(2); abandonVoiceJoinTiming(4);
    expect(logToServer).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    pass(70); abandonVoiceJoinTiming(3);
    expect(reports()).toEqual([expect.objectContaining({ outcome: "abandoned", stage: "start", elapsed_ms: 70 })]);
  });

  it("sends only the kind, stage labels and millisecond figures", () => {
    beginVoiceJoinTiming(11, "move");
    pass(5); markVoiceJoinToken(11, "embedded");
    pass(5); markVoiceJoinConnected(11);
    pass(5); markVoiceJoinReady(11);
    pass(5); markVoiceJoinMicrophone(11);
    beginVoiceJoinTiming(12, "join");
    pass(5); settleVoiceJoinRequest(12);

    expect(reports()).toHaveLength(2);
    const labels = new Set(["join", "switch", "move", "rejoin", "ready", "abandoned", "start", "token", "connected", "microphone", "embedded", "fetched"]);
    for (const report of reports()) {
      expect(Object.keys(report).sort()).toEqual(
        ["connected_ms", "credentials", "elapsed_ms", "kind", "microphone_ms", "outcome", "ready_ms", "stage", "token_ms"]);
      for (const [key, value] of Object.entries(report)) {
        if (value === undefined) continue;
        if (key.endsWith("_ms")) expect(Number.isInteger(value)).toBe(true);
        else expect(labels.has(value as string)).toBe(true);
      }
      // The join generation identifies nothing, but it is not a timing either.
      expect(Object.values(report)).not.toContain(11);
      expect(Object.values(report)).not.toContain(12);
    }
  });

  it("forgets the open attempt and its timer on reset", () => {
    beginVoiceJoinTiming(1, "join");
    markVoiceJoinReady(1);
    expect(vi.getTimerCount()).toBe(1);
    resetVoiceJoinTiming();
    expect(vi.getTimerCount()).toBe(0);
    pass(VOICE_JOIN_MICROPHONE_GRACE_MS);
    abandonVoiceJoinTiming(1);
    expect(logToServer).not.toHaveBeenCalled();
  });
});
