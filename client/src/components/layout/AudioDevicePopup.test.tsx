import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import AudioDevicePopup from "./AudioDevicePopup";

const state = vi.hoisted(() => ({
  voice: { inputDevice: "default", outputDevice: "default", masterVolume: 75, inputVolume: 100, micSensitivity: 50,
    setInputDevice: vi.fn(), setOutputDevice: vi.fn(), setMasterVolume: vi.fn(), setInputVolume: vi.fn(), setMicSensitivity: vi.fn() },
  settings: { openSettings: vi.fn() },
}));
vi.mock("../../stores/voiceStore", () => ({ useVoiceStore: (select: (value: typeof state.voice) => unknown) => select(state.voice) }));
vi.mock("../../stores/settingsStore", () => ({ useSettingsStore: (select: (value: typeof state.settings) => unknown) => select(state.settings) }));
vi.mock("../../utils/uiShell", () => ({ UI_SHELL_V2: true }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }), initReactI18next: { type: "3rdParty", init: () => {} } }));

describe("audio device preferences", () => {
  let anchor: HTMLButtonElement;
  const getUserMedia = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    anchor = document.createElement("button");
    document.body.append(anchor);
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      enumerateDevices: vi.fn().mockResolvedValue([{ deviceId: "default", kind: "audioinput", label: "System microphone" }]),
      getUserMedia, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    } });
  });
  afterEach(() => anchor.remove());

  it("reads devices without opening another microphone and adjusts the real input gain", async () => {
    render(<AudioDevicePopup kind="input" anchorEl={anchor} onClose={vi.fn()} />);
    await screen.findByRole("dialog", { name: "inputDevice" });
    expect(getUserMedia).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("slider", { name: "micVolume" }), { target: { value: "120" } });
    expect(state.voice.setInputVolume).toHaveBeenCalledWith(120);
    fireEvent.click(screen.getByRole("button", { name: /inputDevice.*System microphone/ }));
    fireEvent.click(screen.getByRole("button", { name: "System microphone" }));
    expect(state.voice.setInputDevice).toHaveBeenCalledWith("default");
  });

  it("uses the first Escape for the nested device list and restores focus on close", async () => {
    const onClose = vi.fn();
    const view = render(<AudioDevicePopup kind="input" anchorEl={anchor} onClose={onClose} />);
    const header = await screen.findByRole("button", { name: /inputDevice.*System microphone/ });
    await waitFor(() => expect(header).toHaveFocus());
    fireEvent.click(header);
    fireEvent.keyDown(header, { key: "Escape" });
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(header, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount();
    expect(anchor).toHaveFocus();
  });

  it("offers real voice settings and exposes an empty-device state", async () => {
    vi.mocked(navigator.mediaDevices.enumerateDevices).mockResolvedValue([]);
    const onClose = vi.fn();
    render(<AudioDevicePopup kind="output" anchorEl={anchor} onClose={onClose} />);
    fireEvent.click(await screen.findByRole("button", { name: /outputDevice/ }));
    expect(screen.getByRole("status")).toHaveTextContent("noAudioDevices");
    fireEvent.click(screen.getByRole("button", { name: "voiceSettings" }));
    expect(state.settings.openSettings).toHaveBeenCalledWith("voice");
    expect(onClose).toHaveBeenCalledOnce();
  });
});
