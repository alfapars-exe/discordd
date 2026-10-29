/** MessageAttachments — Renders file/image attachments for a message. */

import { useTranslation } from "react-i18next";
import { resolveAssetUrl } from "../../utils/constants";
import { mimeTypeFromExtension } from "../../utils/fileValidation";
import { useAuthImageRetry } from "../../hooks/useAuthImageRetry";
import {
  useLightboxStore,
  isPlainLeftClick,
  type LightboxItem,
} from "../../stores/lightboxStore";
import EncryptedAttachment from "./EncryptedAttachment";
import AccessibleAnimatedImage from "../shared/AccessibleAnimatedImage";
import UnclassifiedMediaGate from "./UnclassifiedMediaGate";
import type { ChatMessage, ChatAttachment } from "../../hooks/useChatContext";

type MessageAttachmentsProps = {
  message: ChatMessage;
};

/**
 * Server can persist `mime_type` as null when the sniff step is bypassed
 * (E2EE) or when older uploads predate MIME sniffing. Filename fallback
 * keeps images inline instead of degrading to a generic file card.
 */
function isImageAttachment(attachment: ChatAttachment): boolean {
  const mime = attachment.mime_type;
  if (typeof mime === "string" && mime.startsWith("image/")) return true;
  if (mime && mime !== "application/octet-stream") return false;
  const inferred = mimeTypeFromExtension(attachment.filename);
  return typeof inferred === "string" && inferred.startsWith("image/");
}

function isGifAttachment(attachment: ChatAttachment): boolean {
  return attachment.mime_type?.toLowerCase() === "image/gif" || /\.gif$/i.test(attachment.filename);
}

function MessageAttachments({ message }: Readonly<MessageAttachmentsProps>) {
  const { t } = useTranslation("chat");
  const attachments = message.attachments ?? [];
  const states = (message.attachment_states ?? []).filter((state) => state.status !== "ready");
  if (attachments.length === 0 && states.length === 0) return null;

  const plaintextGallery: LightboxItem[] =
    message.encryption_version === 1
      ? []
      : attachments.filter(isImageAttachment).map((attachment) => {
          const url = resolveAssetUrl(attachment.file_url);
          return {
            kind: "remote" as const,
            src: url,
            href: url,
            filename: attachment.filename,
            authRetry: true,
            authorName: message.author.display_name || message.author.username,
            authorAvatarUrl: message.author.avatar_url,
            createdAt: message.created_at,
            messageId: message.id,
            message,
          };
        });

  const content = (
    <div className="msg-attachments">
      {attachments.map((attachment, idx) => {
        const isEncrypted = message.encryption_version === 1;
        const fileMeta = isEncrypted ? message.e2ee_file_keys?.[attachment.file_key_index ?? idx] : undefined;

        if (isEncrypted && !fileMeta) {
          return <MissingKeyPlaceholder key={attachment.id} attachment={attachment} />;
        }

        if (fileMeta) {
          return (
            <EncryptedAttachment
              key={attachment.id}
              attachment={attachment}
              fileMeta={fileMeta}
              authorName={message.author.display_name || message.author.username}
              authorAvatarUrl={message.author.avatar_url}
              createdAt={message.created_at}
              messageId={message.id}
              message={message}
            />
          );
        }

        return (
          <PlaintextAttachment
            key={attachment.id}
            attachment={attachment}
            message={message}
            gallery={plaintextGallery}
          />
        );
      })}
      {states.map((state) => <div className="msg-file" role="status" key={`preparation-${state.index}`}>
        <span>{message.encryption_version === 1 ? message.e2ee_file_keys?.[state.index]?.filename ?? state.filename : state.filename}</span>
        <span>{t(state.status === "preparing" ? "attachmentPreparing" : "attachmentFailed")}</span>
      </div>)}
    </div>
  );
  const mediaInputs = attachments.flatMap((attachment, index) => {
    const fileMeta = message.encryption_version === 1 ? message.e2ee_file_keys?.[index] : undefined;
    const mimeType = !attachment.mime_type || attachment.mime_type === "application/octet-stream"
      ? mimeTypeFromExtension(attachment.filename) ?? "application/octet-stream" : attachment.mime_type;
    const visual = isImageAttachment(attachment) || /^(image|video)\//.test(fileMeta?.mimeType ?? mimeType);
    return visual ? [{url: attachment.file_url, mimeType, size: attachment.file_size, fileMeta}] : [];
  });
  return mediaInputs.length ? <UnclassifiedMediaGate authorId={message.user_id} messageId={message.id} revision={message.edited_at ?? "original"} mediaInputs={mediaInputs} identity={`${message.id}:${attachments.map((item) => item.id).join(",")}`}>{content}</UnclassifiedMediaGate> : content;
}

