import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

import PrivacyConsentSettings from "./PrivacyConsentSettings";
import { usePreferencesStore } from "../../stores/preferencesStore";

describe("PrivacyConsentSettings", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    usePreferencesStore.getState().reset();
    usePreferencesStore.getState().bindAccount("privacy-test-user");
  });

  afterEach(() => {
    usePreferencesStore.getState().reset();
    localStorage.clear();
    vi.useRealTimers();
  });

  it("defaults online-update sharing on and persists an explicit opt-out", () => {
    render(<PrivacyConsentSettings />);

    const toggle = screen.getByRole("switch", { name: /privacyControls\.shareOnlineUpdates/ });
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);

    expect(toggle).not.toBeChecked();
    expect(usePreferencesStore.getState().get<{ shareOnlineUpdates?: boolean }>("privacy")?.shareOnlineUpdates).toBe(false);
    const pendingKey = Object.keys(localStorage).find((key) => key.startsWith("hichat.preferences.pending.v1:"));
    expect(pendingKey).toBeDefined();
    expect(JSON.parse(localStorage.getItem(pendingKey!)!).privacy.shareOnlineUpdates).toBe(false);
  });

  it("defaults stream-sharing consent off and persists an explicit opt-in", () => {
    render(<PrivacyConsentSettings />);

    const toggle = screen.getByRole("switch", { name: /privacyControls\.shareStreamUpdates/ });
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);

    expect(toggle).toBeChecked();
    expect(usePreferencesStore.getState().get<{ shareStreamUpdates?: boolean }>("privacy")?.shareStreamUpdates).toBe(true);
    const pendingKey = Object.keys(localStorage).find((key) => key.startsWith("hichat.preferences.pending.v1:"));
    expect(pendingKey).toBeDefined();
    expect(JSON.parse(localStorage.getItem(pendingKey!)!).privacy.shareStreamUpdates).toBe(true);
  });
});
