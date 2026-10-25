import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, options?: { count?: number }) => key === "notifications.delaySeconds" ? `${options?.count}s` : key }), initReactI18next: { type: "3rdParty", init: () => {} } }));
vi.mock("../../utils/notifications", () => ({ ensureNotificationPermission: vi.fn(async () => "granted") }));
vi.mock("../../utils/sounds", () => ({ previewIncomingCallSound: vi.fn() }));

import NotificationSettings from "./NotificationSettings";
import { usePreferencesStore } from "../../stores/preferencesStore";
import { useAccessibilityStore } from "../../stores/accessibilityStore";

describe("NotificationSettings advanced controls", () => {
  beforeEach(() => {
    usePreferencesStore.getState().reset();
    usePreferencesStore.getState().bindAccount("alice");
    usePreferencesStore.setState({ data: { notifications: { desktopEnabled: true, desktopDelaySeconds: 0 } }, accountId: "alice", isLoaded: false });
    useAccessibilityStore.setState({ notificationDuration: 5, ttsEnabled: false, ttsRate: 1, notificationSoundVolume: 80 });
  });

  afterEach(() => usePreferencesStore.getState().reset());

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
