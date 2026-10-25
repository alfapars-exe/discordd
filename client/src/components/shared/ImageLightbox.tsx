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
import ForwardMessageModal from "../chat/ForwardMessageModal";
import { usePreferencesStore } from "../../stores/preferencesStore";
import { useAuthStore } from "../../stores/authStore";
import {friendshipSnapshotKey} from "../../utils/relationshipMediaPolicy";
import { useFriendStore } from "../../stores/friendStore";

function mediaPolicySnapshot(data: Record<string, unknown>): string {
  const privacy = data.privacy as { sensitiveMedia?: unknown; disturbingMedia?: unknown } | undefined;
  return JSON.stringify([privacy?.sensitiveMedia, privacy?.disturbingMedia]);
}

function ImageLightbox() {
  const item = useLightboxStore((s) => s.item);
  const close = useLightboxStore((s) => s.close);
  const itemCount = useLightboxStore((s) => s.items.length);
  const index = useLightboxStore((s) => s.index);
  const next = useLightboxStore((s) => s.next);
  const previous = useLightboxStore((s) => s.previous);

  useEffect(() => {
    // A viewer outlives its virtualized message tile. Revoke the open
    // preview when the account, source relationship or media policy changes;
    // reopening must go through the message's current visibility guard.
    const unwatchPreferences = usePreferencesStore.subscribe((state, previousState) => {
      if (mediaPolicySnapshot(state.data) !== mediaPolicySnapshot(previousState.data)) close();
    });
    const unwatchAccount = useAuthStore.subscribe((state, previousState) => {
      if (state.user?.id !== previousState.user?.id) close();
    });
    const unwatchFriends = useFriendStore.subscribe((state, previousState) => {
      const ids = (friends: typeof state.friends) => friends.map((friend) => friend.user_id).sort().join(",");
      if (ids(state.friends) !== ids(previousState.friends)||friendshipSnapshotKey(state)!==friendshipSnapshotKey(previousState)) close();
    });
    return () => { unwatchPreferences(); unwatchAccount(); unwatchFriends(); };
  }, [close]);

  if (!item) return null;
  return createPortal(
    <LightboxDialog
      item={item}
      itemCount={itemCount}
      index={index}
      onClose={close}
      onNext={next}
      onPrevious={previous}
    />,
    document.body
  );
}

