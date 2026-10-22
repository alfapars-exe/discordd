import { describe, it, expect } from "vitest";
import { classifyImageHead, sniffImageKind } from "./imageSniff";

function bytes(...parts: (string | number[])[]): Uint8Array<ArrayBuffer> {
  const out: number[] = [];
  for (const p of parts) {
    if (typeof p === "string") for (const ch of p) out.push(ch.charCodeAt(0));
    else out.push(...p);
  }
  return new Uint8Array(out);
}

/** RIFF....WEBPVP8X + chunk size + flags byte (offset 20) + padding. */
function webpVP8X(flags: number): Uint8Array<ArrayBuffer> {
  return bytes("RIFF", [0, 0, 0, 0], "WEBP", "VP8X", [10, 0, 0, 0], [flags], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
}

describe("classifyImageHead", () => {
  it("detects GIF87a and GIF89a", () => {
    expect(classifyImageHead(bytes("GIF89a", [1, 0, 1, 0]))).toBe("gif");
    expect(classifyImageHead(bytes("GIF87a"))).toBe("gif");
  });

  it("detects animated WebP via the VP8X animation flag", () => {
    expect(classifyImageHead(webpVP8X(0x02))).toBe("webp-animated");
    expect(classifyImageHead(webpVP8X(0x12))).toBe("webp-animated");
  });

  it("treats still VP8X / VP8 WebP, PNG, JPEG and short input as other", () => {
    expect(classifyImageHead(webpVP8X(0x10))).toBe("other");
    expect(classifyImageHead(bytes("RIFF", [0, 0, 0, 0], "WEBP", "VP8 ", [0, 0, 0, 0, 0x02]))).toBe("other");
    expect(classifyImageHead(bytes([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a]))).toBe("other");
    expect(classifyImageHead(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe("other");
    expect(classifyImageHead(bytes("GIF"))).toBe("other");
    expect(classifyImageHead(new Uint8Array())).toBe("other");
  });
});

describe("sniffImageKind", () => {
  it("reads the head of a File regardless of its declared type", async () => {
    const gif = new File([bytes("GIF89a", [0, 0, 0, 0])], "a.png", { type: "image/png" });
    expect(await sniffImageKind(gif)).toBe("gif");

    const webp = new File([webpVP8X(0x02)], "a.webp", { type: "image/webp" });
    expect(await sniffImageKind(webp)).toBe("webp-animated");

    const still = new File([webpVP8X(0x00)], "b.webp", { type: "image/webp" });
    expect(await sniffImageKind(still)).toBe("other");
  });
});
