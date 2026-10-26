import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, act, waitFor } from "@testing-library/react";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, options?: { count?: number }) => key === "notifications.delaySeconds" ? `${options?.count}s` : key }), initReactI18next: { type: "3rdParty", init: () => {} } }));
vi.mock("../../utils/notifications", () => ({ ensureNotificationPermission: vi.fn(async () => "granted") }));
vi.mock("../../utils/sounds", async original=>({...await original<typeof import("../../utils/sounds")>(), previewIncomingCallSound: vi.fn(), playVoiceEventSound: vi.fn()}));

import NotificationSettings from "./NotificationSettings";
import { usePreferencesStore } from "../../stores/preferencesStore";
import { useAccessibilityStore } from "../../stores/accessibilityStore";
import { ensureNotificationPermission } from "../../utils/notifications";

describe("NotificationSettings advanced controls", () => {
  beforeEach(() => {
    usePreferencesStore.getState().reset();
    usePreferencesStore.getState().bindAccount("alice");
    usePreferencesStore.setState({ data: { notifications: { desktopEnabled: true, desktopDelaySeconds: 0 } }, accountId: "alice", isLoaded: false });
    useAccessibilityStore.setState({ notificationDuration: 5, ttsEnabled: false, ttsRate: 1, notificationSoundVolume: 80 });
  });

  afterEach(() => { usePreferencesStore.getState().reset(); vi.unstubAllGlobals(); });

  it("tracks externally granted/revoked permission without requesting it or rewriting account preferences", async () => {
    const notification = { permission: "denied" as NotificationPermission };
    const status = new EventTarget();
    const query = vi.fn().mockResolvedValue(status);
    vi.stubGlobal("Notification", notification);
    vi.stubGlobal("navigator", { permissions: { query } });
    const view = render(<NotificationSettings />);
    const desktop = screen.getByRole("checkbox", { name: "notifications.desktopEnabled" });
    expect(desktop).toBeDisabled();
    await waitFor(() => expect(query).toHaveBeenCalledWith({ name: "notifications" }));
    notification.permission = "granted";
    act(() => status.dispatchEvent(new Event("change")));
    expect(desktop).not.toBeDisabled();
    expect(screen.getByText("notifications.permission.granted")).toBeInTheDocument();
    notification.permission = "denied";
    fireEvent.focus(window);
    expect(desktop).toBeDisabled();
    expect(usePreferencesStore.getState().data.notifications).toMatchObject({ desktopEnabled: true });
    expect(ensureNotificationPermission).not.toHaveBeenCalled();
    const remove = vi.spyOn(status, "removeEventListener");
    view.unmount();
    expect(remove).toHaveBeenCalledWith("change", expect.any(Function));
  });

  it("does not attach a late permission observer after the settings page closes", async () => {
    let finish!: (value: PermissionStatus) => void;
    vi.stubGlobal("Notification", { permission: "default" });
    vi.stubGlobal("navigator", { permissions: { query: vi.fn(() => new Promise<PermissionStatus>(resolve => { finish = resolve; })) } });
    const status = new EventTarget() as PermissionStatus;
    const add = vi.spyOn(status, "addEventListener");
    const view = render(<NotificationSettings />);
    view.unmount();
    await act(async () => finish(status));
    expect(add).not.toHaveBeenCalled();
    expect(ensureNotificationPermission).not.toHaveBeenCalled();
  });

  it("keeps advanced controls collapsed until requested and persists supported delay choices", () => {
    render(<NotificationSettings />);
    const summary = screen.getByText("notifications.advanced");
    expect(summary.closest("details")).not.toHaveAttribute("open");
    fireEvent.click(summary);
    expect(summary.closest("details")).toHaveAttribute("open");
    const delay = screen.getByLabelText("notifications.delay");
    expect(screen.getByText("notifications.backgroundLimits")).toBeInTheDocument();
    fireEvent.change(delay, { target: { value: "5" } });
    expect(usePreferencesStore.getState().data.notifications).toMatchObject({ desktopDelaySeconds: 5 });
    expect(screen.getByRole("option", { name: "10s" })).toBeInTheDocument();
  });

  it("exposes the already-wired minimum duration, notification volume, and TTS settings in the same disclosure", () => {
    render(<NotificationSettings />);
    fireEvent.click(screen.getByText("notifications.advanced"));
    expect(screen.getByText("acc.notificationDuration")).toBeInTheDocument();
    expect(screen.getByText("acc.notificationVolume")).toBeInTheDocument();
    expect(screen.getByText("acc.ttsEnabled")).toBeInTheDocument();
    expect(screen.getByText("acc.ttsRate")).toBeInTheDocument();
    expect(screen.getByText("acc.ttsPreview")).toBeInTheDocument();
    expect(screen.getByText("notifications.backgroundLimits")).toBeInTheDocument();
  });
});

it("syncs each voice event toggle and previews exactly that event with global silence honored",async()=>{
 usePreferencesStore.getState().reset();usePreferencesStore.getState().bindAccount("alice");usePreferencesStore.setState({data:{notifications:{}},accountId:"alice"});const {playVoiceEventSound}=await import("../../utils/sounds");render(<NotificationSettings/>);const labels=["join","leave","streamStart","streamStop","watchStart","watchStop","mute","unmute","deafen","undeafen"] as const;const keys=["voiceJoinSound","voiceLeaveSound","voiceStreamStartSound","voiceStreamStopSound","voiceWatchStartSound","voiceWatchStopSound","voiceMuteSound","voiceUnmuteSound","voiceDeafenSound","voiceUndeafenSound"];
 for(let i=0;i<labels.length;i++){const checkbox=screen.getByRole("checkbox",{name:`notifications.voiceEffects.${labels[i]}`});expect(checkbox).toBeChecked();fireEvent.click(checkbox);expect(usePreferencesStore.getState().data.notifications).toMatchObject({[keys[i]]:false});fireEvent.click(checkbox)}
 // mock translation has one label for all preview buttons, preserving source order.
 const previews=screen.getAllByRole("button",{name:"notifications.voiceEffectPreview"});for(let i=0;i<labels.length;i++){fireEvent.click(previews[i]);expect(playVoiceEventSound).toHaveBeenLastCalledWith(labels[i])}
 fireEvent.click(screen.getByRole("checkbox",{name:"notifications.muteAll"}));for(const button of previews)expect(button).toBeDisabled();
});
