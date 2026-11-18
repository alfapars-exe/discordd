const highlightTimers = new WeakMap<HTMLElement, number>();

export function highlightMessage(row: HTMLElement) {
  window.clearTimeout(highlightTimers.get(row));
  row.classList.add("msg-highlight");
  highlightTimers.set(row, window.setTimeout(() => {
    row.classList.remove("msg-highlight");
    highlightTimers.delete(row);
  }, 2000));
}
