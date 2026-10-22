import { describe, it, expect } from "vitest";
import { audioBufferToWav, ENTRANCE_SAMPLE_RATE, type PcmSource } from "./wavEncode";

function fakeBuffer(samples: number[][], sampleRate: number): PcmSource {
  return {
    numberOfChannels: samples.length,
    sampleRate,
    length: samples[0].length,
    getChannelData: (ch: number) => Float32Array.from(samples[ch]),
  };
}

async function bytes(blob: Blob): Promise<DataView> {
  return new DataView(await blob.arrayBuffer());
}

function ascii(view: DataView, offset: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

describe("audioBufferToWav", () => {
  it("writes a canonical mono 24 kHz 16-bit PCM header", async () => {
    const frames = 480; // 20 ms
    const blob = audioBufferToWav(fakeBuffer([new Array(frames).fill(0)], ENTRANCE_SAMPLE_RATE));
    expect(blob.type).toBe("audio/wav");
    const v = await bytes(blob);
    expect(v.byteLength).toBe(44 + frames * 2);
    expect(ascii(v, 0, 4)).toBe("RIFF");
    expect(v.getUint32(4, true)).toBe(36 + frames * 2);
    expect(ascii(v, 8, 4)).toBe("WAVE");
    expect(ascii(v, 12, 4)).toBe("fmt ");
    expect(v.getUint32(16, true)).toBe(16);
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(24, true)).toBe(24000);
    expect(v.getUint32(28, true)).toBe(48000); // byteRate
    expect(v.getUint16(32, true)).toBe(2); // blockAlign
    expect(v.getUint16(34, true)).toBe(16);
    expect(ascii(v, 36, 4)).toBe("data");
    expect(v.getUint32(40, true)).toBe(frames * 2);
  });

  it("clips and quantizes samples, interleaving stereo", async () => {
    const blob = audioBufferToWav(fakeBuffer([[1, -1, 2], [0, 0.5, -2]], 48000));
    const v = await bytes(blob);
    expect(v.getUint16(22, true)).toBe(2);
    expect(v.getUint16(32, true)).toBe(4);
    expect(v.getUint32(28, true)).toBe(48000 * 4);
    expect(v.getInt16(44, true)).toBe(0x7fff); // L0 = 1
    expect(v.getInt16(46, true)).toBe(0); // R0
    expect(v.getInt16(48, true)).toBe(-0x8000); // L1 = -1
    expect(v.getInt16(50, true)).toBe(Math.trunc(0.5 * 0x7fff)); // R1
    expect(v.getInt16(52, true)).toBe(0x7fff); // L2 = 2 → clipped
    expect(v.getInt16(54, true)).toBe(-0x8000); // R2 = -2 → clipped
  });
});
