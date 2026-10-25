/** ConfirmDialog — Custom confirm dialog replacing window.confirm(). Reads from confirmStore, renders nothing when null. */

import { useId, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useConfirmStore } from "../../stores/confirmStore";

function ConfirmDialog() {
  const { t } = useTranslation("common");
  const options = useConfirmStore((s) => s.options);
  const confirmAction = useConfirmStore((s) => s.confirm);
  const cancelAction = useConfirmStore((s) => s.cancel);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const messageId = useId();

  useLayoutEffect(() => {
    if (!options) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const buttons = () => Array.from(dialog?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? []);
    buttons()[0]?.focus();
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); cancelAction();
      } else if (event.key === "Tab") {
        const controls = buttons();
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && (document.activeElement === first || !dialog?.contains(document.activeElement))) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !dialog?.contains(document.activeElement))) {
          event.preventDefault(); first?.focus();
        }
      }
    }
    function contain(event: FocusEvent) {
      if (!dialog?.contains(event.target as Node)) buttons()[0]?.focus();
    }
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("focusin", contain);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("focusin", contain);
      if (previous?.isConnected) previous.focus();
    };
  }, [options, cancelAction]);

  if (!options) return null;

  const confirmLabel = options.confirmLabel ?? t("confirm");
  const cancelLabel = options.cancelLabel ?? t("cancel");

  return createPortal(
    <div className="modal-backdrop" onClick={cancelAction}>
      <div ref={dialogRef} className="modal-card" role="alertdialog" aria-modal="true"
        aria-labelledby={options.title ? titleId : undefined} aria-label={options.title ? undefined : t("confirm")}
        aria-describedby={messageId} onClick={(e) => e.stopPropagation()}>
        {/* Title */}
        {options.title && (
          <div className="modal-header">
            <h2 id={titleId} className="modal-title">{options.title}</h2>
          </div>
        )}

        {/* Message */}
        <p id={messageId} className="modal-text">{options.message}</p>

        {/* Actions */}
        <div className="modal-actions">
          <button
            className="settings-btn settings-btn-secondary"
            onClick={cancelAction}
          >
            {cancelLabel}
          </button>
          <button
            className={`settings-btn${options.danger ? " settings-btn-danger" : ""}`}
            onClick={confirmAction}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

export default ConfirmDialog;
