import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { useRef, useState, type PropsWithChildren } from "react";
import { useSettingsWorkspace } from "./useSettingsWorkspace";
import { SettingsWorkspaceContext, useSettingsDraft } from "../components/settings/settingsWorkspaceContext";
import { useConfirmStore } from "../stores/confirmStore";
import type { SettingsTab } from "../stores/settingsStore";

const translate = (key: string) => key;
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: translate }), initReactI18next: { type: "3rdParty", init: () => {} } }));
const closeSettings = vi.fn();
function Draft({ dirty }: { dirty: boolean }) { useSettingsDraft(dirty); return null; }
function Harness({ scope = "account-a", open = true, loaded = true, dirty = false, nestedSection = false, allowed = ["appearance", "accessibility"] as SettingsTab[] }: {
  scope?: string; open?: boolean; loaded?: boolean; dirty?: boolean; nestedSection?: boolean; allowed?: SettingsTab[];
}) {
  const [tab, setTab] = useState<SettingsTab>("appearance");
  const ref = useRef<HTMLDivElement>(null);
  const workspace = useSettingsWorkspace({ isOpen: open, scope, activeTab: tab, allowedTabs: allowed, setActiveTab: setTab, closeSettings }, ref);
  return <SettingsWorkspaceContext.Provider value={workspace}>
    <button onClick={() => workspace.navigate("accessibility")}>Next</button>
    <button onClick={() => workspace.navigate("accessibility", "second")}>Next section</button>
    <button onClick={() => workspace.navigate("accessibility", "advanced")}>Next advanced</button>
    <button onClick={workspace.back} disabled={!workspace.canGoBack}>Back</button>
    <button onClick={workspace.close}>Close</button>
    <output data-testid="active">{workspace.activeSection}</output>
    <output data-testid="tab">{tab}</output>
    {workspace.sections.map((section) => <button data-testid={`nav-${section.id}`} key={section.id} onClick={() => workspace.navigateSection(section.id)}>{section.label}</button>)}
    {open && <div data-testid="scroll" ref={ref}>
      {loaded && <div data-settings-panel={tab}>
        <h2 className="settings-section-title" data-settings-section="first" data-y="100">First section</h2>
        <h2 className="settings-section-title" data-settings-section="second" data-y="650">Second section</h2>
        <div className="vs-label" data-settings-section="plain-label" data-y="900">Plain voice label</div>
        {nestedSection && <><section data-settings-section="desktop"><div className="vs-section-header">Desktop notifications</div><p>Choose a device. Permission and delivery descriptions belong to the controls, not the navigation label.</p></section><section data-settings-section="privacy"><h3>Sharing defaults</h3><p>Never include this explanation in navigation.</p><label>Current servers<input /></label></section><section data-settings-section="no-heading"><p>Help text without a heading must not become a navigation item.</p></section><details data-testid="advanced"><summary data-settings-section="advanced">Advanced controls</summary><input aria-label="Delay" /></details></>}
        <Draft dirty={dirty} />
      </div>}
    </div>}
  </SettingsWorkspaceContext.Provider>;
}
const scroll = () => screen.getByTestId("scroll");

