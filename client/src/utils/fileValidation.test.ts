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
});

describe("validateFiles", () => {
  it("accepts allowed types with valid mime", () => {
    const f = makeFile("a.png", "image/png", 1024);
    const { valid, rejected } = validateFiles([f]);
    expect(valid).toEqual([f]);
    expect(rejected).toEqual([]);
  });

  it("infers mime from extension when file.type is empty", () => {
    const f = makeFile("a.png", "", 1024);
    const { valid, rejected } = validateFiles([f]);
    expect(valid).toEqual([f]);
    expect(rejected).toEqual([]);
  });

  it("rejects oversized files with reason=too_large", () => {
    const oversized = makeFile("big.png", "image/png", MAX_FILE_SIZE + 1);
    const { valid, rejected } = validateFiles([oversized]);
    expect(valid).toEqual([]);
    expect(rejected).toEqual([{ file: oversized, reason: "too_large" }]);
  });

  it("rejects disallowed types with reason=type_not_allowed", () => {
    const evil = makeFile("script.exe", "application/x-msdownload", 100);
    const { valid, rejected } = validateFiles([evil]);
    expect(valid).toEqual([]);
    expect(rejected).toEqual([{ file: evil, reason: "type_not_allowed" }]);
  });

  it("rejects when file.type is empty AND extension is unknown", () => {
    const f = makeFile("blob", "", 100);
    const { valid, rejected } = validateFiles([f]);
    expect(valid).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBe("type_not_allowed");
  });

  it("partitions a mixed batch correctly", () => {
    const good = makeFile("a.png", "image/png", 1024);
    const oversized = makeFile("big.png", "image/png", MAX_FILE_SIZE + 1);
    const forbidden = makeFile("script.exe", "application/x-msdownload", 100);
    const { valid, rejected } = validateFiles([good, oversized, forbidden]);
    expect(valid).toEqual([good]);
    expect(rejected).toHaveLength(2);
    expect(rejected.map((r) => r.reason)).toEqual(["too_large", "type_not_allowed"]);
  });

  it("accepts FileList and array uniformly", () => {
    const f = makeFile("a.png", "image/png", 1024);
    const list = [f];
    const { valid: v1 } = validateFiles(list);
    const { valid: v2 } = validateFiles(list as unknown as FileList);
    expect(v1).toEqual(v2);
  });
});
