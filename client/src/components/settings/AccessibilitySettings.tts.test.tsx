import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }), initReactI18next: { type: "3rdParty", init: () => {} } }));
import AccessibilitySettings from "./AccessibilitySettings";
import { useAccessibilityStore } from "../../stores/accessibilityStore";
afterEach(() => vi.unstubAllGlobals());
it("names TTS controls and disables them without a speech engine", () => {
  vi.stubGlobal("SpeechSynthesisUtterance", undefined);
  render(<AccessibilitySettings />);
  expect(screen.getByRole("slider", { name: "acc.ttsRate" })).toBeDisabled();
  expect(screen.getByRole("checkbox", { name: "acc.ttsEnabled" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "acc.ttsPreview" })).toBeDisabled();
});
it("changes the saved speech rate through the named slider", () => {
  vi.stubGlobal("SpeechSynthesisUtterance", class {});
  vi.stubGlobal("speechSynthesis", { speak: vi.fn(), cancel: vi.fn() });
  render(<AccessibilitySettings />);
  const slider = screen.getByRole("slider", { name: "acc.ttsRate" });
  expect(slider).not.toBeDisabled();
  fireEvent.change(slider, { target: { value: "1.7" } });
  expect(useAccessibilityStore.getState().ttsRate).toBe(1.7);
});
