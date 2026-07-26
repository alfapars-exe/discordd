import { describe, it, expect } from "vitest";
import { validateFiles, mimeTypeFromExtension } from "./fileValidation";
import { MAX_FILE_SIZE } from "./constants";

function makeFile(name: string, type: string, sizeBytes: number): File {
  const blob = new Blob([new Uint8Array(sizeBytes)], { type });
  return new File([blob], name, { type });
}

describe("mimeTypeFromExtension", () => {
  it.each([
    ["photo.png", "image/png"],
    ["PHOTO.PNG", "image/png"],
    ["a.jpg", "image/jpeg"],
    ["a.jpeg", "image/jpeg"],
    ["a.gif", "image/gif"],
    ["a.webp", "image/webp"],
    ["a.bmp", "image/bmp"],
    ["a.avif", "image/avif"],
    ["clip.mp4", "video/mp4"],
    ["notes.txt", "text/plain"],
  ])("infers %s → %s", (name, expected) => {
    expect(mimeTypeFromExtension(name)).toBe(expected);
  });

  it("returns null when no extension", () => {
    expect(mimeTypeFromExtension("README")).toBeNull();
  });

  it("returns null for unknown extension", () => {
    expect(mimeTypeFromExtension("script.exe")).toBeNull();
  });

  it("never classifies svg as an inline image (script-capable format)", () => {
    expect(mimeTypeFromExtension("pic.svg")).toBeNull();
  });
});

describe("validateFiles", () => {
  it("accepts every file type — size is the only gate", () => {
    const png = makeFile("a.png", "image/png", 1024);
    const exe = makeFile("script.exe", "application/x-msdownload", 100);
    const unknown = makeFile("blob", "", 100);
    const { valid, rejected } = validateFiles([png, exe, unknown]);
    expect(valid).toEqual([png, exe, unknown]);
    expect(rejected).toEqual([]);
  });

  it("rejects oversized files with reason=too_large", () => {
    const oversized = makeFile("big.png", "image/png", MAX_FILE_SIZE + 1);
    const { valid, rejected } = validateFiles([oversized]);
    expect(valid).toEqual([]);
    expect(rejected).toEqual([{ file: oversized, reason: "too_large" }]);
  });

  it("partitions a mixed batch: only the oversized file is rejected", () => {
    const good = makeFile("a.png", "image/png", 1024);
    const oversized = makeFile("big.png", "image/png", MAX_FILE_SIZE + 1);
    const exe = makeFile("script.exe", "application/x-msdownload", 100);
    const { valid, rejected } = validateFiles([good, oversized, exe]);
    expect(valid).toEqual([good, exe]);
    expect(rejected).toEqual([{ file: oversized, reason: "too_large" }]);
  });

  it("accepts FileList and array uniformly", () => {
    const f = makeFile("a.png", "image/png", 1024);
    const list = [f];
    const { valid: v1 } = validateFiles(list);
    const { valid: v2 } = validateFiles(list as unknown as FileList);
    expect(v1).toEqual(v2);
  });
});
