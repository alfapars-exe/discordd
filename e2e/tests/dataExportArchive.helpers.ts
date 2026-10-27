import { inflateRawSync } from "node:zlib";
import type { Page } from "@playwright/test";

export type OpaqueAttachmentFixture = {
  messageID: string;
  attachmentID: string;
  expectedBytes: Buffer;
};

/**
 * Upload deterministic opaque bytes on an E2EE-shaped message to the
 * already-created synthetic server/channel. This exercises the server's
 * encrypted-attachment path; it deliberately does not claim to test client
 * cryptography or decryptability.
 */
export async function createOpaqueAttachmentFixture(
  page: Page,
  serverID: string,
  channelID: string,
): Promise<OpaqueAttachmentFixture> {
  if (!/^[a-f0-9]{16}$/.test(serverID) || !/^[a-f0-9]{16}$/.test(channelID)) {
    throw new Error("refusing to seed an attachment outside the generated fixture IDs");
  }

  const expectedBytes = Buffer.from([
    0x00, 0xff, 0x13, 0x37, 0x80, 0x01, 0xfe, 0x44,
    0x00, 0x9a, 0x55, 0xaa, 0x10, 0x20, 0x30, 0x40,
  ]);
  const result = await page.evaluate(async ({ serverID, channelID, bytes }) => {
    const refresh = await fetch("/api/auth/refresh", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-HiChat-Client": "web" },
      body: "{}",
    });
    const refreshed = await refresh.json().catch(() => null) as { success?: boolean; data?: { access_token?: string } } | null;
    const token = refreshed?.data?.access_token;
    if (!refresh.ok || refreshed?.success !== true || !token) {
      throw new Error(`could not refresh synthetic owner session (${refresh.status})`);
    }

    const form = new FormData();
    form.set("encryption_version", "1");
    form.set("ciphertext", btoa("synthetic opaque message fixture"));
    form.set("sender_device_id", "e2e-synthetic-device");
    form.set("e2ee_metadata", "{}");
    form.append("files", new Blob([Uint8Array.from(bytes)], { type: "application/octet-stream" }), "opaque-ciphertext.bin");

    const response = await fetch(`/api/servers/${serverID}/channels/${channelID}/messages`, {
      method: "POST",
      credentials: "omit",
      headers: { Authorization: `Bearer ${token}`, "X-HiChat-Client": "web" },
      body: form,
    });
    const envelope = await response.json().catch(() => null) as {
      success?: boolean;
      data?: { id?: string; attachments?: Array<{ id?: string; filename?: string }> };
    } | null;
    const attachment = envelope?.data?.attachments?.find((item) => item.filename === "opaque-ciphertext.bin");
    if (!response.ok || envelope?.success !== true || !envelope.data?.id || !attachment?.id) {
      throw new Error(`synthetic opaque attachment upload failed (${response.status})`);
    }
    return { messageID: envelope.data.id, attachmentID: attachment.id };
  }, { serverID, channelID, bytes: [...expectedBytes] });

  // Refresh above rotates the refresh cookie. Reload so the app replaces its
  // in-memory access token with the session represented by that new cookie.
  await page.reload();
  return { ...result, expectedBytes };
}

/** Read the small Store/Deflate ZIPs emitted by the export worker. */
export function readExportZipEntries(archive: Buffer): Map<string, Buffer> {
  const eocdSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const eocd = archive.lastIndexOf(eocdSignature);
  if (eocd < 0 || eocd + 22 > archive.length) throw new Error("download is not a complete ZIP archive");
  const entryCount = archive.readUInt16LE(eocd + 10);
  let cursor = archive.readUInt32LE(eocd + 16);
  const entries = new Map<string, Buffer>();

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > archive.length || archive.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error("ZIP central directory is malformed");
    }
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localHeaderOffset = archive.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd + extraLength + commentLength > archive.length) throw new Error("ZIP entry metadata is truncated");
    const name = archive.toString("utf8", nameStart, nameEnd);
    if ((flags & 0x1) !== 0 || entries.has(name)) throw new Error("ZIP entry is encrypted or duplicated");
    if (localHeaderOffset + 30 > archive.length || archive.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error("ZIP local entry header is malformed");
    }
    const localNameLength = archive.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = archive.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > archive.length) throw new Error("ZIP entry payload is truncated");
    const compressed = archive.subarray(dataStart, dataEnd);
    let data: Buffer;
    if (method === 0) data = Buffer.from(compressed);
    else if (method === 8) data = inflateRawSync(compressed);
    else throw new Error(`unsupported ZIP compression method ${method}`);
    if (data.length !== uncompressedSize) throw new Error("ZIP entry size does not match its directory record");
    entries.set(name, data);
    cursor = nameEnd + extraLength + commentLength;
  }
  return entries;
}
