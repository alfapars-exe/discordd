/**
 * useAttachmentRejectionToast — Single call site for reporting rejected
 * uploads. Prior code silently dropped rejected files across paste, input,
 * and drag-drop — users had no feedback why an attachment vanished.
 */

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useToastStore } from "../stores/toastStore";
import { MAX_FILE_SIZE } from "../utils/constants";
import type { FileRejection } from "../utils/fileValidation";

const MB = 1024 * 1024;
const REJECTION_TOAST_MS = 6000;

export function useAttachmentRejectionToast(): (rejections: FileRejection[]) => void {
  const { t } = useTranslation("chat");
  const addToast = useToastStore((s) => s.addToast);

  return useCallback(
    (rejections: FileRejection[]) => {
      if (rejections.length === 0) return;

      const maxMB = Math.floor(MAX_FILE_SIZE / MB);
      const lines = rejections.map(({ file, reason }) => {
        const reasonText =
          reason === "too_large"
            ? t("fileTooLarge", { max: maxMB })
            : t("fileTypeNotAllowed");
        return `${file.name} — ${reasonText}`;
      });
      addToast("error", lines.join("\n"), REJECTION_TOAST_MS);
    },
    [addToast, t]
  );
}
