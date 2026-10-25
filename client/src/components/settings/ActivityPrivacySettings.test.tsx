import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useAuthStore } from "../../stores/authStore";
import { usePreferencesStore } from "../../stores/preferencesStore";
import { useServerStore } from "../../stores/serverStore";
import ActivityPrivacySettings from "./ActivityPrivacySettings";
import { useRef } from "react";
import { useSettingsWorkspace } from "../../hooks/useSettingsWorkspace";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, options?: { limit?: number }) => options?.limit ? `${key} ${options.limit}` : key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

function server(id: string, name: string) { return { id, name, icon_url: null }; }
function WorkspaceHarness() {
  const ref = useRef<HTMLDivElement>(null);
  const workspace = useSettingsWorkspace({ isOpen: true, scope: "activity-user", activeTab: "activity-privacy", allowedTabs: ["activity-privacy"], setActiveTab: () => {}, closeSettings: () => {} }, ref);
  return <><nav aria-label="Section links">{workspace.sections.map((section) => <button key={section.id}>{section.label}</button>)}</nav>
    <div ref={ref}><div data-settings-panel="activity-privacy"><ActivityPrivacySettings /></div></div></>;
}

describe("ActivityPrivacySettings", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    usePreferencesStore.getState().reset();
    usePreferencesStore.getState().bindAccount("activity-user");
    usePreferencesStore.setState({ isLoaded: true, data: { privacy: { shareStreamUpdates: true } }, syncStatus: "saved" });
    useAuthStore.setState({ user: { id: "activity-user" } as NonNullable<ReturnType<typeof useAuthStore.getState>["user"]> });
    useServerStore.setState({ servers: [server("b", "Beta"), server("a", "Alpha")] });
  });

  afterEach(() => {
    cleanup();
    usePreferencesStore.getState().reset();
    useAuthStore.setState({ user: null });
    useServerStore.setState({ servers: [] });
    localStorage.clear();
  });

  it("keeps writes disabled until preferences belong to the signed-in account and are loaded", () => {
    act(() => usePreferencesStore.setState({ accountId: "other-user", isLoaded: true, data: { privacy: { shareGameActivity: true } } }));
    const { rerender } = render(<ActivityPrivacySettings />);
    expect(screen.getByRole("switch", { name: /activityPrivacyMaster/ })).toBeDisabled();
    expect(screen.getByRole("switch", { name: /activityPrivacyMaster/ })).not.toBeChecked();
    expect(screen.queryByText("Beta")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("activityPrivacyWaiting");
    act(() => usePreferencesStore.setState({ accountId: "activity-user", isLoaded: false }));
    rerender(<ActivityPrivacySettings />);
    expect(screen.getByRole("switch", { name: /activityPrivacyMaster/ })).toBeDisabled();
  });

  it("sorts by name, filters memberships, and patches only the game privacy leaves", () => {
    render(<ActivityPrivacySettings />);
    expect(screen.getAllByRole("switch").slice(1).map((el) => el.getAttribute("aria-label"))).toEqual(["Alpha", "Beta"]);
    fireEvent.change(screen.getByRole("textbox", { name: "activityPrivacySearch" }), { target: { value: "beta" } });
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: /activityPrivacyMaster/ }));
    const privacy = usePreferencesStore.getState().get<Record<string, unknown>>("privacy");
    expect(privacy).toMatchObject({ shareGameActivity: true, shareStreamUpdates: true });
    expect(Object.keys(privacy ?? {})).toContain("shareStreamUpdates");
  });

  it("preserves sidebar order and bulk-enables all memberships in one bounded patch", () => {
    render(<ActivityPrivacySettings />);
    fireEvent.change(screen.getByRole("combobox", { name: "activityPrivacySort" }), { target: { value: "sidebar" } });
    const switches = screen.getAllByRole("switch");
    expect(switches[1]).toHaveAccessibleName("Beta");
    fireEvent.click(screen.getByRole("button", { name: "activityPrivacyEnableCurrent" }));
    expect(usePreferencesStore.getState().get<Record<string, unknown>>("privacy")?.gameActivityServerOverrides).toEqual({ b: true, a: true });
  });

  it("does not silently truncate an over-limit bulk membership update", () => {
    const existing = Object.fromEntries(Array.from({ length: 1024 }, (_, index) => [`old-${index}`, true]));
    act(() => {
      usePreferencesStore.setState({ data: { privacy: { gameActivityServerOverrides: existing } } });
      useServerStore.setState({ servers: [server("new-server", "New")] });
    });
    render(<ActivityPrivacySettings />);
    fireEvent.click(screen.getByRole("button", { name: "activityPrivacyEnableCurrent" }));
    expect(screen.getByRole("alert")).toHaveTextContent("activityPrivacyLimit 1024");
    expect(Object.keys(usePreferencesStore.getState().get<Record<string, boolean>>("privacy")?.gameActivityServerOverrides ?? {})).toHaveLength(1024);
  });

  it("does not overwrite malformed saved overrides", () => {
    act(() => usePreferencesStore.setState({ data: { privacy: { gameActivityServerOverrides: { malformed: "yes" } } } }));
    render(<ActivityPrivacySettings />);
    expect(screen.getByRole("alert")).toHaveTextContent("activityPrivacyInvalidOverrides");
    expect(screen.getByRole("button", { name: "activityPrivacyEnableCurrent" })).toBeDisabled();
    expect(usePreferencesStore.getState().get<Record<string, unknown>>("privacy")?.gameActivityServerOverrides).toEqual({ malformed: "yes" });
  });

  it("shows persisted join-time sharing, with explicit overrides taking priority", () => {
    act(() => useServerStore.getState().handleServerCreate({ ...server("a", "Alpha"), game_activity_audience: true }));
    render(<ActivityPrivacySettings />);
    expect(screen.getByRole("switch", { name: "Alpha" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Beta" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("switch", { name: "Alpha" }));
    expect(screen.getByRole("switch", { name: "Alpha" })).not.toBeChecked();
    expect(usePreferencesStore.getState().get<Record<string, unknown>>("privacy")?.gameActivityServerOverrides).toEqual({ a: false });
    act(() => usePreferencesStore.setState({ data: { privacy: { gameActivityNewServerAudience: "all", gameActivityServerOverrides: { a: false } } } }));
    expect(screen.getByRole("switch", { name: "Alpha" })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: "Beta" })).not.toBeChecked();
  });

  it("uses only real section titles in workspace navigation and preserves control semantics", async () => {
    render(<WorkspaceHarness />);
    expect(await screen.findByRole("button", { name: "activityPrivacyMaster" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "activityPrivacyNewServer" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /activityPrivacyNewServerHint/ })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "activityPrivacyNewServer" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "activityPrivacyMaster" })).toBeEnabled();
  });

});
