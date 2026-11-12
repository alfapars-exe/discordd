import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import ScreenPicker from "./ScreenPicker";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../stores/voiceStore", () => ({
  useVoiceStore: (select: (state: object) => unknown) => select({ screenShareAudio: false }),
}));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function renderPicker() {
  let show!: (sources: { id: string; name: string; thumbnail: string }[]) => void;
  let dismiss!: () => void;
  const result = vi.fn();
  vi.stubGlobal("electronAPI", {
    onShowScreenPicker: (callback: typeof show) => { show = callback; },
    onScreenPickerDismissed: (callback: () => void) => { dismiss = callback; },
    sendScreenPickerResult: result,
  });
  const createElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag, options) => {
    const element = createElement(tag, options);
    if (element instanceof HTMLDialogElement) {
      element.showModal = () => { element.open = true; };
      element.close = () => { element.open = false; };
    }
    return element;
  });
  render(<ScreenPicker />);
  return { show, dismiss, result };
}

it("opens on the populated source group and preserves a usable tab on reopen", () => {
  const { show, dismiss, result } = renderPicker();
  const windowSource = { id: "window:1", name: "Editor", thumbnail: "" };
  const screenSource = { id: "screen:1", name: "Monitor", thumbnail: "" };
  act(() => show([windowSource]));
  fireEvent.click(screen.getByRole("button", { name: "Editor" }));
  act(() => show([screenSource, windowSource]));
  fireEvent.click(screen.getByRole("button", { name: "Editor" }));
  act(() => show([screenSource]));
  expect(screen.getByRole("button", { name: "Monitor" })).toBeVisible();
  act(() => dismiss());
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(result).toHaveBeenCalledTimes(2);
});

it.each(["backdrop", "cancel event"])("cancels once via %s and restores focus", (action) => {
  const opener = document.createElement("button");
  document.body.append(opener);
  try {
    opener.focus();
    const { show, result } = renderPicker();
    act(() => show([{ id: "window:1", name: "Editor", thumbnail: "" }]));
    const dialog = screen.getByRole("dialog");
    const source = screen.getByRole("button", { name: "Editor" });
    source.focus();
    fireEvent.click(screen.getByRole("heading"));
    expect(result).not.toHaveBeenCalled();
    if (action === "backdrop") {
      fireEvent.click(dialog.querySelector<HTMLButtonElement>(".sp-backdrop")!);
    } else {
      fireEvent(dialog, new Event("cancel", { cancelable: true }));
    }
    expect(result.mock.calls).toEqual([[null]]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
  } finally {
    opener.remove();
  }
});
