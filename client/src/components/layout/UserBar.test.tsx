import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { P2PCall } from "../../types";
import UserBar from "./UserBar";
import { executeVoiceShortcut } from "../../hooks/useVoiceShortcutAction";
import { useShortcutCaptureStore } from "../../stores/shortcutCaptureStore";

const state = vi.hoisted(() => ({
  auth: { user: { id: "me", username: "me", display_name: "Me", avatar_url: null }, manualStatus: "online" },
  voice: { currentVoiceChannelId: "voice-a" as string | null, currentVoiceServerId: "server-a", isMuted: false, isDeafened: false, muteBeforeDeafen:null as boolean|null,
    isStreaming: false, isCameraEnabled: false, setCameraEnabled: vi.fn(), noiseReduction: true, setNoiseReduction: vi.fn(), rtt: 25 },
  server: { servers: [{ id: "server-a", name: "Server A", icon_url: null }, { id: "server-b", name: "Server B", icon_url: null }], activeServerId: "server-b" },
  channel: { categories: [{ channels: [{ id: "voice-b", name: "Voice B" }] }], categoriesByServer: { "server-a": [{ channels: [{ id: "voice-a", name: "Voice A" }] }] } },
  p2p: { activeCall: null as P2PCall | null },
  settings: { openSettings: vi.fn() },
  ui: { openTab: vi.fn() },
  soundboard: { isPanelOpen: false, togglePanel: vi.fn(), closePanel: vi.fn() },
}));
vi.mock("../../stores/authStore", () => { const getState = () => state.auth; return { useAuthStore: Object.assign((select: (value: typeof state.auth) => unknown) => select(state.auth), { getState }) }; });
vi.mock("../../stores/voiceStore", () => ({ useVoiceStore: Object.assign((select: (value: typeof state.voice) => unknown) => select(state.voice), { getState: () => state.voice }) }));
vi.mock("../../stores/serverStore", () => ({ useServerStore: Object.assign((select: (value: typeof state.server) => unknown) => select(state.server), { getState: () => state.server }) }));
vi.mock("../../stores/channelStore", () => ({ useChannelStore: (select: (value: typeof state.channel) => unknown) => select(state.channel) }));
vi.mock("../../stores/p2pCallStore", () => ({ useP2PCallStore: (select: (value: typeof state.p2p) => unknown) => select(state.p2p) }));
vi.mock("../../stores/settingsStore", () => ({ useSettingsStore: (select: (value: typeof state.settings) => unknown) => select(state.settings) }));
vi.mock("../../stores/uiStore", () => ({ useUIStore: (select: (value: typeof state.ui) => unknown) => select(state.ui) }));
vi.mock("../../stores/soundboardStore", () => ({ useSoundboardStore: Object.assign((select: (value: typeof state.soundboard) => unknown) => select(state.soundboard), { getState: () => state.soundboard }) }));
vi.mock("../../utils/uiShell", () => ({ UI_SHELL_V2: true }));
vi.mock("../../hooks/useDismissablePopup", () => ({ useDismissablePopup: () => {} }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }), initReactI18next: { type: "3rdParty", init: () => {} } }));
vi.mock("../shared/Avatar", () => ({ default: () => <span>Avatar</span> }));
vi.mock("../members/MemberCard", () => ({ default: () => null }));
vi.mock("./AudioDevicePopup", () => ({ default: () => null }));
vi.mock("../voice/ScreenShareQualityPopup", () => ({ default: () => null }));
vi.mock("../voice/VoiceConnectionStatus", () => ({ default: () => <span>Connected</span> }));
vi.mock("../soundboard/SoundboardPanel", () => ({ default: () => null }));
vi.mock("../p2p/P2PCallControls", () => ({ default: () => <span>Real P2P controls</span> }));

