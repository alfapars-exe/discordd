import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import KeyboardShortcutHelp from "./KeyboardShortcutHelp";
import { useShortcutBindingsStore } from "../../stores/shortcutBindingsStore";

const fixture = vi.hoisted(() => ({ desktop: false, voice: { inputMode: "push_to_talk", pttKey: "Space", muteHotkeyEnabled: true, muteHotkey: "KeyV", muteHotkeyGlobal: true } }));
const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../utils/constants", () => ({ isElectron: () => fixture.desktop }));
vi.mock("../../stores/voiceStore", () => ({ useVoiceStore: (select: (state: typeof fixture.voice) => unknown) => select(fixture.voice) }));
vi.mock("../settings/ShortcutSettings", () => ({ default: () => null }));

beforeEach(() => {
  fixture.desktop = false;
  fixture.voice.inputMode = "push_to_talk";
  fixture.voice.muteHotkeyEnabled = true;
  fixture.voice.muteHotkeyGlobal = true;
  useShortcutBindingsStore.setState({ bindings: {} });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: vi.fn() });
});
afterEach(() => {
  cleanup();
  if (originalShow) Object.defineProperty(HTMLDialogElement.prototype, "showModal", originalShow);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, "close", originalClose);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
});

it("labels drag and message contexts separately and never advertises global web keys", () => {
  render(<KeyboardShortcutHelp onClose={() => {}} />);
  expect(screen.getByText(/shortcutDragStart/)).toHaveTextContent("shortcutDragFocus");
  expect(screen.getByText(/shortcutMessageEdit/)).toHaveTextContent("shortcutMessageFocus");
  expect(screen.getByText(/shortcutIncomingCallAnswer/)).toHaveTextContent("shortcutIncomingCallScope");
  expect(screen.getByText(/shortcutGroupCallStart/)).toHaveTextContent("shortcutVoiceScope");
  const section = within(screen.getByRole("region", { name: "shortcutDeviceVoice" }));
  expect(section.getByText("Space")).toBeInTheDocument();
  expect(section.getByText("V")).toBeInTheDocument();
  expect(section.getAllByText(/shortcutFocusedScope/)).toHaveLength(2);
  expect(section.queryByText(/shortcutGlobalConfigured/)).not.toBeInTheDocument();
});

it("describes native global bindings as configured, not verified active, and reflects disabled settings", () => {
  fixture.desktop = true;
  const view = render(<KeyboardShortcutHelp onClose={() => {}} />);
  expect(screen.getAllByText(/shortcutGlobalConfigured/)).toHaveLength(2);
  fixture.voice.inputMode = "voice_activity";
  fixture.voice.muteHotkeyEnabled = false;
  view.rerender(<KeyboardShortcutHelp onClose={() => {}} />);
  expect(within(screen.getByRole("region", { name: "shortcutDeviceVoice" })).getAllByText("shortcutInactive")).toHaveLength(2);
  expect(within(screen.getByText("shortcutOverlayLock").closest("div")!).getByText("shortcutInactive")).toBeInTheDocument();
  expect(screen.queryByText(/shortcutGlobalConfigured/)).not.toBeInTheDocument();
});

it("shows disabled custom commands as inactive in shortcut help", () => {
  useShortcutBindingsStore.setState({ bindings: { disabledCommands: ["chat-search"] } });
  render(<KeyboardShortcutHelp onClose={() => {}} />);
  const searchRow = screen.getByText("shortcutChatSearch").closest("div")!;
  expect(within(searchRow).getByText("shortcutInactive")).toBeInTheDocument();
  expect(within(searchRow).queryByRole("kbd")).not.toBeInTheDocument();
});
