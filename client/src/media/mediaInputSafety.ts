/** Reject animation containers on the static path: one frame is not a verdict. */
export function isSupportedStaticImage(bytes: Uint8Array, mime: string): boolean {
  const type = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mime === "image/jpeg") return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === "image/bmp") return bytes.length >= 54 && bytes[0] === 66 && bytes[1] === 77;
  if (mime === "image/png") {
    if (bytes.length < 33 || !isPng(bytes)) return false;
    if (type(12) !== "IHDR" || view.getUint32(8) !== 13) return false;
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = view.getUint32(offset);
      const chunk = type(offset + 4);
      if (length > bytes.length - offset - 12 || chunk === "acTL" || chunk === "fcTL" || chunk === "fdAT") return false;
      if (chunk === "IEND") return length === 0 && offset + 12 === bytes.length;
      offset += 12 + length;
    }
    return false;
  }
  if (mime === "image/webp") {
    if (bytes.length < 20 || type(0) !== "RIFF" || type(8) !== "WEBP" || view.getUint32(4, true) !== bytes.length - 8) return false;
    let image = false, offset = 12;
    while (offset + 8 <= bytes.length) {
      const chunk = type(offset), length = view.getUint32(offset + 4, true);
      if (length > bytes.length - offset - 8 || chunk === "ANIM" || chunk === "ANMF") return false;
      if (chunk === "VP8X" && (length !== 10 || (bytes[offset + 8] & 2) !== 0)) return false;
      image ||= chunk === "VP8 " || chunk === "VP8L";
      offset += 8 + length + (length % 2);
    }
    return image && offset === bytes.length;
  }
  return false;
}

export type AnimatedRasterInfo = { frameCount: number; width: number; height: number };
export const MAX_ANIMATED_RASTER_FRAMES = 100_000;
export const MAX_MEDIA_PIXELS = 4_000_000;

/** Parse enough of the container to preflight bounds before asking a codec to allocate frames. */
export function inspectAnimatedRaster(bytes: Uint8Array, mime: string): AnimatedRasterInfo | null {
  if (mime === "image/gif") return inspectGif(bytes);
  if (mime === "image/png") return inspectApng(bytes);
  if (mime === "image/webp") return inspectAnimatedWebp(bytes);
  return null;
}

/** A deterministic, evenly spaced sample that always includes first/middle/last. */
export function sampleFrameIndexes(totalFrames: number, maxFrames = 5): number[] {
  if (!Number.isSafeInteger(totalFrames) || totalFrames < 2 || !Number.isSafeInteger(maxFrames) || maxFrames < 2) return [];
  const count = Math.min(totalFrames, maxFrames);
  const indexes = Array.from({ length: count }, (_, index) => Math.round(index * (totalFrames - 1) / (count - 1)));
  return [...new Set(indexes)];
}

function type(bytes: Uint8Array, offset: number, length = 4): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}
function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
}
function dimensionsAllowed(width: number, height: number): boolean {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0 && width * height <= MAX_MEDIA_PIXELS;
}
function inspectApng(bytes: Uint8Array): AnimatedRasterInfo | null {
  if (bytes.length < 33 || !isPng(bytes)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (type(bytes, 12) !== "IHDR" || view.getUint32(8) !== 13) return null;
  const width = view.getUint32(16), height = view.getUint32(20);
  if (!dimensionsAllowed(width, height)) return null;
  let offset = 8, declaredFrames = 0, frameControls = 0, hasAnimationControl = false, hasImageData = false, hasFrameData = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const chunk = type(bytes, offset + 4);
    if (length > bytes.length - offset - 12 || (offset === 8 && chunk !== "IHDR")) return null;
    const data = offset + 8;
    if (chunk === "acTL") {
      if (hasAnimationControl || hasImageData || length !== 8) return null;
      declaredFrames = view.getUint32(data);
      if (declaredFrames < 2 || declaredFrames > MAX_ANIMATED_RASTER_FRAMES) return null;
      hasAnimationControl = true;
    } else if (chunk === "fcTL") {
      if (!hasAnimationControl || length !== 26) return null;
      const frameWidth = view.getUint32(data + 4), frameHeight = view.getUint32(data + 8);
      const x = view.getUint32(data + 12), y = view.getUint32(data + 16);
      if (!dimensionsAllowed(frameWidth, frameHeight) || x > width - frameWidth || y > height - frameHeight) return null;
      frameControls++;
      if (frameControls > declaredFrames) return null;
    } else if (chunk === "fdAT") {
      if (!hasAnimationControl || length < 4) return null;
      hasFrameData = true;
    } else if (chunk === "IDAT") {
      hasImageData = true;
    } else if (chunk === "IEND") {
      if (length !== 0 || offset + 12 !== bytes.length) return null;
      return hasAnimationControl && hasImageData && hasFrameData && frameControls === declaredFrames
        ? { frameCount: declaredFrames, width, height }
        : null;
    }
    offset += 12 + length;
  }
  return null;
}

