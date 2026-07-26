/**
 * ImageLightbox — Fullscreen image preview overlay.
 *
 * Driven by lightboxStore; a single instance mounts in AppLayout's overlay
 * fragment because the virtualized message list can unmount the triggering
 * tile while the preview stays open. Behavior mirrors Modal.tsx (portal to
 * body, ESC + backdrop close, body scroll lock) but with its own
 * .image-lightbox-* CSS — .modal-card's 480px width / z-index 50 don't fit
 * a fullscreen viewer.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useLightboxStore, type LightboxItem } from "../../stores/lightboxStore";
import { useAuthImageRetry } from "../../hooks/useAuthImageRetry";

function ImageLightbox() {
  const item = useLightboxStore((s) => s.item);
  const close = useLightboxStore((s) => s.close);

  if (!item) return null;
  return createPortal(<LightboxDialog item={item} onClose={close} />, document.body);
}

function LightboxDialog({
  item,
  onClose,
}: Readonly<{ item: LightboxItem; onClose: () => void }>) {
  const { t } = useTranslation("chat");
  const { t: tCommon } = useTranslation("common");
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const prevFocusRef = useRef<Element | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  const remote = item.kind === "remote" ? item : null;
  const retry = useAuthImageRetry(remote?.src ?? "", remote?.authRetry ?? false);

  // Blob items: create our OWN object URL from the decrypted File — the
  // tile revokes its URL on unmount, so reusing it would blank the viewer.
  // Keyed on `item` so switching images swaps (and revokes) URLs cleanly.
  useEffect(() => {
    if (item.kind !== "blob") {
      queueMicrotask(() => setBlobUrl(null));
      return;
    }
    const url = URL.createObjectURL(item.file);
    queueMicrotask(() => setBlobUrl(url));
    return () => URL.revokeObjectURL(url);
  }, [item]);

  // ESC + body scroll lock + focus save/restore (mirrors Modal.tsx).
  useEffect(() => {
    prevFocusRef.current = document.activeElement;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => closeBtnRef.current?.focus());
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
      if (prevFocusRef.current instanceof HTMLElement) prevFocusRef.current.focus();
    };
  }, [onClose]);

  const src = item.kind === "blob" ? blobUrl : retry.src;
  const href = item.kind === "blob" ? blobUrl : item.href;
  const failed = item.kind === "remote" && retry.failed;

  return (
    <div
      className="image-lightbox-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t("imagePreview")}
      onClick={onClose}
    >
      {/* Top bar swallows clicks so link/button taps never close the viewer */}
      <div className="image-lightbox-topbar" onClick={(e) => e.stopPropagation()}>
        <span className="image-lightbox-filename" title={item.filename}>
          {item.filename}
        </span>
        {href && (
          <a
            className="image-lightbox-action"
            href={href}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("lightboxOpenOriginal")}
          </a>
        )}
        {href && (
          <a
            className="image-lightbox-action"
            href={href}
            download={item.filename}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("lightboxDownload")}
          </a>
        )}
        <button
          ref={closeBtnRef}
          className="image-lightbox-close"
          onClick={onClose}
          aria-label={tCommon("close")}
        >
          ✕
        </button>
      </div>

      {failed ? (
        <p className="image-lightbox-error" onClick={(e) => e.stopPropagation()}>
          {t("lightboxImageFailed")}
        </p>
      ) : (
        src && (
          <img
            src={src}
            alt={item.filename}
            className="image-lightbox-img"
            onClick={(e) => e.stopPropagation()}
            onError={item.kind === "remote" ? retry.handleError : undefined}
            referrerPolicy={remote?.noReferrer ? "no-referrer" : undefined}
          />
        )
      )}
    </div>
  );
}

export default ImageLightbox;
