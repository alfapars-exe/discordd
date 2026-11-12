import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import ScreenPicker from "./ScreenPicker";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../stores/voiceStore", () => ({
  useVoiceStore: (select: (state: object) => unknown) => select({ screenShareAudio: false }),
}));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("opens on the populated source group and preserves a usable tab on reopen", () => {
  let show!: (sources: { id: string; name: string; thumbnail: string }[]) => void;
  vi.stubGlobal("electronAPI", {
    onShowScreenPicker: (callback: typeof show) => { show = callback; },
    sendScreenPickerResult: vi.fn(),
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
  const windowSource = { id: "window:1", name: "Editor", thumbnail: "" };
  const screenSource = { id: "screen:1", name: "Monitor", thumbnail: "" };
  act(() => show([windowSource]));
  fireEvent.click(screen.getByRole("button", { name: "Editor" }));
  act(() => show([screenSource, windowSource]));
  fireEvent.click(screen.getByRole("button", { name: "Editor" }));
  act(() => show([screenSource]));
  expect(screen.getByRole("button", { name: "Monitor" })).toBeVisible();
});
