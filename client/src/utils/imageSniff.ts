/**
 * imageSniff — classify an image File by its leading bytes.
 *
 * UX only (K-021): the server's decoder is the single security gate. This
 * lets the upload UI pick the right path (skip the canvas crop for GIFs so
 * the animation survives; warn about animated WebP before the server 400s)
 * without trusting the browser-declared `file.type`.
 */

export type ImageKind = "gif" | "webp-animated" | "other";

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

/** Pure byte classifier — exported for tests. */
export function classifyImageHead(bytes: Uint8Array): ImageKind {
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === "GIF8") return "gif";
  // RIFF <size:4> WEBP VP8X <chunkSize:4> <flags:1> — the animation flag is
  // bit 1 (0x02) of the VP8X flags byte at offset 20.
  if (
    bytes.length >= 21 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 12) === "WEBP" &&
    ascii(bytes, 12, 16) === "VP8X" &&
    (bytes[20] & 0x02) !== 0
  ) {
    return "webp-animated";
  }
  return "other";
}

/** Reads the first 32 bytes of `file`; read failures classify as "other". */
export async function sniffImageKind(file: Blob): Promise<ImageKind> {
  try {
    const buf = await file.slice(0, 32).arrayBuffer();
    return classifyImageHead(new Uint8Array(buf));
  } catch {
    return "other";
  }
}
