/**
 * File Encryption — E2EE file encrypt/decrypt.
 *
 * Each file gets a random AES-256-GCM key. Encrypted file is uploaded
 * to server, key is included in the E2EE message payload (server never sees it).
 *
 * Image thumbnails are encrypted with the same key but different IV,
 * allowing preview without downloading the full file.
 */

import { toBase64 } from "./signalProtocol";

// ──────────────────────────────────
// Types
// ──────────────────────────────────

/** Encrypted file metadata, included in the E2EE message payload. */
export type EncryptedFileMeta = {
  /** AES-256-GCM key (base64, 32 bytes) */
  key: string;
  /** Initialization vector (base64, 12 bytes) */
  iv: string;
  /** Original filename */
  filename: string;
  /** Original MIME type */
  mimeType: string;
  /** Original file size (bytes) */
  originalSize: number;
  /** SHA-256 hash of original file (hex) — integrity check */
  digest: string;
};

export type EncryptedFileResult = {
  /** Encrypted file blob (for server upload) */
  encryptedBlob: Blob;
  /** File metadata (for message payload) */
  meta: EncryptedFileMeta;
};

export type EncryptedThumbnailResult = {
  /** Encrypted thumbnail blob */
  encryptedBlob: Blob;
  /** Thumbnail IV (base64) — same key as the file */
  iv: string;
  /** Thumbnail dimensions */
  width: number;
  height: number;
};

// ──────────────────────────────────
// File Encryption
// ──────────────────────────────────

/**
 * Hard upper bound on file size for the current single-shot encrypt path.
 *
 * Web Crypto's AES-GCM requires the complete plaintext upfront (the auth
 * tag covers the whole input), so we end up holding plaintext + ciphertext
 * in RAM simultaneously. At 100MB+ this routinely OOMs the renderer in
 * Chromium and silently kills the tab — the user gets a "Aw, snap!" with
 * no idea their attempted upload was the cause.
 *
 * We refuse anything above 64MB with a clear error so the failure mode is
 * a friendly toast instead of a tab crash. Self-hosters who raise the
 * server-side UPLOAD_MAX_SIZE beyond this will need the chunked-streaming
 * encrypt refactor (tracked as a follow-up — design notes in audit plan
 * H14): AES-GCM-SIV with per-chunk nonces, or age-style STREAM
 * construction over AES-256-GCM with sequential chunk IDs in the AAD.
 */
const SINGLE_SHOT_MAX_BYTES = 64 * 1024 * 1024; // 64 MB

/** Encrypt a file with AES-256-GCM. Generates random key + IV, computes SHA-256 hash. */
export async function encryptFile(file: File): Promise<EncryptedFileResult> {
  if (file.size > SINGLE_SHOT_MAX_BYTES) {
    throw new Error(
      `File ${file.name} is too large for E2EE encryption ` +
        `(${(file.size / 1024 / 1024).toFixed(1)}MB > ` +
        `${SINGLE_SHOT_MAX_BYTES / 1024 / 1024}MB limit). ` +
        `Streaming encryption is not yet implemented — split the file or ` +
        `disable E2EE for this upload.`,
    );
  }

  // Random AES-256 key and 12-byte IV
  const fileKey = crypto.getRandomValues(new Uint8Array(32));
  const fileIV = crypto.getRandomValues(new Uint8Array(12));

  // Read file contents
  const plaintext = new Uint8Array(await file.arrayBuffer());

  // SHA-256 hash for integrity check
  const hashBuffer = await crypto.subtle.digest("SHA-256", plaintext as BufferSource);
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Encrypt with AES-256-GCM
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    fileKey as BufferSource,
    "AES-GCM",
    false,
    ["encrypt"]
  );

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: fileIV },
    cryptoKey,
    plaintext as BufferSource
  );

  return {
    encryptedBlob: new Blob([encrypted], {
      type: "application/octet-stream",
    }),
    meta: {
      key: toBase64(fileKey),
      iv: toBase64(fileIV),
      filename: file.name,
      mimeType: file.type || "application/octet-stream",
      originalSize: file.size,
      digest: hashHex,
    },
  };
}

