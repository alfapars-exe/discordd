/**
 * fileValidation — File upload validation.
 *
 * Callers (input, paste, drag-drop) partition into valid/rejected and toast
 * the rejected set; silently dropping files was the root cause of Bug A1
 * (chat attachments "sometimes" disappearing).
 */

import { MAX_FILE_SIZE, ALLOWED_MIME_TYPES } from "./constants";

export type FileRejectionReason = "too_large" | "type_not_allowed";

export type FileRejection = {
  file: File;
  reason: FileRejectionReason;
};

export type FileValidationResult = {
  valid: File[];
  rejected: FileRejection[];
};

const EXTENSION_TO_MIME: Record<string, (typeof ALLOWED_MIME_TYPES)[number]> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  pdf: "application/pdf",
  txt: "text/plain",
};

/**
 * Infer MIME from filename when `File.type` is empty. Windows Explorer,
 * some paste sources, and older mobile browsers ship `type: ""` even for
 * clearly-typed files — trusting the header alone rejected valid uploads.
 */
export function mimeTypeFromExtension(filename: string): string | null {
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) return null;
  const ext = filename.slice(dot + 1).toLowerCase();
  return EXTENSION_TO_MIME[ext] ?? null;
}

function effectiveMime(file: File): string | null {
  if (file.type && file.type !== "application/octet-stream") return file.type;
  return mimeTypeFromExtension(file.name);
}

export function validateFiles(files: FileList | File[]): FileValidationResult {
  const valid: File[] = [];
  const rejected: FileRejection[] = [];
  const allowed = ALLOWED_MIME_TYPES as readonly string[];

  for (const file of Array.from(files)) {
    if (file.size > MAX_FILE_SIZE) {
      rejected.push({ file, reason: "too_large" });
      continue;
    }
    const mime = effectiveMime(file);
    if (!mime || !allowed.includes(mime)) {
      rejected.push({ file, reason: "type_not_allowed" });
      continue;
    }
    valid.push(file);
  }
  return { valid, rejected };
}