describe("persistent voice dock", () => {
  const actions = { onToggleMute: vi.fn(), onToggleDeafen: vi.fn(), onToggleScreenShare: vi.fn(), onDisconnect: vi.fn() };
  beforeEach(() => {
    vi.clearAllMocks();
    state.voice.currentVoiceChannelId = "voice-a";
    state.server.activeServerId = "server-b";
    state.p2p.activeCall = null;
    state.ui.openTab.mockReset();
    useShortcutCaptureStore.setState({ active: false });
  });

  it("returns to the connected server even after browsing another server, without ending the call", async () => {
    render(<UserBar {...actions} />);
    await screen.findByText("Connected");
    expect(screen.getByText("Server A / Voice A")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "returnToCall" }));
    expect(state.ui.openTab).toHaveBeenCalledWith("voice-a", "voice", "Voice A", {
      serverId: "server-a", serverName: "Server A", serverIconUrl: null,
    });
    expect(actions.onDisconnect).not.toHaveBeenCalled();
  });

  it("offers P2P return and its own controls instead of ineffective LiveKit audio controls", () => {
    state.voice.currentVoiceChannelId = null;
    state.p2p.activeCall = { id: "call", caller_id: "me", receiver_display_name: "Friend", receiver_username: "friend", status: "active" } as P2PCall;
    render(<UserBar {...actions} />);
    fireEvent.click(screen.getByRole("button", { name: "returnToCall" }));
    expect(state.ui.openTab).toHaveBeenCalledWith("call", "p2p", "Friend");
    expect(screen.getByText("Real P2P controls")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "selectMicrophoneDevice" })).not.toBeInTheDocument();
    expect(actions.onDisconnect).not.toHaveBeenCalled();
  });

  it("returns to the joined server before opening its soundboard after browsing elsewhere", async () => {
    state.ui.openTab.mockImplementation(() => { state.server.activeServerId = "server-a"; });
    render(<UserBar {...actions} />);
    fireEvent.click(screen.getByRole("button", { name: "soundboard" }));
    expect(state.ui.openTab).toHaveBeenCalledWith("voice-a", "voice", "Voice A", expect.objectContaining({ serverId: "server-a" }));
    await waitFor(() => expect(state.soundboard.togglePanel).toHaveBeenCalledOnce());
    expect(actions.onDisconnect).not.toHaveBeenCalled();
  });

  it("does not open sounds when a return-to-call navigation is rejected", async () => {
    render(<UserBar {...actions} />);
    fireEvent.click(screen.getByRole("button", { name: "soundboard" }));
    await screen.findByText("Connected");
    expect(state.soundboard.togglePanel).not.toHaveBeenCalled();
  });

  it("opens the soundboard with Ctrl+Shift+B only during an authenticated server voice call", async () => {
    state.ui.openTab.mockImplementation(() => { state.server.activeServerId = "server-a"; });
    render(<UserBar {...actions} />);
    const key = new KeyboardEvent("keydown", { key: "b", code: "KeyB", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
    expect(executeVoiceShortcut("voice-soundboard", key)).toBe(true);
    await waitFor(() => expect(state.soundboard.togglePanel).toHaveBeenCalledOnce());

    state.soundboard.togglePanel.mockClear();
    state.voice.currentVoiceChannelId = null;
    expect(executeVoiceShortcut("voice-soundboard", key)).toBe(false);
    expect(state.soundboard.togglePanel).not.toHaveBeenCalled();
  });

  it("does not open the soundboard while shortcut capture or a modal is active", () => {
    render(<UserBar {...actions} />);
    const key = new KeyboardEvent("keydown", { key: "b", code: "KeyB", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
    useShortcutCaptureStore.setState({ active: true });
    expect(executeVoiceShortcut("voice-soundboard", key)).toBe(false);
    useShortcutCaptureStore.setState({ active: false });
    const dialog = document.createElement("dialog"); dialog.setAttribute("open", ""); document.body.append(dialog);
    expect(executeVoiceShortcut("voice-soundboard", key)).toBe(false);
    dialog.remove();
    expect(state.soundboard.togglePanel).not.toHaveBeenCalled();
  });

it("describes queued microphone intent while keeping the effective mute indicator",()=>{
 state.voice.isMuted=true;state.voice.isDeafened=true;state.voice.muteBeforeDeafen=true;
 const view=render(<UserBar {...actions}/>);const queuedUnmute=screen.getByRole("button",{name:"unmuteAfterUndeafen"});expect(queuedUnmute).toHaveAttribute("aria-pressed","true");fireEvent.click(queuedUnmute);expect(actions.onToggleMute).toHaveBeenCalled();
 state.voice.muteBeforeDeafen=false;view.rerender(<UserBar {...actions}/>);expect(screen.getByRole("button",{name:"muteAfterUndeafen"})).toHaveAttribute("aria-pressed","true");
});

});
