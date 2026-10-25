import { afterEach, expect, it, vi } from "vitest";
import { openFocusedContextMenu } from "./contextMenuShortcut";
afterEach(() => { document.body.replaceChildren(); });
it("uses the existing bubbling context handler and reports only acknowledged menus", () => {
  const row = document.createElement("article");
  const button = document.createElement("button");
  row.append(button); document.body.append(row); button.focus();
  expect(openFocusedContextMenu()).toBe(false);
  const handler = vi.fn((event: Event) => event.preventDefault());
  row.addEventListener("contextmenu", handler);
  expect(openFocusedContextMenu()).toBe(true);
  expect(handler).toHaveBeenCalledOnce();
});
it("does not open app menus while editing or inside another menu/dialog", () => {
  for (const wrapper of ["dialog", "div"]) {
    const parent = document.createElement(wrapper);
    if (wrapper === "dialog") parent.setAttribute("open", "");
    else parent.setAttribute("role", "menu");
    const button = document.createElement("button");
    parent.append(button); document.body.append(parent); button.focus();
    const handler = vi.fn((event: Event) => event.preventDefault());
    parent.addEventListener("contextmenu", handler);
    expect(openFocusedContextMenu()).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    parent.remove();
  }
  const input = document.createElement("input"); document.body.append(input); input.focus();
  expect(openFocusedContextMenu()).toBe(false);
  const editor = document.createElement("div"); editor.setAttribute("contenteditable", "plaintext-only"); editor.tabIndex = 0;
  document.body.append(editor); editor.focus();
  expect(openFocusedContextMenu()).toBe(false);
});