/** Download and decrypt an encrypted file. Verifies SHA-256 integrity. */
export async function decryptFile(
  url: string,
  meta: EncryptedFileMeta
): Promise<File> {
  // Download encrypted file. `credentials: "include"` is required in the
  // Electron/Capacitor shells, where the upload host is a different origin and
  // the default credentials mode would drop the `hichat_media` auth cookie.
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`Failed to download encrypted file: HTTP ${response.status}`);
  }

  const encryptedData = await response.arrayBuffer();

  // Decrypt with AES-256-GCM
  const fileKey = fromBase64(meta.key);
  const fileIV = fromBase64(meta.iv);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    fileKey as BufferSource,
    "AES-GCM",
    false,
    ["decrypt"]
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fileIV as BufferSource },
    cryptoKey,
    encryptedData
  );

  // SHA-256 integrity check
  const hashBuffer = await crypto.subtle.digest("SHA-256", decrypted);
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (hashHex !== meta.digest) {
    throw new Error(
      `File integrity check failed: expected ${meta.digest}, got ${hashHex}`
    );
  }

  // Create File object
  return new File([decrypted], meta.filename, {
    type: meta.mimeType,
  });
}

// ──────────────────────────────────
// Thumbnail Generation & Encryption
// ──────────────────────────────────

/** Thumbnail max size (pixels) */
const THUMBNAIL_MAX_SIZE = 256;

/** Generate an encrypted thumbnail for image files. Uses same key with different IV. */
export async function encryptThumbnail(
  file: File,
  fileKey: string
): Promise<EncryptedThumbnailResult | null> {
  // Only generate thumbnails for images
  if (!file.type.startsWith("image/")) {
    return null;
  }

  try {
    // Load image
    const imageBitmap = await createImageBitmap(file);
    const { width, height } = calculateThumbnailSize(
      imageBitmap.width,
      imageBitmap.height
    );

    // Draw to canvas
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    ctx.drawImage(imageBitmap, 0, 0, width, height);
    imageBitmap.close();

    // Convert to JPEG (quality: 0.7)
    const thumbnailBlob = await canvas.convertToBlob({
      type: "image/jpeg",
      quality: 0.7,
    });

    const thumbnailData = new Uint8Array(await thumbnailBlob.arrayBuffer());

    // Encrypt with different IV (same key)
    const thumbnailIV = crypto.getRandomValues(new Uint8Array(12));
    const key = fromBase64(fileKey);

    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      key as BufferSource,
      "AES-GCM",
      false,
      ["encrypt"]
    );

    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: thumbnailIV },
      cryptoKey,
      thumbnailData as BufferSource
    );

    return {
      encryptedBlob: new Blob([encrypted], {
        type: "application/octet-stream",
      }),
      iv: toBase64(thumbnailIV),
      width,
      height,
    };
  } catch {
    // Thumbnail generation failure is non-critical
    return null;
  }
}

/** Decrypt an encrypted thumbnail. Returns an Object URL. */
export async function decryptThumbnail(
  url: string,
  fileKey: string,
  thumbnailIV: string
): Promise<string> {
  // See decryptFile: cross-origin in the native shells, so cookies must be
  // sent explicitly.
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`Failed to download thumbnail: HTTP ${response.status}`);
  }

  const encryptedData = await response.arrayBuffer();
  const key = fromBase64(fileKey);
  const iv = fromBase64(thumbnailIV);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    "AES-GCM",
    false,
    ["decrypt"]
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    cryptoKey,
    encryptedData
  );

  const blob = new Blob([decrypted], { type: "image/jpeg" });
  return URL.createObjectURL(blob);
}

// ──────────────────────────────────
// Internal Helpers
// ──────────────────────────────────

/** Calculate thumbnail dimensions, fitting largest edge within THUMBNAIL_MAX_SIZE. */
function calculateThumbnailSize(
  originalWidth: number,
  originalHeight: number
): { width: number; height: number } {
  if (
    originalWidth <= THUMBNAIL_MAX_SIZE &&
    originalHeight <= THUMBNAIL_MAX_SIZE
  ) {
    return { width: originalWidth, height: originalHeight };
  }

  const ratio = Math.min(
    THUMBNAIL_MAX_SIZE / originalWidth,
    THUMBNAIL_MAX_SIZE / originalHeight
  );

  return {
    width: Math.round(originalWidth * ratio),
    height: Math.round(originalHeight * ratio),
  };
}

/** base64 → Uint8Array. Local copy to avoid circular dependency with signalProtocol. */
function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