/**
 * Stale-token 401 retry lives in useAuthImageRetry (shared with the
 * lightbox — see the hook's doc comment for the hichat_media cookie trap).
 * Plain left-click opens the fullscreen preview; modifier/middle clicks
 * keep the anchor's native open-in-tab / save-as behavior.
 */
function PlaintextAttachment({
  attachment,
  message,
  gallery,
}: Readonly<{
  attachment: ChatAttachment;
  message: ChatMessage;
  gallery: LightboxItem[];
}>) {
  const url = resolveAssetUrl(attachment.file_url);
  const { src, failed, handleError } = useAuthImageRetry(url, true);
  const openGallery = useLightboxStore((s) => s.openGallery);

  if (isImageAttachment(attachment) && !failed) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => {
          if (!isPlainLeftClick(e)) return;
          e.preventDefault();
          // Message rows have their own hover/long-press handlers.
          e.stopPropagation();
          // Pass the CURRENT src (post-retry) so a fresh-cookie image
          // renders straight from the browser cache.
          const current: LightboxItem = {
            kind: "remote",
            src,
            href: url,
            filename: attachment.filename,
            authRetry: true,
            authorName: message.author.display_name || message.author.username,
            authorAvatarUrl: message.author.avatar_url,
            createdAt: message.created_at,
            messageId: message.id,
            message,
          };
          const index = gallery.findIndex(
            (candidate) =>
              candidate.kind === "remote" &&
              candidate.filename === attachment.filename &&
              candidate.href === url
          );
          const items = gallery.map((candidate, candidateIndex) => candidateIndex === index ? current : candidate);
          openGallery(items.length > 0 ? items : [current], Math.max(index, 0));
        }}
      >
        <AccessibleAnimatedImage
          src={src}
          alt={attachment.filename}
          className="msg-attachment-img"
          animated={isGifAttachment(attachment)}
          loading="lazy"
          decoding="async"
          onError={handleError}
        />
      </a>
    );
  }

  return <FileCard attachment={attachment} url={url} />;
}

function MissingKeyPlaceholder({ attachment }: Readonly<{ attachment: ChatAttachment }>) {
  const { t } = useTranslation("e2ee");
  return (
    <div className="msg-attachment-file msg-attachment-file--locked">
      <FileIcon />
      <div style={{ minWidth: 0 }}>
        <p className="msg-attachment-file-name">{attachment.filename}</p>
        <p className="msg-attachment-file-size">🔒 {t("e2eeKeyMissing")}</p>
      </div>
    </div>
  );
}

function FileCard({ attachment, url }: Readonly<{ attachment: ChatAttachment; url: string }>) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="msg-attachment-file"
    >
      <FileIcon />
      <div style={{ minWidth: 0 }}>
        <p className="msg-attachment-file-name">{attachment.filename}</p>
        {attachment.file_size !== null && attachment.file_size > 0 && (
          <p className="msg-attachment-file-size">
            {formatFileSize(attachment.file_size)}
          </p>
        )}
      </div>
    </a>
  );
}

function FileIcon() {
  return (
    <svg
      className="msg-attachment-file-icon"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m.75 12l3 3m0 0l3-3m-3 3v-6m-1.5-9H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
      />
    </svg>
  );
}

/** Format bytes to human-readable size (1024 -> "1.0 KB") */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default MessageAttachments;
