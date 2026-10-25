import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import PreferencesSyncStatus from "./PreferencesSyncStatus";

const state = vi.hoisted(() => ({ syncStatus: "idle", syncError: null as string | null, retrySync: vi.fn(), legacyImportAvailable: false, importLegacyPreferences: vi.fn() }));
vi.mock("../../stores/preferencesStore", () => ({ usePreferencesStore: (select: (s: typeof state) => unknown) => select(state) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }), initReactI18next: { type: "3rdParty", init: () => {} } }));

describe("PreferencesSyncStatus", () => {
  beforeEach(() => { state.syncStatus = "idle"; state.syncError = null; state.retrySync.mockReset(); state.legacyImportAvailable = false; state.importLegacyPreferences.mockReset().mockResolvedValue(true); });
  it("does not claim a save before any sync", () => {
    render(<PreferencesSyncStatus />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
  it.each(["loading", "pending", "saving", "saved"])("announces %s accurately", (status) => {
    state.syncStatus = status;
    render(<PreferencesSyncStatus />);
    expect(screen.getByRole("status")).toHaveTextContent(`preferencesSync.${status}`);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
  it("offers a real retry when sync failed", () => {
    state.syncStatus = "error";
    render(<PreferencesSyncStatus />);
    fireEvent.click(screen.getByRole("button", { name: "preferencesSync.retry" }));
    expect(state.retrySync).toHaveBeenCalledOnce();
    expect(screen.getByRole("status")).toHaveTextContent("preferencesSync.error");
  });
  it("explains account drift without offering a legacy import into the stale account", () => {
    state.syncStatus = "error";
    state.syncError = "preferences_account_mismatch";
    state.legacyImportAvailable = true;
    render(<PreferencesSyncStatus />);
    expect(screen.getByRole("status")).toHaveTextContent("preferencesSync.accountChanged");
    expect(screen.queryByRole("button", { name: "preferencesSync.importLegacy" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "preferencesSync.retry" }));
    expect(state.retrySync).toHaveBeenCalledOnce();
  });
  it("never imports ownerless legacy choices without an explicit click", async () => {
    state.syncStatus = "saved";
    state.legacyImportAvailable = true;
    render(<PreferencesSyncStatus />);
    expect(screen.getByText("preferencesSync.legacyDescription")).toBeInTheDocument();
    expect(state.importLegacyPreferences).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "preferencesSync.importLegacy" }));
    await waitFor(() => expect(state.importLegacyPreferences).toHaveBeenCalledOnce());
  });
  it("does not show import success when safe queue persistence fails", async () => {
    state.syncStatus = "saved";
    state.legacyImportAvailable = true;
    state.importLegacyPreferences.mockResolvedValue(false);
    render(<PreferencesSyncStatus />);
    fireEvent.click(screen.getByRole("button", { name: "preferencesSync.importLegacy" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("preferencesSync.legacyError"));
  });
});
