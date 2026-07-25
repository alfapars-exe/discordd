/**
 * e2eePayload tests — pure encode/decode of the E2EE plaintext payload.
 *
 * The plaintext that travels through the Sender-Key / Signal ciphertext is not
 * a bare string: it is a JSON envelope carrying the message text plus optional
 * per-file keys. This module owns that envelope.
 *
 * Two protocol invariants are pinned here, and both are load-bearing for
 * backward compatibility (see the prime directive on ciphertext compat):
 *
 *   1. Encoding is ALWAYS structured JSON ({"content": ...}), even with no
 *      files. This wrapping is what disambiguates a user who literally types
 *      `{"content":"x"}` from a real structured payload — decode of the
 *      wrapper returns the user's exact text, never a mis-parse.
 *
 *   2. Decoding is duck-typed and permissive: anything that is not a JSON
 *      object with a STRING `content` field is treated as raw legacy plaintext
 *      (older E2EE messages predate the envelope). This is the only reason
 *      pre-envelope ciphertext stays readable, so these fallbacks are
 *      compatibility guarantees, not conveniences.
 *
 * No mocks — this is straight-line data, exercised with real crypto nowhere in
 * sight.
 */

import { describe, it, expect } from "vitest";
import { encodePayload, decodePayload } from "./e2eePayload";
import type { EncryptedFileMeta } from "./fileEncryption";

/** A representative file-key entry — shape must survive a JSON round-trip. */
function sampleMeta(name = "photo.png"): EncryptedFileMeta {
  return {
    key: "a2V5LWJhc2U2NA==",
    iv: "aXYtYmFzZTY0",
    filename: name,
    mimeType: "image/png",
    originalSize: 2048,
    digest: "deadbeefcafef00d",
  };
}

describe("e2eePayload — encode", () => {
  it("content-only encodes to {\"content\": ...} with no file_keys key", () => {
    const obj = JSON.parse(encodePayload("hello")) as Record<string, unknown>;
    expect(obj).toEqual({ content: "hello" });
    // The absence of the key (not merely an undefined value) keeps the wire
    // form minimal and matches what the very first envelope version emitted.
    expect(Object.prototype.hasOwnProperty.call(obj, "file_keys")).toBe(false);
  });

  it("content + file keys encodes a file_keys array", () => {
    const meta = sampleMeta();
    const obj = JSON.parse(encodePayload("with file", [meta])) as {
      content: string;
      file_keys?: EncryptedFileMeta[];
    };
    expect(obj.content).toBe("with file");
    expect(obj.file_keys).toEqual([meta]);
  });

  it("omits file_keys when the array is empty (length > 0 guard)", () => {
    const obj = JSON.parse(encodePayload("no files", [])) as Record<
      string,
      unknown
    >;
    expect(Object.prototype.hasOwnProperty.call(obj, "file_keys")).toBe(false);
  });
});

describe("e2eePayload — decode round-trips", () => {
  it("round-trips content + file keys through encode → decode", () => {
    const meta = sampleMeta();
    const decoded = decodePayload(encodePayload("caption", [meta]));
    expect(decoded).toEqual({ content: "caption", file_keys: [meta] });
  });

  it("preserves unicode and emoji across a round-trip", () => {
    const text = "héllo 世界 😀🎉 — ñ";
    const decoded = decodePayload(encodePayload(text));
    expect(decoded.content).toBe(text);
  });

  it("wraps a message that is itself literally {\"content\":\"x\"}", () => {
    // Without the encode wrapper, this exact user text would be mis-decoded as
    // a structured payload yielding "x". Wrapping is the disambiguation.
    const userText = '{"content":"x"}';
    const decoded = decodePayload(encodePayload(userText));
    expect(decoded.content).toBe(userText);
  });
});

describe("e2eePayload — decode backward-compatibility fallbacks", () => {
  it("treats a non-JSON string as legacy plaintext", () => {
    expect(decodePayload("just a plain message")).toEqual({
      content: "just a plain message",
    });
  });

  it("treats valid JSON without a content field as raw plaintext", () => {
    const raw = '{"foo":1}';
    expect(decodePayload(raw)).toEqual({ content: raw });
  });

  it("falls back to raw plaintext when content is not a string", () => {
    const raw = '{"content":123}';
    expect(decodePayload(raw)).toEqual({ content: raw });
  });

  it("drops file_keys that are not an array (Array.isArray guard)", () => {
    const raw = '{"content":"x","file_keys":"nope"}';
    const decoded = decodePayload(raw);
    expect(decoded.content).toBe("x");
    expect(decoded.file_keys).toBeUndefined();
  });

  it("treats the JSON literal null as the plaintext string \"null\"", () => {
    // JSON.parse("null") === null; the `parsed !== null` guard sends this down
    // the legacy path rather than throwing on a property access.
    expect(decodePayload("null")).toEqual({ content: "null" });
  });

  it("treats a JSON array string as raw plaintext (object but no string content)", () => {
    const raw = "[1,2]";
    expect(decodePayload(raw)).toEqual({ content: raw });
  });
});