function inspectGif(bytes: Uint8Array): AnimatedRasterInfo | null {
  if (bytes.length < 14 || !(type(bytes, 0, 6) === "GIF87a" || type(bytes, 0, 6) === "GIF89a")) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint16(6, true), height = view.getUint16(8, true);
  if (!dimensionsAllowed(width, height)) return null;
  let offset = 13, frameCount = 0;
  const packed = bytes[10];
  if (packed & 0x80) offset += 3 * (1 << ((packed & 7) + 1));
  const skipSubBlocks = () => {
    while (offset < bytes.length) {
      const size = bytes[offset++];
      if (size === 0) return true;
      if (size > bytes.length - offset) return false;
      offset += size;
    }
    return false;
  };
  while (offset < bytes.length) {
    const marker = bytes[offset++];
    if (marker === 0x3b) return frameCount >= 2 && offset === bytes.length ? { frameCount, width, height } : null;
    if (marker === 0x21) {
      if (offset >= bytes.length) return null;
      offset++; // extension label
      if (!skipSubBlocks()) return null;
      continue;
    }
    if (marker !== 0x2c || offset + 9 > bytes.length) return null;
    const left = view.getUint16(offset, true), top = view.getUint16(offset + 2, true);
    const frameWidth = view.getUint16(offset + 4, true), frameHeight = view.getUint16(offset + 6, true);
    const imagePacked = bytes[offset + 8];
    if (!dimensionsAllowed(frameWidth, frameHeight) || left > width - frameWidth || top > height - frameHeight) return null;
    offset += 9;
    if (imagePacked & 0x80) offset += 3 * (1 << ((imagePacked & 7) + 1));
    if (offset >= bytes.length) return null;
    offset++; // LZW minimum code size
    if (!skipSubBlocks()) return null;
    if (++frameCount > MAX_ANIMATED_RASTER_FRAMES) return null;
  }
  return null;
}

function inspectAnimatedWebp(bytes: Uint8Array): AnimatedRasterInfo | null {
  if (bytes.length < 20 || type(bytes, 0) !== "RIFF" || type(bytes, 8) !== "WEBP") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) !== bytes.length - 8) return null;
  let offset = 12, width = 0, height = 0, animationFlag = false, hasAnimationHeader = false, frameCount = 0;
  while (offset + 8 <= bytes.length) {
    const chunk = type(bytes, offset), length = view.getUint32(offset + 4, true), data = offset + 8;
    if (length > bytes.length - data) return null;
    if (chunk === "VP8X") {
      if (length !== 10) return null;
      animationFlag = (bytes[data] & 2) !== 0;
      width = 1 + (bytes[data + 4] | (bytes[data + 5] << 8) | (bytes[data + 6] << 16));
      height = 1 + (bytes[data + 7] | (bytes[data + 8] << 8) | (bytes[data + 9] << 16));
      if (!dimensionsAllowed(width, height)) return null;
    } else if (chunk === "ANIM") {
      if (length !== 6 || hasAnimationHeader) return null;
      hasAnimationHeader = true;
    } else if (chunk === "ANMF") {
      if (length < 16) return null;
      const x = 2 * (bytes[data] | (bytes[data + 1] << 8) | (bytes[data + 2] << 16));
      const y = 2 * (bytes[data + 3] | (bytes[data + 4] << 8) | (bytes[data + 5] << 16));
      const frameWidth = 1 + (bytes[data + 6] | (bytes[data + 7] << 8) | (bytes[data + 8] << 16));
      const frameHeight = 1 + (bytes[data + 9] | (bytes[data + 10] << 8) | (bytes[data + 11] << 16));
      if (!dimensionsAllowed(frameWidth, frameHeight) || x > width - frameWidth || y > height - frameHeight) return null;
      if (++frameCount > MAX_ANIMATED_RASTER_FRAMES) return null;
    }
    offset += 8 + length + (length % 2);
  }
  return offset === bytes.length && animationFlag && hasAnimationHeader && frameCount >= 2
    ? { frameCount, width, height }
    : null;
}
