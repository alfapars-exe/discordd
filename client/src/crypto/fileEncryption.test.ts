/**
 * fileEncryption tests — E2EE file encrypt/decrypt.
 *
 * Real crypto path: AES-256-GCM via WebCrypto, SHA-256 digest, real base64.
 * Only the network layer is mocked — decryptFile downloads the ciphertext via
 * global fetch, which we stub with a Response carrying the bytes encryptFile
 * produced. encryptFile itself touches no network and no storage.
 *
 * Out of scope here (jsdom limitation): encryptThumbnail requires
 * createImageBitmap + OffscreenCanvas, neither of which jsdom provides.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { encryptFile, decryptFile } from "./fileEncryption";
// Real base64 encoder — the same one encryptFile uses to serialize the key.
import { toBase64 } from "./signalProtocol";

const DOWNLOAD_URL = "https://cdn.example.test/encrypted-blob";

/**
 * Stub global fetch to return a fresh Response per call. Building a new
 * Response each time avoids the "body already consumed" trap if a test issues
 * more than one download.
 */
function stubFetch(body: BodyInit | null, init?: ResponseInit): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, init))
  );
}

/** SHA-256 of the given bytes as lowercase hex — mirrors fileEncryption's digest. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("fileEncryption — file encrypt/decrypt round-trip and guards", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("round-trips a file: bytes, filename, mimeType, and digest are preserved", async () => {
    const plaintext = crypto.getRandomValues(new Uint8Array(2048));
    const file = new File([plaintext], "secret.bin", {
      type: "application/pdf",
    });

    const { encryptedBlob, meta } = await encryptFile(file);

    // meta.digest is the SHA-256 hex of the PLAINTEXT (integrity anchor).
    expect(meta.digest).toBe(await sha256Hex(plaintext));
    expect(meta.filename).toBe("secret.bin");
    expect(meta.mimeType).toBe("application/pdf");
    expect(meta.originalSize).toBe(plaintext.byteLength);

    stubFetch(await encryptedBlob.arrayBuffer());

    const decrypted = await decryptFile(DOWNLOAD_URL, meta);
    expect(decrypted.name).toBe("secret.bin");
    expect(decrypted.type).toBe("application/pdf");
    const out = new Uint8Array(await decrypted.arrayBuffer());
    expect(out).toEqual(plaintext);
  });

  it("rejects when metadata carries the wrong digest (integrity check)", async () => {
    const plaintext = new TextEncoder().encode("integrity matters");
    const file = new File([plaintext], "note.txt", { type: "text/plain" });
    const { encryptedBlob, meta } = await encryptFile(file);

    // Decryption itself succeeds (key/iv are correct); only the post-decrypt
    // digest comparison fails.
    const badMeta = { ...meta, digest: "00".repeat(32) };
    stubFetch(await encryptedBlob.arrayBuffer());

    await expect(decryptFile(DOWNLOAD_URL, badMeta)).rejects.toThrow(
      /integrity check failed/i
    );
  });

  it("rejects tampered ciphertext (AES-GCM authentication fails)", async () => {
    const plaintext = new TextEncoder().encode("do not tamper with me");
    const file = new File([plaintext], "note.txt", { type: "text/plain" });
    const { encryptedBlob, meta } = await encryptFile(file);

    const enc = new Uint8Array(await encryptedBlob.arrayBuffer());
    enc[0] = enc[0] ^ 0xff; // flip a ciphertext byte
    stubFetch(enc);

    await expect(decryptFile(DOWNLOAD_URL, meta)).rejects.toThrow();
  });

  it("rejects when the key in metadata is swapped for a different 32-byte key", async () => {
    const plaintext = new TextEncoder().encode("wrong key must fail");
    const file = new File([plaintext], "note.txt", { type: "text/plain" });
    const { encryptedBlob, meta } = await encryptFile(file);

    const badMeta = {
      ...meta,
      key: toBase64(crypto.getRandomValues(new Uint8Array(32))),
    };
    stubFetch(await encryptedBlob.arrayBuffer());

    await expect(decryptFile(DOWNLOAD_URL, badMeta)).rejects.toThrow();
  });

  it("refuses to encrypt an oversized file without allocating it", async () => {
    // Tiny real backing buffer; only the reported size is inflated past the
    // 64MB single-shot limit, so nothing large is ever allocated.
    const file = new File([new Uint8Array(8)], "huge.bin", {
      type: "application/octet-stream",
    });
    Object.defineProperty(file, "size", { value: 64 * 1024 * 1024 + 1 });
    expect(file.size).toBe(64 * 1024 * 1024 + 1);

    await expect(encryptFile(file)).rejects.toThrow(/too large/i);
  });

  it("throws a descriptive error when the download fails", async () => {
    const plaintext = new TextEncoder().encode("x");
    const file = new File([plaintext], "note.txt", { type: "text/plain" });
    const { meta } = await encryptFile(file);

    stubFetch(null, { status: 404 });

    await expect(decryptFile(DOWNLOAD_URL, meta)).rejects.toThrow(
      /Failed to download encrypted file: HTTP 404/
    );
  });

  it("produces distinct key, iv, and ciphertext on each encryption of the same file", async () => {
    const plaintext = new TextEncoder().encode("identical input bytes");
    const a = await encryptFile(
      new File([plaintext], "note.txt", { type: "text/plain" })
    );
    const b = await encryptFile(
      new File([plaintext], "note.txt", { type: "text/plain" })
    );

    expect(a.meta.key).not.toBe(b.meta.key);
    expect(a.meta.iv).not.toBe(b.meta.iv);

    const ca = new Uint8Array(await a.encryptedBlob.arrayBuffer());
    const cb = new Uint8Array(await b.encryptedBlob.arrayBuffer());
    expect(ca).not.toEqual(cb);

    // Same plaintext still yields the same content digest.
    expect(a.meta.digest).toBe(b.meta.digest);
  });
});
