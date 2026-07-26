/**
 * fileValidation — File upload validation.
 *
 * Callers (input, paste, drag-drop) partition into valid/rejected and toast
 * the rejected set; silently dropping files was the root cause of Bug A1
 * (chat attachments "sometimes" disappearing).
 *
 * Size is the ONLY rejection reason: every file type is uploadable. The
 * server records a byte-sniffed MIME and serves non-displayable types as
 * forced downloads, so the client no longer gates on type at all.
 */

import { MAX_FILE_SIZE } from "./constants";

export type FileRejectionReason = "too_large";

export type FileRejection = {
  file: File;
  reason: FileRejectionReason;
};

export type FileValidationResult = {
  valid: File[];
  rejected: FileRejection[];
};

/**
 * Display-only extension → MIME map. NOT a validation allowlist — it backs
 * isImageAttachment-style render decisions when the stored mime_type is
 * null (E2EE uploads) or generic. svg is deliberately absent: SVG can carry
 * script, so it must never be classified as an inline-renderable image.
 */
const EXTENSION_TO_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wave",
  pdf: "application/pdf",
  txt: "text/plain",
};

/**
 * Infer MIME from filename when `File.type` / stored mime_type is empty.
 * Windows Explorer, some paste sources, and older mobile browsers ship
 * `type: ""` even for clearly-typed files.
 */
export function mimeTypeFromExtension(filename: string): string | null {
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) return null;
  const ext = filename.slice(dot + 1).toLowerCase();
  return EXTENSION_TO_MIME[ext] ?? null;
}

export function validateFiles(files: FileList | File[]): FileValidationResult {
  const valid: File[] = [];
  const rejected: FileRejection[] = [];

  for (const file of Array.from(files)) {
    if (file.size > MAX_FILE_SIZE) {
      rejected.push({ file, reason: "too_large" });
      continue;
    }
    valid.push(file);
  }
  return { valid, rejected };
}
