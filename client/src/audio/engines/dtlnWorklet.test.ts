/// <reference types="node" />
// @vitest-environment node
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

interface FrameMessage { type: string; session: string; sequence?: number; buffer?: ArrayBuffer; message?: string }
interface Bridge {
  port: { onmessage: (event: { data: unknown }) => void };
  process: (input: Float32Array[][], output: Float32Array[][]) => boolean;
}
function harness() {
  let Constructor: new (options: unknown) => Bridge;
  const errors: FrameMessage[] = [];
  const frames: FrameMessage[] = [];
  const workerPort = { onmessage: (_event: { data: FrameMessage }) => {}, start() {}, close() {},
    postMessage(message: FrameMessage) { frames.push(message); } };
  runInNewContext(readFileSync(new URL("./dtlnWorklet.js", import.meta.url), "utf8"), {
    AudioWorkletProcessor: class { port = { onmessage: undefined, postMessage: (message: FrameMessage) => errors.push(message) }; },
    Float32Array, registerProcessor: (_name: string, value: typeof Constructor) => { Constructor = value; },
  });
  const bridge = new Constructor!({ processorOptions: { session: "test" } });
  bridge.port.onmessage({ data: { type: "connect", session: "test", port: workerPort } });
  const process = (count = 128) => {
    const out = new Float32Array(count);
    const alive = bridge.process([[new Float32Array(count).fill(0.2)]], [[out]]);
    return { out, alive };
  };
  const reply = (sequence: number, session = "test", value = 0.25) => workerPort.onmessage({ data: {
    type: "frame", session, sequence, buffer: new Float32Array(128).fill(value).buffer,
  } });
  return { bridge, frames, errors, process, reply };
}

describe("DTLN worklet transport", () => {
  it("prefills then streams ordered model output, not raw microphone samples", () => {
    const h = harness();
    for (let n = 0; n < 3; n++) {
      expect(h.process().out.every((v) => v === 0)).toBe(true);
      h.reply(n);
    }
    expect(h.process().out.every((v) => v === 0.25)).toBe(true);
    expect(h.frames.map((frame) => frame.sequence)).toEqual([0, 1, 2, 3]);
    expect(h.errors).toEqual([]);
  });
  it("ignores old sessions and rejects out-of-order model output", () => {
    const h = harness();
    h.process();
    h.reply(100, "obsolete");
    expect(h.errors).toEqual([]);
    h.reply(1);
    expect(h.errors[0].message).toMatch(/sequence/);
    expect(h.process().alive).toBe(false);
  });
  it("bounds a stalled worker at eight pending hops instead of growing latency", () => {
    const h = harness();
    for (let n = 0; n < 8; n++) expect(h.process().alive).toBe(true);
    expect(h.process().alive).toBe(false);
    expect(h.frames).toHaveLength(8);
    expect(h.errors[0].message).toMatch(/64 ms backlog/);
  });
  it("assembles 128-sample hops even when render quantum is shorter", () => {
    const h = harness();
    h.process(64);
    expect(h.frames).toHaveLength(0);
    h.process(64);
    expect(new Float32Array(h.frames[0].buffer!)).toHaveLength(128);
  });
  it("rejects nonfinite model output and stops after disposal", () => {
    const h = harness();
    h.process();
    h.reply(0, "test", NaN);
    expect(h.errors[0].message).toMatch(/invalid output/);
    const other = harness();
    other.bridge.port.onmessage({ data: { type: "dispose" } });
    expect(other.process().alive).toBe(false);
    expect(other.frames).toHaveLength(0);
  });
});
