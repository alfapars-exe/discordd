/** Shared boundary for application shortcuts and programmatic chat commands. */
export const SHORTCUT_MODAL_SELECTOR = "dialog[open], [role='dialog'], [aria-modal='true'], [role='menu'], .modal-backdrop, .report-overlay, .add-server-overlay, .new-conversation-overlay, .quick-switcher-overlay, .welcome-overlay, .ico-overlay, .sp-overlay, .screen-share-panel-overlay, .mod-picker-overlay, .crop-modal-backdrop, .download-prompt-overlay, .settings-overlay";

export function hasShortcutModalBoundary(): boolean {
  return document.querySelector(SHORTCUT_MODAL_SELECTOR) !== null;
}
