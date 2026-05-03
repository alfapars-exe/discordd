/**
 * FeedbackCreateForm — submission form for a new feedback ticket.
 *
 * Extracted from FeedbackSettings so both the user view (FeedbackSettings)
 * and the admin inbox (AdminFeedbackList) can host the same composer.
 *
 * Caller controls open/close via the `onClose` and `onSubmitted` callbacks.
 */

import { useState, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";

import { useToastStore } from "../../stores/toastStore";
import { createFeedbackTicket } from "../../api/feedback";
import type { FeedbackType } from "../../types";
import { useFileDrop } from "../../hooks/useFileDrop";
import FilePreview from "../chat/FilePreview";

const MAX_FILES = 4;
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

type Props = {
  onSubmitted: () => void;
  onClose: () => void;
};

function FeedbackCreateForm({ onSubmitted, onClose }: Props) {
  const { t } = useTranslation("settings");
  const addToast = useToastStore((s) => s.addToast);

  const [formType, setFormType] = useState<FeedbackType>("bug");
  const [formSubject, setFormSubject] = useState("");
  const [formContent, setFormContent] = useState("");
  const [formFiles, setFormFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const addFiles = useCallback(
    (newFiles: File[]) => {
      const images = newFiles.filter((f) => ALLOWED_TYPES.includes(f.type));
      if (images.length === 0) return;
      setFormFiles((prev) => {
        const remaining = MAX_FILES - prev.length;
        if (remaining <= 0) {
          addToast("warning", t("feedbackMaxFiles"));
          return prev;
        }
        if (images.length > remaining) addToast("warning", t("feedbackMaxFiles"));
        return [...prev, ...images.slice(0, remaining)];
      });
    },
    [addToast, t],
  );

  const { isDragging, dragHandlers } = useFileDrop(addFiles);

  function handlePaste(e: React.ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const pasted: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === "file") {
        const f = item.getAsFile();
        if (f) pasted.push(f);
      }
    }
    if (pasted.length > 0) addFiles(pasted);
  }

  async function handleSubmit() {
    if (!formSubject.trim() || formContent.trim().length < 10) return;
    setIsSubmitting(true);
    try {
      const res = await createFeedbackTicket({
        type: formType,
        subject: formSubject.trim(),
        content: formContent.trim(),
        files: formFiles.length > 0 ? formFiles : undefined,
      });
      if (res.success) {
        addToast("success", t("feedbackSubmitSuccess"));
        onSubmitted();
      } else {
        addToast("error", res.error ?? t("feedbackSubmitError"));
      }
    } catch {
      addToast("error", t("feedbackSubmitError"));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div
      className="feedback-create-form"
      {...dragHandlers}
      onPaste={handlePaste}
    >
      <div
        className="settings-section-header"
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
      >
        <h2 className="settings-section-title">{t("feedbackNewTicket")}</h2>
        <button
          className="settings-btn settings-btn-secondary"
          onClick={onClose}
        >
          {t("feedbackBackToList")}
        </button>
      </div>

      {isDragging && (
        <div className="file-drop-overlay">
          <span className="file-drop-text">{t("feedbackEvidenceHint")}</span>
        </div>
      )}

      <label className="settings-label">{t("feedbackTypeLabel")}</label>
      <select
        className="settings-input"
        value={formType}
        onChange={(e) => setFormType(e.target.value as FeedbackType)}
      >
        <option value="bug">{t("feedbackType_bug")}</option>
        <option value="suggestion">{t("feedbackType_suggestion")}</option>
        <option value="question">{t("feedbackType_question")}</option>
        <option value="other">{t("feedbackType_other")}</option>
      </select>

      <label className="settings-label">{t("feedbackSubjectLabel")}</label>
      <input
        className="settings-input"
        type="text"
        value={formSubject}
        onChange={(e) => setFormSubject(e.target.value)}
        placeholder={t("feedbackSubjectPlaceholder")}
        maxLength={200}
      />

      <label className="settings-label">{t("feedbackContentLabel")}</label>
      <textarea
        className="settings-input feedback-textarea"
        value={formContent}
        onChange={(e) => setFormContent(e.target.value)}
        placeholder={t("feedbackContentPlaceholder")}
        rows={6}
        maxLength={5000}
      />

      <div className="report-field">
        <label className="settings-label">{t("feedbackAttachmentsLabel")}</label>

        {formFiles.length > 0 && (
          <FilePreview
            files={formFiles}
            onRemove={(i) => setFormFiles((prev) => prev.filter((_, j) => j !== i))}
          />
        )}

        {formFiles.length < MAX_FILES && (
          <button
            type="button"
            className="report-evidence-drop"
            onClick={() => fileInputRef.current?.click()}
          >
            <span className="report-evidence-hint">{t("feedbackEvidenceHint")}</span>
          </button>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            if (e.target.files) addFiles(Array.from(e.target.files));
            e.target.value = "";
          }}
        />
      </div>

      <button
        className="settings-btn settings-btn-primary"
        onClick={handleSubmit}
        disabled={isSubmitting || !formSubject.trim() || formContent.trim().length < 10}
      >
        {isSubmitting ? t("feedbackSubmitting") : t("feedbackSubmit")}
      </button>
    </div>
  );
}

export default FeedbackCreateForm;
