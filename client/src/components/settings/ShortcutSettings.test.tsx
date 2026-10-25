import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import ShortcutSettings from "./ShortcutSettings";
import { useShortcutBindingsStore } from "../../stores/shortcutBindingsStore";
import { useShortcutCaptureStore } from "../../stores/shortcutCaptureStore";
import { resolveDefaultShortcut } from "../../utils/shortcutRegistry";
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../stores/voiceStore", () => ({ useVoiceStore: { getState: () => ({ inputMode: "push_to_talk", pttKey: "Space", muteHotkeyEnabled: false }) } }));
beforeEach(() => { useShortcutBindingsStore.setState({ bindings: {} }); });
it("records a device shortcut and releases the command suspension", () => {
  render(<ShortcutSettings />);
  fireEvent.click(screen.getAllByRole("button", { name: "shortcutRecord" })[0]);
  expect(useShortcutCaptureStore.getState().active).toBe(true);
  fireEvent.keyDown(document, { code: "F8", key: "F8" });
  expect(useShortcutBindingsStore.getState().bindings["shortcut-help"]?.code).toBe("F8");
  expect(useShortcutCaptureStore.getState().active).toBe(false);
});
it("keeps recording on invalid/conflicting chords and cancels without saving", () => {
  render(<ShortcutSettings />);
  fireEvent.click(screen.getAllByRole("button", { name: "shortcutRecord" })[0]);
  fireEvent.keyDown(document, { code: "ShiftLeft", key: "Shift", shiftKey: true });
  expect(screen.getByRole("alert")).toHaveTextContent("shortcutError_invalid");
  fireEvent.keyDown(document, { code: "KeyK", key: "k", ctrlKey: true });
  expect(screen.getByRole("alert")).toHaveTextContent("shortcutError_conflict");
  fireEvent.keyDown(document, { code: "Space", key: " ", ctrlKey: true });
  expect(screen.getByRole("alert")).toHaveTextContent("shortcutErrorVoiceConflict");
  fireEvent.keyDown(document, { code: "Escape", key: "Escape" });
  expect(useShortcutBindingsStore.getState().bindings).toEqual({});
  expect(useShortcutCaptureStore.getState().active).toBe(false);
});
it("separates disabling a command from resetting its custom binding", () => {
  render(<ShortcutSettings />);
  const helpField = screen.getByText("shortcutHelp").closest("fieldset")!;
  fireEvent.click(within(helpField).getByRole("button", { name: "shortcutDisable" }));
  expect(useShortcutBindingsStore.getState().bindings.disabledCommands).toContain("shortcut-help");
  expect(within(helpField).getByText("shortcutInactive")).toBeInTheDocument();
  expect(within(helpField).getByRole("button", { name: "shortcutEnable" })).toBeInTheDocument();

  fireEvent.click(within(helpField).getByRole("button", { name: "shortcutReset" }));
  const enabled = useShortcutBindingsStore.getState().bindings;
  expect(enabled.disabledCommands).toBeUndefined();
  expect(enabled["shortcut-help"]).toBeUndefined();
  expect(resolveDefaultShortcut(new KeyboardEvent("keydown", { code: "Slash", key: "/", ctrlKey: true }), false, enabled)).toBe("shortcut-help");

  const dragField = screen.getByText(/shortcutDragStart/).closest("fieldset")!;
  expect(within(dragField).queryByRole("button", { name: "shortcutDisable" })).not.toBeInTheDocument();
  const inboxField = screen.getByText(/shortcutReadTopInbox/).closest("fieldset")!;
  expect(within(inboxField).queryByRole("button", { name: "shortcutDisable" })).not.toBeInTheDocument();
});