function LightboxDialog({
  item,
  itemCount,
  index,
  onClose,
  onNext,
  onPrevious,
}: Readonly<{
  item: LightboxItem;
  itemCount: number;
  index: number;
  onClose: () => void;
  onNext: () => void;
  onPrevious: () => void;
}>) {
  const { t } = useTranslation("chat");
  const { t: tCommon } = useTranslation("common");
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const prevFocusRef = useRef<Element | null>(null);
  const forwardFocusRef = useRef<HTMLElement | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [menuOpen, setMenuOpen] = useState(false);
  const [forwardOpen, setForwardOpen] = useState(false);
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const gestureRef = useRef<{ kind: "pinch" | "drag" | "swipe"; startX: number; startY: number; distance?: number; zoom?: number } | null>(null);

  const openForward = () => {
    forwardFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMenuOpen(false);
    setForwardOpen(true);
  };
  const closeForward = () => setForwardOpen(false);

  useEffect(() => {
    if (!forwardOpen && forwardFocusRef.current?.isConnected) {
      forwardFocusRef.current.focus();
      forwardFocusRef.current = null;
    }
  }, [forwardOpen]);

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

  useEffect(() => {
    const pointers = pointersRef.current;
    // Gallery changes can happen mid-gesture; do not carry pointer state into
    // the next image or let the old gesture continue moving it.
    pointers.clear();
    gestureRef.current = null;
    dragRef.current = null;
    queueMicrotask(() => {
      setZoom(1);
      setOffset({ x: 0, y: 0 });
    });
    return () => {
      pointers.clear();
      gestureRef.current = null;
      dragRef.current = null;
    };
  }, [item]);

  // Keep viewer focus and scroll ownership for its full mount lifetime. The
  // nested forward dialog can open and close without restarting this effect.
  useEffect(() => {
    prevFocusRef.current = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = requestAnimationFrame(() => closeBtnRef.current?.focus());
    return () => {
      cancelAnimationFrame(focusFrame);
      document.body.style.overflow = previousOverflow;
      if (prevFocusRef.current instanceof HTMLElement) prevFocusRef.current.focus();
    };
  }, []);

  // Keyboard commands follow the nested-dialog state without re-running the
  // mount-only focus and scroll lifecycle above.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target;
      const isEditing = target instanceof HTMLElement && (
        target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
      );
      if (isEditing) return;
      // A nested forward dialog owns its Escape key; do not close both dialogs.
      if (e.key === "Escape") {
        if (forwardOpen) setForwardOpen(false);
        else onClose();
        return;
      }
      if (forwardOpen) return;
      if (e.key === "ArrowLeft") onPrevious();
      if (e.key === "ArrowRight") onNext();
      if (e.key === "+" || e.key === "=") setZoom((value) => Math.min(4, value + 0.25));
      if (e.key === "-") setZoom((value) => {
        const nextZoom = Math.max(1, value - 0.25);
        if (nextZoom === 1) setOffset({ x: 0, y: 0 });
        return nextZoom;
      });
      if (e.key === "0") {
        setZoom(1);
        setOffset({ x: 0, y: 0 });
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [forwardOpen, onClose, onNext, onPrevious]);

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
        <div className="image-lightbox-caption">
          <div className="image-lightbox-author-row">
            {item.authorAvatarUrl && <img className="image-lightbox-avatar" src={resolveAvatarUrl(item.authorAvatarUrl)} alt="" />}
            <div className="image-lightbox-caption-text">
              <span className="image-lightbox-filename" title={item.filename}>{item.filename}</span>
              {(item.authorName || item.createdAt) && (
                <span className="image-lightbox-meta">
                  {[item.authorName, item.createdAt ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(item.createdAt)) : null].filter(Boolean).join(" · ")}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="image-lightbox-zoom" aria-label={t("lightboxZoomControls")}>
          <button type="button" onClick={() => setZoom((value) => {
            const nextZoom = Math.max(1, value - 0.25);
            if (nextZoom === 1) setOffset({ x: 0, y: 0 });
            return nextZoom;
          })} disabled={zoom <= 1} aria-label={t("lightboxZoomOut")}>−</button>
          <button type="button" onClick={() => { setZoom(1); setOffset({ x: 0, y: 0 }); }} aria-label={t("lightboxResetZoom")}>{Math.round(zoom * 100)}%</button>
          <button type="button" onClick={() => setZoom((value) => Math.min(4, value + 0.25))} disabled={zoom >= 4} aria-label={t("lightboxZoomIn")}>+</button>
        </div>
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
        {item.message && (
          <button type="button" className="image-lightbox-action" onClick={openForward}>{t("forwardMessage")}</button>
        )}
        <div className="image-lightbox-menu-wrap">
          <button type="button" className="image-lightbox-action" aria-label={t("mediaActions")} aria-expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)}>⋯</button>
          {menuOpen && <div className="image-lightbox-menu" role="menu">
            {item.message && <button role="menuitem" onClick={openForward}>{t("forwardMessage")}</button>}
            {href && <a role="menuitem" href={href} target="_blank" rel="noopener noreferrer">{t("lightboxOpenOriginal")}</a>}
            {href && <a role="menuitem" href={href} download={item.filename}>{t("lightboxDownload")}</a>}
          </div>}
        </div>
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
          <div
            className="image-lightbox-stage"
            onClick={(e) => e.stopPropagation()}
            onWheel={(e) => {
              e.preventDefault();
              setZoom((value) => {
                const nextZoom = Math.max(1, Math.min(4, value + (e.deltaY < 0 ? 0.25 : -0.25)));
                if (nextZoom === 1) setOffset({ x: 0, y: 0 });
                return nextZoom;
              });
            }}
            onPointerDown={(e) => {
              pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
              if (pointersRef.current.size === 2) {
                const points = [...pointersRef.current.values()];
                const dx = points[0].x - points[1].x;
                const dy = points[0].y - points[1].y;
                gestureRef.current = { kind: "pinch", startX: e.clientX, startY: e.clientY, distance: Math.hypot(dx, dy), zoom };
                dragRef.current = null;
              } else {
                const kind = zoom > 1 ? "drag" : "swipe";
                gestureRef.current = { kind, startX: e.clientX, startY: e.clientY };
                if (kind === "drag") {
                  dragRef.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
                  e.currentTarget.setPointerCapture?.(e.pointerId);
                }
              }
            }}
            onPointerMove={(e) => {
              if (pointersRef.current.has(e.pointerId)) pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
              const gesture = gestureRef.current;
              if (gesture?.kind === "pinch" && pointersRef.current.size >= 2 && gesture.distance) {
                const points = [...pointersRef.current.values()];
                const dx = points[0].x - points[1].x;
                const dy = points[0].y - points[1].y;
                const nextZoom = Math.max(1, Math.min(4, (gesture.zoom ?? 1) * Math.hypot(dx, dy) / gesture.distance));
                setZoom(nextZoom);
                if (nextZoom === 1) setOffset({ x: 0, y: 0 });
                return;
              }
              const drag = dragRef.current;
              if (!drag || drag.pointerId !== e.pointerId) return;
              const limit = Math.max(0, 800 * (zoom - 1));
              setOffset((value) => ({
                x: Math.max(-limit, Math.min(limit, value.x + e.clientX - drag.x)),
                y: Math.max(-limit, Math.min(limit, value.y + e.clientY - drag.y)),
              }));
              dragRef.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
            }}
            onPointerUp={(e) => {
              const gesture = gestureRef.current;
              const start = pointersRef.current.get(e.pointerId);
              if (gesture?.kind === "swipe" && start && pointersRef.current.size === 1) {
                const deltaX = e.clientX - gesture.startX;
                const deltaY = e.clientY - gesture.startY;
                if (Math.abs(deltaX) > 60 && Math.abs(deltaX) > Math.abs(deltaY) * 1.25) {
                  if (deltaX < 0) onNext(); else onPrevious();
                }
              }
              pointersRef.current.delete(e.pointerId);
              if (pointersRef.current.size < 2) gestureRef.current = null;
              dragRef.current = null;
            }}
            onPointerCancel={(e) => {
              pointersRef.current.delete(e.pointerId);
              gestureRef.current = null;
              dragRef.current = null;
            }}
          >
            <img
              src={src}
              alt={item.filename}
              className="image-lightbox-img"
              style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }}
              onError={item.kind === "remote" ? retry.handleError : undefined}
              referrerPolicy={remote?.noReferrer ? "no-referrer" : undefined}
              draggable={false}
            />
          </div>
        )
      )}
      {itemCount > 1 && (
        <>
          <button type="button" className="image-lightbox-nav image-lightbox-nav--previous" onClick={(e) => { e.stopPropagation(); onPrevious(); }} aria-label={t("lightboxPrevious")}>‹</button>
          <span className="image-lightbox-counter" onClick={(e) => e.stopPropagation()}>{index + 1} / {itemCount}</span>
          <button type="button" className="image-lightbox-nav image-lightbox-nav--next" onClick={(e) => { e.stopPropagation(); onNext(); }} aria-label={t("lightboxNext")}>›</button>
        </>
      )}
      {forwardOpen && item.message && <ForwardMessageModal message={item.message} onClose={closeForward} />}
    </div>
  );
}

function resolveAvatarUrl(value: string): string {
  if (/^(?:https?:|blob:|data:)/i.test(value)) return value;
  return value.startsWith("/") ? value : `/${value}`;
}

export default ImageLightbox;
