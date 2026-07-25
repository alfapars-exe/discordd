/**
 * Toast — Single toast notification with type-colored left border and enter animation.
 */

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { ToastAction } from "../../stores/toastStore";

type ToastProps = {
  id: string;
  type: "success" | "error" | "warning" | "info";
  message: string;
  /** Optional bold title above the message — falls back to plain message-only layout. */
  title?: string;
  action?: ToastAction;
  isExiting: boolean;
  onDismiss: (id: string) => void;
};

function Toast({ id, type, message, title, action, isExiting, onDismiss }: Readonly<ToastProps>) {
  const { t } = useTranslation("common");
  const handleDismiss = useCallback(() => {
    onDismiss(id);
  }, [id, onDismiss]);

  const toastClass = `toast toast-${type} toast-border-${type}${isExiting ? " toast-exiting" : ""}`;
  // error/warning are urgent (assertive) — success/info shouldn't interrupt screen reader users.
  const role = type === "error" || type === "warning" ? "alert" : "status";

  return (
    <div className={toastClass} role={role}>
      {/* Icon */}
      <div className="toast-icon">
        <ToastIcon type={type} />
      </div>

      {/* Message (+ optional title / action button) */}
      <div className="toast-body">
        {title && <div className="toast-title">{title}</div>}
        <span className="toast-message">{message}</span>
        {action && (
          <button type="button" onClick={action.onClick} className="toast-action">
            {action.label}
          </button>
        )}
      </div>

      {/* Dismiss */}
      <button type="button" onClick={handleDismiss} className="toast-close" aria-label={t("close")}>
        ✕
      </button>
    </div>
  );
}

/** Icon per toast type. */
function ToastIcon({ type }: { type: ToastProps["type"] }) {
  switch (type) {
    case "success":
      return (
        <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      );
    case "error":
      return (
        <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 9.75l4.5 4.5m0-4.5l-4.5 4.5M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      );
    case "warning":
      return (
        <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
        </svg>
      );
    case "info":
      return (
        <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
        </svg>
      );
  }
}

export default Toast;