describe("settings workspace state and navigation", () => {
  beforeEach(() => {
    closeSettings.mockReset();
    useConfirmStore.getState().cancel();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const root = this.closest<HTMLElement>('[data-testid="scroll"]');
      const top = this.dataset.y ? Number(this.dataset.y) - (root?.scrollTop ?? 0) : 0;
      return { x: 0, y: top, top, bottom: top + 30, left: 0, right: 500, width: 500, height: this.dataset.testid === "scroll" ? 400 : 30, toJSON: () => ({}) };
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1200);
  });
  afterEach(() => { act(() => useConfirmStore.getState().cancel()); vi.restoreAllMocks(); });

  it("discovers lazy content, follows scrolling and moves keyboard focus on section navigation", async () => {
    const view = render(<Harness loaded={false} />);
    expect(screen.queryByRole("button", { name: "Second section" })).not.toBeInTheDocument();
    view.rerender(<Harness loaded />);
    await screen.findByRole("button", { name: "Second section" });
    expect(screen.getByTestId("active")).toHaveTextContent("settings-appearance-first");
    scroll().scrollTop = 660;
    fireEvent.scroll(scroll());
    expect(screen.getByTestId("active")).toHaveTextContent("settings-appearance-second");
    fireEvent.click(screen.getByRole("button", { name: "First section" }));
    expect(scroll().scrollTop).toBe(76);
    expect(screen.getByRole("heading", { name: "First section" })).toHaveFocus();
  });

  it("uses an inner settings heading instead of a section container's full text", async () => {
    render(<Harness nestedSection />);
    await screen.findByRole("button", { name: "Desktop notifications" });
    expect(screen.queryByRole("button", { name: /Choose a device/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Desktop notifications" }));
    expect(screen.getByTestId("active")).toHaveTextContent("settings-appearance-desktop");
    expect(screen.getByRole("heading", { name: "Desktop notifications" })).toHaveAttribute("id", "settings-appearance-desktop");
  });

  it("uses plain semantic headings and excludes headingless help sections", async () => {
    render(<Harness nestedSection />);
    const link = await screen.findByRole("button", { name: "Sharing defaults" });
    expect(screen.queryByRole("button", { name: /Never include|Help text without|Current servers/ })).not.toBeInTheDocument();
    fireEvent.click(link);
    expect(screen.getByRole("heading", { name: "Sharing defaults" })).toHaveFocus();
    expect(screen.getByTestId("active")).toHaveTextContent("settings-appearance-privacy");
  });

  it("keeps explicitly marked leaf labels used by voice controls", async () => {
    render(<Harness />);
    const link = await screen.findByRole("button", { name: "Plain voice label" });
    fireEvent.click(link);
    expect(screen.getByRole("heading", { name: "Plain voice label" })).toHaveFocus();
  });

  it("reveals collapsed controls when their section link is selected", async () => {
    render(<Harness nestedSection />);
    const link = await screen.findByTestId("nav-settings-appearance-advanced");
    expect(screen.getByTestId("advanced")).not.toHaveAttribute("open");
    fireEvent.click(link);
    expect(screen.getByTestId("advanced")).toHaveAttribute("open");
    const summary = screen.getByTestId("advanced").querySelector("summary")!;
    expect(summary).toHaveFocus();
    expect(summary).not.toHaveAttribute("role");
    expect(summary).not.toHaveAttribute("tabindex", "-1");
  });

  it("reveals the requested collapsed section after related navigation", async () => {
    render(<Harness nestedSection />);
    await screen.findByTestId("nav-settings-appearance-advanced");
    fireEvent.click(screen.getByText("Next advanced"));
    await waitFor(() => expect(screen.getByTestId("tab")).toHaveTextContent("accessibility"));
    const summary = screen.getByTestId("advanced").querySelector("summary")!;
    await waitFor(() => expect(summary).toHaveAttribute("id", "settings-accessibility-advanced"));
    expect(screen.getByTestId("advanced")).toHaveAttribute("open");
    expect(summary).toHaveFocus();
  });

  it("restores source scroll after related navigation and reopening, but isolates account and server scopes", async () => {
    const view = render(<Harness />);
    await screen.findByRole("button", { name: "Second section" });
    scroll().scrollTop = 600;
    fireEvent.scroll(scroll());
    fireEvent.click(screen.getByText("Next"));
    await waitFor(() => expect(screen.getByTestId("tab")).toHaveTextContent("accessibility"));
    await waitFor(() => expect(scroll().scrollTop).toBe(0));
    fireEvent.click(screen.getByText("Back"));
    await waitFor(() => expect(scroll().scrollTop).toBe(600));
    fireEvent.click(screen.getByText("Close"));
    expect(closeSettings).toHaveBeenCalledOnce();
    view.rerender(<Harness open={false} />);
    view.rerender(<Harness open />);
    await waitFor(() => expect(scroll().scrollTop).toBe(600));
    view.rerender(<Harness scope="account-b" />);
    await waitFor(() => expect(scroll().scrollTop).toBe(0));
    expect(screen.getByText("Back")).toBeDisabled();
    view.rerender(<Harness scope="account-a:server-b" />);
    await waitFor(() => expect(scroll().scrollTop).toBe(0));
  });

  it("keeps a restored position until a lazy panel has arrived", async () => {
    const view = render(<Harness />);
    await screen.findByRole("button", { name: "Second section" });
    scroll().scrollTop = 500;
    fireEvent.scroll(scroll());
    fireEvent.click(screen.getByText("Close"));
    view.rerender(<Harness open={false} />);
    view.rerender(<Harness loaded={false} />);
    expect(scroll().scrollTop).toBe(0);
    view.rerender(<Harness loaded />);
    await waitFor(() => expect(scroll().scrollTop).toBe(500));
  });

  it("opens the requested search result after its lazy panel renders", async () => {
    render(<Harness />);
    await screen.findByRole("button", { name: "Second section" });
    fireEvent.click(screen.getByText("Next section"));
    await waitFor(() => expect(scroll().scrollTop).toBe(626));
    expect(screen.getByRole("heading", { name: "Second section" })).toHaveFocus();
    expect(screen.getByTestId("active")).toHaveTextContent("settings-accessibility-second");
  });

  it("retains unsaved forms on cancelled navigation and warns before unloading", async () => {
    render(<Harness dirty />);
    fireEvent.click(screen.getByText("Next"));
    expect(useConfirmStore.getState().options?.message).toBe("workspace.unsavedMessage");
    expect(screen.getByTestId("tab")).toHaveTextContent("appearance");
    act(() => useConfirmStore.getState().cancel());
    await waitFor(() => expect(useConfirmStore.getState().options).toBeNull());
    expect(screen.getByTestId("tab")).toHaveTextContent("appearance");
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByText("Close"));
    act(() => useConfirmStore.getState().confirm());
    await waitFor(() => expect(closeSettings).toHaveBeenCalledOnce());
  });

  it("ignores a late discard answer after account switch and rechecks revoked targets", async () => {
    const view = render(<Harness dirty />);
    fireEvent.click(screen.getByText("Next"));
    view.rerender(<Harness dirty scope="account-b" />);
    act(() => useConfirmStore.getState().confirm());
    await waitFor(() => expect(useConfirmStore.getState().options).toBeNull());
    expect(screen.getByTestId("tab")).toHaveTextContent("appearance");
    fireEvent.click(screen.getByText("Next"));
    view.rerender(<Harness dirty scope="account-b" allowed={["appearance"]} />);
    act(() => useConfirmStore.getState().confirm());
    await waitFor(() => expect(useConfirmStore.getState().options).toBeNull());
    expect(screen.getByTestId("tab")).toHaveTextContent("appearance");
  });

  it("cleans the draft registration on panel unmount", async () => {
    function Wrapper({ children }: PropsWithChildren) { return <>{children}</>; }
    const view = render(<Harness dirty />, { wrapper: Wrapper });
    view.rerender(<Harness dirty={false} />);
    fireEvent.click(screen.getByText("Next"));
    expect(useConfirmStore.getState().options).toBeNull();
    await waitFor(() => expect(screen.getByTestId("tab")).toHaveTextContent("accessibility"));
  });
});
