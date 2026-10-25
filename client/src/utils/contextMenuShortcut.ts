/** Dispatch through the focused element's existing, permission-filtered menu handler. */
export function openFocusedContextMenu(): boolean {
  const target = document.activeElement;
  if (!(target instanceof HTMLElement) || target === document.body ||
      target.isContentEditable || target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox'], dialog[open], [role='dialog'], [role='menu'], .settings-overlay, .modal-backdrop")) return false;
  const rect = target.getBoundingClientRect();
  const event = new MouseEvent("contextmenu", {
    bubbles: true, cancelable: true, button: 2,
    clientX: Math.max(0, Math.min(window.innerWidth - 8, rect.left + 8)),
    clientY: Math.max(0, Math.min(window.innerHeight - 8, rect.top + 8)),
  });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}
