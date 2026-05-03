/** FeedbackSettings — Submit feedback tickets and view your ticket history. */

import { useEffect, useState, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useToastStore } from "../../stores/toastStore";
import {
  listMyFeedbackTickets,
  getFeedbackTicket,
  addFeedbackReply,
  deleteFeedbackTicket,
} from "../../api/feedback";
import type { FeedbackTicket, FeedbackReply } from "../../types";
import { resolveAssetUrl } from "../../utils/constants";
import FilePreview from "../chat/FilePreview";
import FeedbackCreateForm from "./FeedbackCreateForm";

type View = "list" | "create" | "detail";

function FeedbackSettings() {
  const { t } = useTranslation("settings");
  const addToast = useToastStore((s) => s.addToast);

  const [view, setView] = useState<View>("list");
  const [tickets, setTickets] = useState<FeedbackTicket[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(false);

  // Detail view state
  const [activeTicket, setActiveTicket] = useState<FeedbackTicket | null>(null);
  const [replies, setReplies] = useState<FeedbackReply[]>([]);
  const [replyContent, setReplyContent] = useState("");
  const [replyFiles, setReplyFiles] = useState<File[]>([]);
  const replyFileInputRef = useRef<HTMLInputElement>(null);
  const [isSendingReply, setIsSendingReply] = useState(false);

  const MAX_FILES = 4;
  const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

  const fetchTickets = useCallback(async () => {
    try {
      setIsLoading(true);
      const res = await listMyFeedbackTickets();
      if (res.success && res.data) {
        setTickets(res.data.tickets ?? []);
        setTotal(res.data.total);
      }
    } catch {
      addToast("error", t("feedbackLoadError"));
    } finally {
      setIsLoading(false);
    }
  }, [addToast, t]);

  useEffect(() => {
    fetchTickets();
  }, [fetchTickets]);

  const openTicket = async (ticketId: string) => {
    try {
      const res = await getFeedbackTicket(ticketId);
      if (res.success && res.data) {
        setActiveTicket(res.data.ticket);
        setReplies(res.data.replies ?? []);
        setView("detail");
      }
    } catch {
      addToast("error", t("feedbackLoadError"));
    }
  };

  const handleDelete = async () => {
    if (!activeTicket) return;
    if (!window.confirm(t("feedbackDeleteConfirm"))) return;
    const res = await deleteFeedbackTicket(activeTicket.id);
    if (res.success) {
      addToast("success", t("feedbackDeleteSuccess"));
      setView("list");
      setActiveTicket(null);
      fetchTickets();
    } else {
      addToast("error", res.error ?? t("feedbackDeleteError"));
    }
  };

  const handleReply = async () => {
    if (!replyContent.trim() || !activeTicket) return;
    try {
      setIsSendingReply(true);
      const res = await addFeedbackReply(activeTicket.id, replyContent.trim(), replyFiles.length > 0 ? replyFiles : undefined);
      if (res.success && res.data) {
        setReplies((prev) => [...prev, res.data!]);
        setReplyContent("");
        setReplyFiles([]);
      } else {
        addToast("error", res.error ?? t("feedbackReplyError"));
      }
    } catch {
      addToast("error", t("feedbackReplyError"));
    } finally {
      setIsSendingReply(false);
    }
  };

  return (
    <div className="settings-section">
      {/* Header for list and detail views — create view has its own header
          inside FeedbackCreateForm. */}
      {view !== "create" && (
        <div className="settings-section-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h2 className="settings-section-title">
            {view === "list" && t("feedback")}
            {view === "detail" && activeTicket?.subject}
          </h2>
          {view === "list" && (
            <button
              className="settings-btn settings-btn-primary"
              onClick={() => setView("create")}
            >
              {t("feedbackNewTicket")}
            </button>
          )}
          {view === "detail" && (
            <button
              className="settings-btn settings-btn-secondary"
              onClick={() => { setView("list"); setActiveTicket(null); }}
            >
              {t("feedbackBackToList")}
            </button>
          )}
        </div>
      )}

      {/* ─── List View ─── */}
      {view === "list" && (
        <div className="feedback-list">
          {isLoading && tickets.length === 0 && (
            <p className="settings-empty">{t("feedbackLoading")}</p>
          )}
          {!isLoading && tickets.length === 0 && (
            <p className="settings-empty">{t("feedbackEmpty")}</p>
          )}
          {tickets.map((ticket) => (
            <button
              key={ticket.id}
              className="feedback-ticket-row"
              onClick={() => openTicket(ticket.id)}
            >
              <span className={`feedback-type-badge feedback-type-${ticket.type}`}>
                {t(`feedbackType_${ticket.type}`)}
              </span>
              <span className="feedback-ticket-subject">{ticket.subject}</span>
              <span className={`feedback-status-badge feedback-status-${ticket.status}`}>
                {t(`feedbackStatus_${ticket.status}`)}
              </span>
              {(ticket.reply_count ?? 0) > 0 && (
                <span className="feedback-reply-count">
                  {ticket.reply_count} {t("feedbackReplies")}
                </span>
              )}
              <span className="feedback-ticket-date">
                {new Date(ticket.created_at).toLocaleDateString()}
              </span>
            </button>
          ))}
          {total > tickets.length && (
            <p className="settings-empty">
              {t("feedbackShowingOf", { shown: tickets.length, total })}
            </p>
          )}
        </div>
      )}

      {/* ─── Create View ─── */}
      {view === "create" && (
        <FeedbackCreateForm
          onSubmitted={() => { setView("list"); fetchTickets(); }}
          onClose={() => setView("list")}
        />
      )}

      {/* ─── Detail View ─── */}
      {view === "detail" && activeTicket && (
        <div className="feedback-detail">
          <div className="feedback-detail-meta">
            <span className={`feedback-type-badge feedback-type-${activeTicket.type}`}>
              {t(`feedbackType_${activeTicket.type}`)}
            </span>
            <span className={`feedback-status-badge feedback-status-${activeTicket.status}`}>
              {t(`feedbackStatus_${activeTicket.status}`)}
            </span>
            <span className="feedback-ticket-date">
              {new Date(activeTicket.created_at).toLocaleString()}
            </span>
            <button
              className="settings-btn settings-btn-danger"
              onClick={handleDelete}
              style={{ marginLeft: "auto" }}
            >
              {t("feedbackDelete")}
            </button>
          </div>

          <div className="feedback-detail-content">
            <p>{activeTicket.content}</p>
          </div>

          {activeTicket.attachments && activeTicket.attachments.length > 0 && (
            <div className="feedback-attachments">
              {activeTicket.attachments.map((att) => (
                <a
                  key={att.id}
                  href={resolveAssetUrl(att.file_url)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="feedback-attachment-thumb"
                >
                  <img src={resolveAssetUrl(att.file_url)} alt={att.filename} />
                </a>
              ))}
            </div>
          )}

          {/* Replies */}
          <div className="feedback-replies">
            {replies.map((reply) => (
              <div
                key={reply.id}
                className={`feedback-reply ${reply.is_admin ? "feedback-reply-admin" : "feedback-reply-user"}`}
              >
                <div className="feedback-reply-header">
                  <span className="feedback-reply-author">
                    {reply.display_name ?? reply.username}
                    {reply.is_admin && <span className="feedback-admin-badge">{t("feedbackAdminBadge")}</span>}
                  </span>
                  <span className="feedback-reply-date">
                    {new Date(reply.created_at).toLocaleString()}
                  </span>
                </div>
                <p className="feedback-reply-content">{reply.content}</p>
                {reply.attachments && reply.attachments.length > 0 && (
                  <div className="feedback-attachments">
                    {reply.attachments.map((att) => (
                      <a key={att.id} href={resolveAssetUrl(att.file_url)} target="_blank" rel="noopener noreferrer" className="feedback-attachment-thumb">
                        <img src={resolveAssetUrl(att.file_url)} alt={att.filename} />
                      </a>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Reply input */}
          {activeTicket.status !== "closed" && (
            <div className="feedback-reply-input">
              <textarea
                className="settings-input"
                value={replyContent}
                onChange={(e) => setReplyContent(e.target.value)}
                placeholder={t("feedbackReplyPlaceholder")}
                rows={3}
                maxLength={5000}
              />
              <div className="report-field">
                {replyFiles.length > 0 && (
                  <FilePreview files={replyFiles} onRemove={(i) => setReplyFiles((prev) => prev.filter((_, j) => j !== i))} />
                )}
                {replyFiles.length < MAX_FILES && (
                  <button
                    type="button"
                    className="report-evidence-drop"
                    onClick={() => replyFileInputRef.current?.click()}
                  >
                    <span className="report-evidence-hint">{t("feedbackEvidenceHint")}</span>
                  </button>
                )}
                <input
                  ref={replyFileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/gif,image/webp"
                  multiple
                  style={{ display: "none" }}
                  onChange={(e) => {
                    if (e.target.files) {
                      const images = Array.from(e.target.files).filter((f) => ALLOWED_TYPES.includes(f.type));
                      setReplyFiles((prev) => [...prev, ...images].slice(0, MAX_FILES));
                    }
                    e.target.value = "";
                  }}
                />
              </div>
              <button
                className="settings-btn settings-btn-primary"
                onClick={handleReply}
                disabled={isSendingReply || !replyContent.trim()}
              >
                {isSendingReply ? t("feedbackSending") : t("feedbackSendReply")}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default FeedbackSettings;
