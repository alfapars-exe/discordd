/** MessageAttachments — Renders file/image attachments for a message. */

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ensureFreshToken } from "../../api/client";
import { resolveAssetUrl } from "../../utils/constants";
import { mimeTypeFromExtension } from "../../utils/fileValidation";
import EncryptedAttachment from "./EncryptedAttachment";
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

function MessageAttachments({ message }: Readonly<MessageAttachmentsProps>) {
  const attachments = message.attachments;
  if (!attachments || attachments.length === 0) return null;

  return (
    <div className="msg-attachments">
      {attachments.map((attachment, idx) => {
        const isEncrypted = message.encryption_version === 1;
        const fileMeta = isEncrypted ? message.e2ee_file_keys?.[idx] : undefined;

        if (isEncrypted && !fileMeta) {
          return <MissingKeyPlaceholder key={attachment.id} attachment={attachment} />;
        }

        if (fileMeta) {
          return (
            <EncryptedAttachment
              key={attachment.id}
              attachment={attachment}
              fileMeta={fileMeta}
            />
          );
        }

        return <PlaintextAttachment key={attachment.id} attachment={attachment} />;
      })}
    </div>
  );
}

/**
 * `/api/uploads/*` is auth-gated, and an <img> can't carry an Authorization
 * header — it authenticates with the `hichat_media` cookie, whose value is the
 * access token but whose Max-Age (30d) far outlives it. A tab left idle past
 * the access TTL therefore serves a stale cookie and the image 401s.
 *
 * So the first error is treated as "probably stale token": refresh once, then
 * re-request with a busted URL (the browser would otherwise replay the cached
 * failure). Only a second error means the file is genuinely unrenderable and
 * we degrade to the file card. Latching on the *first* error was the bug —
 * the tile stayed a generic card for the life of the render even after the
 * next API call had already refreshed the cookie.
 */
function PlaintextAttachment({ attachment }: Readonly<{ attachment: ChatAttachment }>) {
  const url = resolveAssetUrl(attachment.file_url);
  const [imgFailed, setImgFailed] = useState(false);
  const [src, setSrc] = useState(url);
  const retriedRef = useRef(false);

  const handleError = () => {
    if (retriedRef.current) {
      setImgFailed(true);
      return;
    }
    retriedRef.current = true;
    // ensureFreshToken() no-ops when the in-memory token is still valid and
    // collapses concurrent callers onto one shared refresh, so a screenful of
    // simultaneously-failing images costs a single /auth/refresh. A failed
    // refresh still gets the one retry; a second error then latches.
    void ensureFreshToken()
      .catch(() => undefined)
      .then(() => setSrc(`${url}${url.includes("?") ? "&" : "?"}r=1`));
  };

  if (isImageAttachment(attachment) && !imgFailed) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer">
        <img
          src={src}
          alt={attachment.filename}
          className="msg-attachment-img"
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
