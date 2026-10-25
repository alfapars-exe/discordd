import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../i18n/locales/en/settings.json";
import tr from "../../i18n/locales/tr/settings.json";
import VoiceSettings from "./VoiceSettings";
import NoiseReductionSection from "./voice/NoiseReductionSection";

const mocks = vi.hoisted(() => ({
  state: {
    inputMode: "voice_activity", micProfile: "konusma", micSensitivity: 50,
    inputDevice: "", outputDevice: "", masterVolume: 100, inputVolume: 100,
    soundsEnabled: true, screenShareShowCursor: true, noiseReduction: true,
    voiceOverlayEnabled: true, voiceOverlayMode: "desktop", voiceOverlaySpeakingOpacity: 100, voiceOverlayIdleOpacity: 35,
    voiceOverlayScale: 100, voiceOverlayPosition: "bottom-left", voiceOverlaySpeakingOnly: false,
    voiceOverlayPinned: false,
    voiceOverlayQuickActions: false, voiceOverlayClickableActions: false, voiceOverlayCompatibility: false,
    voiceOverlayActivity: false, voiceOverlayVideo:false,voiceOverlayStreams:false,
    voiceOverlayWelcome: false, voiceOverlayGoLive: false,
    voiceOverlayNotifications: false,
    voiceOverlayNotificationActions: false,
    voiceOverlayChat: false, voiceOverlayChatActions: false, voiceOverlayChatCompose: false,
    voiceOverlayAvatarSize: "small", voiceOverlayNameDisplay: "always", voiceOverlayMaxParticipants: 25,
    noiseReductionEngine: "rnnoise", noiseSuppressionLevel: "medium", deepfilterSuppression: 70,
    setInputMode: vi.fn(), setMicSensitivity: vi.fn(), setInputDevice: vi.fn(),
    setOutputDevice: vi.fn(), setMasterVolume: vi.fn(), setInputVolume: vi.fn(),
    setSoundsEnabled: vi.fn(), setScreenShareShowCursor: vi.fn(), setNoiseReduction: vi.fn(),
    setNoiseReductionEngine: vi.fn(), setNoiseSuppressionLevel: vi.fn(), setDeepfilterSuppression: vi.fn(),
    setVoiceOverlayMode: vi.fn(), setVoiceOverlayAvatarSize: vi.fn(), setVoiceOverlayNameDisplay: vi.fn(), setVoiceOverlayMaxParticipants: vi.fn(),
    setVoiceOverlayPinned: vi.fn(), setVoiceOverlayPosition: vi.fn(), setVoiceOverlayScale: vi.fn(),
    setVoiceOverlayQuickActions: vi.fn(), setVoiceOverlayClickableActions: vi.fn(), setVoiceOverlayCompatibility: vi.fn(),
    setVoiceOverlayActivity: vi.fn(),setVoiceOverlayVideo:vi.fn(),setVoiceOverlayStreams:vi.fn(),
    setVoiceOverlayWelcome: vi.fn(), setVoiceOverlayGoLive: vi.fn(),
    setVoiceOverlayNotifications: vi.fn(),
    setVoiceOverlayNotificationActions: vi.fn(),
    setVoiceOverlayChatCompose: vi.fn(),
  },
  status: null as null | {
    requestedEngine: string; activeEngine: string | null; phase: "loading" | "ready" | "fallback" | "error";
    errorCode?: "browser-noise-suppression-locked";
    sampleRate: number; gateAvailable: boolean; gateEnabled?: boolean; gainAvailable?: boolean; inputDb: number; outputDb: number; gateOpen: boolean;
  },
  testError: undefined as string | undefined,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, values?: Record<string, string | number>) => {
  const value = key.split(".").reduce<unknown>((current, part) => (current as Record<string, unknown>)?.[part], en);
  return typeof value === "string" ? value.replace(/\{\{(\w+)\}\}/g, (_, name) => String(values?.[name] ?? "")) : key;
} }) }));
vi.mock("../../stores/voiceStore", () => ({ useVoiceStore: Object.assign(
  (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
  { getState: () => mocks.state },
) }));
vi.mock("../../hooks/useAudioDevices", () => ({ useAudioDevices: () => ({ audioInputs: [], audioOutputs: [] }) }));
vi.mock("../../hooks/useMicTest", () => ({ useMicTest: () => ({ isTesting: false, toggleTesting: vi.fn(), micLevel: 0, error: mocks.testError }) }));
vi.mock("../../audio/pipelineStatus", () => ({ useMicrophoneStatus: () => mocks.status }));
vi.mock("./voice/PTTKeySection", () => ({ default: () => null }));
vi.mock("./voice/MuteHotkeySection", () => ({ default: () => null }));
vi.mock("./voice/MicProfileSection", () => ({ default: () => null }));
vi.mock("./voice/CameraSection", () => ({ default: () => null }));

beforeEach(() => {
  delete window.electronAPI;
  vi.clearAllMocks();
  Object.assign(mocks.state, { voiceOverlayCompatibility:false, noiseReduction: true, noiseReductionEngine: "rnnoise", inputMode: "voice_activity", micProfile: "konusma", micSensitivity: 50 });
  mocks.status = null;
  mocks.testError = undefined;
});
afterEach(() => {
  cleanup();
  delete window.electronAPI;
});

describe("voice processing settings", () => {
  it("shows all six free engines and keeps the paid option hidden", () => {
    render(<NoiseReductionSection />);
    const picker = screen.getByRole("combobox", { name: en.noiseReductionEngine });
    expect(within(picker).getAllByRole("option").map((option) => (option as HTMLOptionElement).value)).toEqual(["rnnoise", "deepfilter", "gtcrn", "dtln", "speex", "webrtc"]);
    expect(screen.queryByText(/krisp/i)).not.toBeInTheDocument();
    fireEvent.change(picker, { target: { value: "gtcrn" } });
    expect(mocks.state.setNoiseReductionEngine).toHaveBeenCalledWith("gtcrn");
  });

  it.each(["gtcrn", "dtln"])("explains the 16 kHz limit for %s", (engine) => {
    mocks.state.noiseReductionEngine = engine;
    render(<NoiseReductionSection />);
    expect(screen.getByText(en.nrNarrowbandCaveat)).toBeInTheDocument();
  });

  it("keeps the energy gate available when model suppression is off", () => {
    mocks.state.noiseReduction = false;
    render(<NoiseReductionSection />);
    expect(screen.queryByRole("combobox", { name: en.noiseReductionEngine })).not.toBeInTheDocument();
    const gate = screen.getByRole("combobox", { name: en.noiseSuppressionLevel });
    expect(gate).toBeEnabled();
    fireEvent.change(gate, { target: { value: "high" } });
    expect(mocks.state.setNoiseSuppressionLevel).toHaveBeenCalledWith("high");
  });

  it.each(["music", "sensitivity"])("explains gate bypass for %s", (reason) => {
    if (reason === "music") mocks.state.micProfile = "muzik";
    if (reason === "sensitivity") mocks.state.micSensitivity = 100;
    render(<NoiseReductionSection />);
    expect(screen.getByRole("combobox", { name: en.noiseSuppressionLevel })).toBeDisabled();
    expect(screen.getByText(en.gateBypassedDesc)).toBeInTheDocument();
  });

  it("reports the running fallback engine and gate output instead of claiming the requested engine works", () => {
    mocks.status = { requestedEngine: "deepfilter", activeEngine: "rnnoise", phase: "fallback", sampleRate: 48000, gateAvailable: true, inputDb: -35.2, outputDb: -Infinity, gateOpen: false };
    render(<VoiceSettings />);
    expect(screen.getByRole("status")).toHaveTextContent(`Selected: ${en.nrEngineDeepfilter}`);
    expect(screen.getByRole("status")).toHaveTextContent(`Running: ${en.nrEngineRnnoise}`);
    expect(screen.getByRole("status")).toHaveTextContent("Fallback active");
    expect(screen.getByText(/Input: -35.2 dBFS · Output: −∞ dBFS/)).toHaveTextContent(en.audioPipelineGateClosed);
  });

  it("shows loading and test failure without exposing internal error text", () => {
    mocks.status = { requestedEngine: "gtcrn", activeEngine: null, phase: "loading", sampleRate: 48000, gateAvailable: false, inputDb: -Infinity, outputDb: -Infinity, gateOpen: false };
    mocks.testError = "Internal device identifier and worklet stack";
    render(<VoiceSettings />);
    expect(screen.getByRole("status")).toHaveTextContent("Preparing");
    expect(screen.getByRole("status")).toHaveTextContent("Running: Not active yet");
    expect(screen.getByRole("alert")).toHaveTextContent(en.micTestFailed);
    expect(screen.queryByText(mocks.testError)).not.toBeInTheDocument();
  });

  it("states when requested browser suppression is unavailable while retaining gate status", () => {
    mocks.status = { requestedEngine: "webrtc", activeEngine: "none", phase: "fallback", sampleRate: 48000, gateAvailable: true, gateEnabled: true, inputDb: -40, outputDb: -40, gateOpen: true };
    render(<VoiceSettings />);
    expect(screen.getByRole("status")).toHaveTextContent(`Selected: ${en.nrEngineWebrtc}`);
    expect(screen.getByRole("status")).toHaveTextContent(`Running: ${en.audioPipelineUnprocessed}`);
    expect(screen.getByRole("status")).not.toHaveTextContent(`Running: ${en.nrEngineWebrtc}`);
    expect(screen.getByText(en.audioPipelineNoSuppressionDesc)).toBeInTheDocument();
    expect(screen.getByText(/Input: -40.0 dBFS/)).toHaveTextContent(en.audioPipelineGateOpen);
  });

  it.each([true, false])("distinguishes configured gate bypass from capability availability=%s", (available) => {
    mocks.status = { requestedEngine: "none", activeEngine: "none", phase: "ready", sampleRate: 48000, gateAvailable: available, gateEnabled: false, inputDb: -40, outputDb: -40, gateOpen: true };
    render(<VoiceSettings />);
    expect(screen.getByText(/Input: -40.0 dBFS/)).toHaveTextContent(available ? en.audioPipelineGateBypassed : en.audioPipelineGateUnavailable);
  });

  it("disables unavailable software gain without changing the saved volume and restores the control", () => {
    mocks.status = { requestedEngine: "rnnoise", activeEngine: "webrtc", phase: "fallback", sampleRate: 44100, gateAvailable: false, gainAvailable: false, inputDb: -120, outputDb: -120, gateOpen: false };
    const { rerender } = render(<VoiceSettings />);
    const inputVolume = screen.getByRole("slider", { name: en.inputVolume });
    expect(inputVolume).toBeDisabled();
    expect(inputVolume).toHaveValue(String(mocks.state.inputVolume));
    expect(screen.getByText(en.audioPipelineGainUnavailable)).toBeInTheDocument();
    expect(mocks.state.setInputVolume).not.toHaveBeenCalled();
    mocks.status = { ...mocks.status, gainAvailable: true };
    rerender(<VoiceSettings />);
    expect(inputVolume).toBeEnabled();
    expect(screen.queryByText(en.audioPipelineGainUnavailable)).not.toBeInTheDocument();
    expect(mocks.state.setInputVolume).not.toHaveBeenCalled();
  });

  it("explains why a locked browser filter prevented the selected software engine", () => {
    mocks.status = { requestedEngine: "gtcrn", activeEngine: "webrtc", phase: "fallback", errorCode: "browser-noise-suppression-locked", sampleRate: 48000, gateAvailable: true, gainAvailable: true, inputDb: -40, outputDb: -40, gateOpen: true };
    render(<VoiceSettings />);
    expect(screen.getByText(en.audioPipelineDoubleSuppressionDesc)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(`Running: ${en.nrEngineWebrtc}`);
  });

  it("feeds the saved voice-widget options into the labeled preview", () => {
    Object.assign(mocks.state, {
      voiceOverlayScale: 130, voiceOverlayPosition: "top-right", voiceOverlaySpeakingOnly: true,
      voiceOverlayMode: "game",
      voiceOverlayAvatarSize: "large", voiceOverlayNameDisplay: "speaking", voiceOverlayMaxParticipants: 5,
    });
    render(<VoiceSettings />);
    const preview = screen.getByRole("img", { name: en.voiceOverlayPreviewAria });
    expect(screen.getByText(en.voiceOverlayPreviewSample)).toBeInTheDocument();
    expect(preview).toHaveClass("position-top-right");
    expect(preview).toHaveAttribute("data-overlay-mode", "game");
    expect(preview.querySelector(".voice-widget-preview-widget")).toHaveStyle({ transform: "scale(1.3)", transformOrigin: "top right" });
    expect(within(preview).getByText(en.voiceOverlaySampleUserOne)).toBeInTheDocument();
    expect(within(preview).queryByText(en.voiceOverlaySampleUserTwo)).not.toBeInTheDocument();
    expect(preview.querySelector(".voice-widget-preview-widget")).toHaveAttribute("data-avatar-size", "large");
    expect(screen.getByRole("combobox", { name: en.voiceOverlayAvatarSize })).toHaveValue("large");
    expect(screen.getByRole("combobox", { name: en.voiceOverlayMode })).toHaveValue("game");
    expect(screen.getByRole("combobox", { name: en.voiceOverlayNameDisplay })).toHaveValue("speaking");
    const maxParticipants = screen.getByRole("slider", { name: en.voiceOverlayMaxParticipantsLabel });
    expect(maxParticipants).toHaveValue("5");
    fireEvent.change(maxParticipants, { target: { value: "0" } });
    expect(mocks.state.setVoiceOverlayMaxParticipants).toHaveBeenCalledWith(0);
    fireEvent.change(screen.getByRole("combobox", { name: en.voiceOverlayAvatarSize }), { target: { value: "small" } });
    expect(mocks.state.setVoiceOverlayAvatarSize).toHaveBeenCalledWith("small");
    fireEvent.change(screen.getByRole("combobox", { name: en.voiceOverlayMode }), { target: { value: "desktop" } });
    expect(mocks.state.setVoiceOverlayMode).toHaveBeenCalledWith("desktop");
    fireEvent.change(screen.getByRole("combobox", { name: en.voiceOverlayNameDisplay }), { target: { value: "never" } });
    expect(mocks.state.setVoiceOverlayNameDisplay).toHaveBeenCalledWith("never");
  });

  it("offers the separate default-off device-local chat composer opt-in", () => {
    render(<VoiceSettings />);
    const toggle = screen.getByRole("checkbox", { name: en.voiceOverlayChatCompose });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(mocks.state.setVoiceOverlayChatCompose).toHaveBeenCalledWith(true);
    expect(screen.getByText(en.voiceOverlayChatComposeDesc)).toBeInTheDocument();
    expect(en.voiceOverlayChatComposeDesc).toContain("Requires Show recent chat and Allow opening chat in the app");
    expect(tr.voiceOverlayChatComposeDesc).toContain("Son sohbeti göster ve Sohbeti uygulamada aç izinleri");
    expect(en.voiceOverlayChatActionsDesc).toContain("grants permission for focused chat actions");
  });

  it("exposes device-local pin and disables native reset outside Electron", () => {
    render(<VoiceSettings />);
    const pin = screen.getByRole("checkbox", { name: en.voiceOverlayPinned });
    fireEvent.click(pin);
    expect(mocks.state.setVoiceOverlayPinned).toHaveBeenCalledWith(true);
    expect(screen.getByRole("button", { name: en.voiceOverlayResetLayout })).toBeDisabled();
    expect(screen.getByText(en.voiceOverlayResetUnsupported)).toBeInTheDocument();
  });

  it("keeps quick actions separate from click-through action consent", () => {
    render(<VoiceSettings />);
    fireEvent.click(screen.getByRole("checkbox", { name: en.voiceOverlayQuickActions }));
    fireEvent.click(screen.getByRole("checkbox", { name: en.voiceOverlayClickableActions }));
    expect(mocks.state.setVoiceOverlayQuickActions).toHaveBeenCalledWith(true);
    expect(mocks.state.setVoiceOverlayClickableActions).toHaveBeenCalledWith(true);
    expect(screen.getByText(en.voiceOverlayQuickActionsDesc)).toBeInTheDocument();
    expect(screen.getByText(en.voiceOverlayClickableActionsDesc)).toHaveTextContent(/only its mute and deafen buttons/i);
  });

  it("offers activity display without implying local process detection or fake joins", () => {
    render(<VoiceSettings />);
    fireEvent.click(screen.getByRole("checkbox", { name: en.voiceOverlayActivity }));
    expect(mocks.state.setVoiceOverlayActivity).toHaveBeenCalledWith(true);
    expect(screen.getByText(en.voiceOverlayActivityDesc)).toHaveTextContent(/never reads this device's process list/i);
    expect(screen.getByText(en.voiceOverlayActivityDesc)).toHaveTextContent(/does not show live activity/i);
  });

  it("offers read-only unread indicators without decrypted previews", () => {
    render(<VoiceSettings />);
    fireEvent.click(screen.getByRole("checkbox", { name: en.voiceOverlayNotifications }));
    expect(mocks.state.setVoiceOverlayNotifications).toHaveBeenCalledWith(true);
    expect(screen.getByText(en.voiceOverlayNotificationsDesc)).toHaveTextContent(/No decrypted message text or preview is sent/i);
    expect(screen.getByText(en.voiceOverlayNotificationsDesc)).toHaveTextContent(/not shown in the web preview/i);
  });

  it("keeps inbox and exact-source reply preparation behind a separate device-only opt-in", () => {
    render(<VoiceSettings />);
    fireEvent.click(screen.getByRole("checkbox", { name: en.voiceOverlayNotificationActions }));
    expect(mocks.state.setVoiceOverlayNotificationActions).toHaveBeenCalledWith(true);
    expect(screen.getByText(en.voiceOverlayNotificationActionsDesc)).toHaveTextContent(/reply to the exact message in the main chat/i);
    expect(screen.getByText(en.voiceOverlayNotificationActionsDesc)).toHaveTextContent(/nothing is sent automatically/i);
    expect(screen.getByText(en.voiceOverlayNotificationActionsDesc)).toHaveTextContent(/existing drafts are preserved/i);
    expect(screen.getByText(en.voiceOverlayNotificationActionsDesc)).toHaveTextContent(/separate device-only opt-in/i);
    expect(mocks.state.setVoiceOverlayClickableActions).not.toHaveBeenCalled();
    expect(mocks.state.setVoiceOverlayWelcome).not.toHaveBeenCalled();
    expect(mocks.state.setVoiceOverlayGoLive).not.toHaveBeenCalled();
  });

  it("resets only position and scale after native success", async () => {
    const resetOverlayLayout = vi.fn().mockResolvedValue(true);
    Object.defineProperty(window, "electronAPI", { configurable: true, value: { resetOverlayLayout } });
    Object.assign(mocks.state, { voiceOverlayPosition: "top-right", voiceOverlayScale: 140, masterVolume: 62, inputVolume: 80 });
    render(<VoiceSettings />);
    fireEvent.click(screen.getByRole("button", { name: en.voiceOverlayResetLayout }));
    await waitFor(() => expect(mocks.state.setVoiceOverlayPosition).toHaveBeenCalledWith("bottom-left"));
    expect(resetOverlayLayout).toHaveBeenCalledOnce();
    expect(mocks.state.setVoiceOverlayScale).toHaveBeenCalledWith(100);
    expect(mocks.state.setMasterVolume).not.toHaveBeenCalled();
    expect(mocks.state.setInputVolume).not.toHaveBeenCalled();
    expect(mocks.state.setVoiceOverlayPinned).not.toHaveBeenCalled();
    expect(await screen.findByRole("status")).toHaveTextContent(en.voiceOverlayResetSuccess);
    delete window.electronAPI;
  });

  it("keeps the current layout when native reset fails", async () => {
    const resetOverlayLayout = vi.fn().mockResolvedValue(false);
    Object.defineProperty(window, "electronAPI", { configurable: true, value: { resetOverlayLayout } });
    Object.assign(mocks.state, { voiceOverlayPosition: "top-right", voiceOverlayScale: 140 });
    render(<VoiceSettings />);
    fireEvent.click(screen.getByRole("button", { name: en.voiceOverlayResetLayout }));
    expect(await screen.findByRole("alert")).toHaveTextContent(en.voiceOverlayResetFailed);
    expect(mocks.state.setVoiceOverlayPosition).not.toHaveBeenCalled();
    expect(mocks.state.setVoiceOverlayScale).not.toHaveBeenCalled();
    delete window.electronAPI;
  });

  it("does not overwrite layout edits made while native reset is pending", async () => {
    let resolveReset!: (value: boolean) => void;
    const resetOverlayLayout = vi.fn(() => new Promise<boolean>((resolve) => { resolveReset = resolve; }));
    Object.defineProperty(window, "electronAPI", { configurable: true, value: { resetOverlayLayout } });
    Object.assign(mocks.state, { voiceOverlayPosition: "top-right", voiceOverlayScale: 135 });
    render(<VoiceSettings />);
    fireEvent.click(screen.getByRole("button", { name: en.voiceOverlayResetLayout }));
    Object.assign(mocks.state, { voiceOverlayPosition: "top-left", voiceOverlayScale: 120 });
    resolveReset(true);
    await screen.findByRole("status");
    expect(mocks.state.setVoiceOverlayPosition).not.toHaveBeenCalled();
    expect(mocks.state.setVoiceOverlayScale).not.toHaveBeenCalled();
    delete window.electronAPI;
  });

  it("persists a successful reset after unmount without updating component state", async () => {
    let resolveReset!: (value: boolean) => void;
    const resetOverlayLayout = vi.fn(() => new Promise<boolean>((resolve) => { resolveReset = resolve; }));
    Object.defineProperty(window, "electronAPI", { configurable: true, value: { resetOverlayLayout } });
    const view = render(<VoiceSettings />);
    fireEvent.click(screen.getByRole("button", { name: en.voiceOverlayResetLayout }));
    view.unmount();
    resolveReset(true);
    await Promise.resolve();
    await waitFor(() => expect(mocks.state.setVoiceOverlayPosition).toHaveBeenCalledWith("bottom-left"));
    expect(mocks.state.setVoiceOverlayScale).toHaveBeenCalledWith(100);
    delete window.electronAPI;
  });
});

it("offers actual read-only compatibility without losing stored interaction choices",()=>{const view=render(<VoiceSettings/>);fireEvent.click(screen.getByRole("checkbox",{name:en.voiceOverlayCompatibility}));expect(mocks.state.setVoiceOverlayCompatibility).toHaveBeenCalledWith(true);mocks.state.voiceOverlayCompatibility=true;view.rerender(<VoiceSettings/>);for(const label of [en.voiceOverlayPinned,en.voiceOverlayClickableActions,en.voiceOverlayNotificationActions,en.voiceOverlayChatActions,en.voiceOverlayChatCompose])expect(screen.getByRole("checkbox",{name:label})).toBeDisabled();expect(screen.getByRole("status")).toHaveTextContent(en.voiceOverlayCompatibilityActive);expect(en.voiceOverlayCompatibilityDesc).toContain("exclusive-fullscreen");expect(tr.voiceOverlayCompatibilityDesc).toContain("Özel tam ekran");expect(mocks.state.setVoiceOverlayClickableActions).not.toHaveBeenCalled();});

it("offers independent real video/source widgets with truthful current-call descriptions",()=>{render(<VoiceSettings/>);fireEvent.click(screen.getByRole("checkbox",{name:en.voiceOverlayVideo}));expect(mocks.state.setVoiceOverlayVideo).toHaveBeenCalledWith(true);fireEvent.click(screen.getByRole("checkbox",{name:en.voiceOverlayStreams}));expect(mocks.state.setVoiceOverlayStreams).toHaveBeenCalledWith(true);expect(screen.getByText(en.voiceOverlayVideoDesc)).toBeInTheDocument();expect(screen.getByText(en.voiceOverlayStreamsDesc)).toBeInTheDocument();expect(en.voiceOverlayStreamsDesc).toContain("already watching");expect(tr.voiceOverlayStreamsDesc).toContain("zaten izlediğin");});
