import { useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAuthStore } from "../../stores/authStore";
import { useServerStore } from "../../stores/serverStore";
import { useConfirmStore } from "../../stores/confirmStore";
import { useSettingsWorkspace } from "../../hooks/useSettingsWorkspace";
import { SettingsWorkspaceContext } from "./settingsWorkspaceContext";
import type { SettingsTab } from "../../stores/settingsStore";
import type { LiveKitInstanceAdmin, Server } from "../../types";
import * as admin from "../../api/admin";
import * as servers from "../../api/servers";
import PlatformSettings from "./PlatformSettings";
import ServerGeneralSettings from "./ServerGeneralSettings";

const t = (key: string) => key;
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t }), Trans: () => null, initReactI18next: { type: "3rdParty", init: () => {} } }));
vi.mock("../../api/admin", () => ({ listLiveKitInstances: vi.fn(), createLiveKitInstance: vi.fn(), updateLiveKitInstance: vi.fn(), deleteLiveKitInstance: vi.fn() }));
vi.mock("../../api/servers", () => ({ getServer: vi.fn(), updateServer: vi.fn(), getLiveKitSettings: vi.fn() }));
vi.mock("../../stores/memberStore", () => ({ useActiveMembers: () => [{ id: "owner", effective_permissions: 512 }] }));
vi.mock("./MetricsPanel", () => ({ default: () => null }));
vi.mock("./AvatarUpload", () => ({ default: () => null }));
vi.mock("./ServerOwnershipTransfer", () => ({ default: () => null }));
const instance = (id: string): LiveKitInstanceAdmin => ({ id, url: `wss://${id}.example.test`, is_platform_managed: false, max_servers: 0, server_count: 0, hetzner_server_id: "", created_at: "", priority: 0, monthly_quota_minutes: 0, quota_reset_day: 1, auto_switch_enabled: false, switch_threshold_minutes: 0 });
const a = instance("a"), b = instance("b");
const server: Server = { id: "server-a", name: "Example", owner_id: "owner", icon_url: null, invite_required: false, is_community: false, e2ee_enabled: true, livekit_instance_id: "a", afk_timeout_minutes: 60, member_count: 2, created_at: "" };
const closed = vi.fn();
function Harness({ platform = true }: { platform?: boolean }) {
  const [tab, setTab] = useState<SettingsTab>("appearance");
  const ref = useRef<HTMLDivElement>(null);
  const workspace = useSettingsWorkspace({ isOpen: true, scope: "owner", activeTab: tab, allowedTabs: ["appearance", "accessibility"], setActiveTab: setTab, closeSettings: closed }, ref);
  return <SettingsWorkspaceContext.Provider value={workspace}>
    <button onClick={workspace.close}>Close editor</button>
    <button onClick={() => workspace.navigate("accessibility")}>Other settings</button>
    <output>{tab}</output>
    <div ref={ref}>{tab === "appearance" && (platform ? <PlatformSettings /> : <ServerGeneralSettings />)}</div>
  </SettingsWorkspaceContext.Provider>;
}
async function answer(value: boolean) { await act(async () => { useConfirmStore.getState()[value ? "confirm" : "cancel"](); }); }
const url = () => screen.getByPlaceholderText("platformInstanceUrlPlaceholder");
async function selectA() { fireEvent.click(await screen.findByText(a.url)); await waitFor(() => expect(url()).toHaveValue(a.url)); }
beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ user: { id: "owner", is_platform_admin: true } as never });
  useServerStore.setState({ activeServerId: "server-a" });
  vi.mocked(admin.listLiveKitInstances).mockResolvedValue({ success: true, data: [a, b] });
  vi.mocked(servers.getServer).mockResolvedValue({ success: true, data: server });
  vi.mocked(servers.getLiveKitSettings).mockResolvedValue({ success: true, data: { url: a.url, is_platform_managed: false } });
});
afterEach(() => { cleanup(); useConfirmStore.getState().cancel(); });

it("protects platform selection, new and cancel transitions with the shared confirmation", async () => {
  render(<Harness />); await selectA();
  fireEvent.change(url(), { target: { value: "wss://draft.test" } });
  fireEvent.click(screen.getByText(b.url));
  expect(useConfirmStore.getState().options).not.toBeNull();
  await answer(false); expect(url()).toHaveValue("wss://draft.test");
  fireEvent.click(screen.getByRole("button", { name: "+" })); await answer(false);
  expect(url()).toHaveValue("wss://draft.test");
  fireEvent.click(screen.getByText(b.url)); await answer(true); expect(url()).toHaveValue(b.url);
  fireEvent.click(screen.getByRole("button", { name: "+" }));
  fireEvent.change(url(), { target: { value: "wss://new.test" } });
  fireEvent.click(screen.getByRole("button", { name: "cancel" })); await answer(false);
  expect(url()).toHaveValue("wss://new.test");
  fireEvent.click(screen.getByRole("button", { name: "cancel" })); await answer(true);
  expect(screen.queryByPlaceholderText("platformInstanceUrlPlaceholder")).not.toBeInTheDocument();
});

it("guards outer navigation and unload while preserving failed platform saves", async () => {
  vi.mocked(admin.updateLiveKitInstance).mockResolvedValue({ success: false, error: "failed" });
  render(<Harness />); await selectA();
  fireEvent.change(url(), { target: { value: "wss://draft.test" } });
  fireEvent.click(screen.getByRole("button", { name: "save" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "save" })).not.toBeDisabled());
  expect(url()).toHaveValue("wss://draft.test");
  const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); expect(event.defaultPrevented).toBe(true);
  fireEvent.click(screen.getByText("Close editor")); await answer(false); expect(closed).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Other settings")); await answer(false); expect(url()).toHaveValue("wss://draft.test");
  fireEvent.click(screen.getByText("Other settings")); await answer(true); expect(screen.getByText("accessibility")).toBeInTheDocument();
});

it("serializes a platform save, clears only acknowledged credentials and becomes clean", async () => {
  let done!: (res: Awaited<ReturnType<typeof admin.updateLiveKitInstance>>) => void;
  vi.mocked(admin.updateLiveKitInstance).mockImplementation(() => new Promise(resolve => { done = resolve; }));
  render(<Harness />); await selectA();
  fireEvent.change(screen.getByPlaceholderText("platformInstanceApiSecretPlaceholder"), { target: { value: "local-test-secret" } });
  fireEvent.click(screen.getByRole("button", { name: "save" }));
  expect(url()).toBeDisabled(); fireEvent.click(screen.getByText(b.url)); expect(url()).toHaveValue(a.url);
  expect(admin.updateLiveKitInstance).toHaveBeenCalledTimes(1);
  await act(async () => { done({ success: true, data: a }); });
  expect(screen.getByPlaceholderText("platformInstanceApiSecretPlaceholder")).toHaveValue("");
  fireEvent.click(screen.getByText("Close editor")); await waitFor(() => expect(closed).toHaveBeenCalledOnce());
  expect(useConfirmStore.getState().options).toBeNull();
});

it("rejects stale platform confirmations and clears sensitive drafts on account replacement", async () => {
  render(<Harness />); await selectA();
  fireEvent.change(url(), { target: { value: "wss://first.test" } });
  fireEvent.click(screen.getByText(b.url));
  fireEvent.change(url(), { target: { value: "wss://newer.test" } });
  await answer(true); expect(url()).toHaveValue("wss://newer.test");
  fireEvent.change(screen.getByPlaceholderText("platformInstanceApiSecretPlaceholder"), { target: { value: "private-draft" } });
  act(() => useAuthStore.setState({ user: { id: "other", is_platform_admin: true } as never }));
  expect(screen.queryByDisplayValue("private-draft")).not.toBeInTheDocument();
});

it("protects server and LiveKit drafts and keeps newer edits after a save acknowledgement", async () => {
  let done!: (res: Awaited<ReturnType<typeof servers.updateServer>>) => void;
  vi.mocked(servers.updateServer).mockImplementation(() => new Promise(resolve => { done = resolve; }));
  render(<Harness platform={false} />);
  const name = await screen.findByRole("textbox", { name: "serverName" });
  const invite = screen.getByRole("checkbox", { name: "inviteRequired" });
  fireEvent.change(name, { target: { value: "Submitted" } });
  fireEvent.click(invite);
  fireEvent.click(screen.getAllByRole("button", { name: "saveChanges" })[0]);
  fireEvent.change(name, { target: { value: "Newer" } });
  fireEvent.click(invite);
  await act(async () => { done({ success: true, data: { ...server, name: "Submitted", invite_required: true } }); });
  expect(name).toHaveValue("Newer");
  expect(invite).not.toBeChecked();
  fireEvent.click(screen.getByText("Close editor")); await answer(false); expect(closed).not.toHaveBeenCalled();
  fireEvent.change(name, { target: { value: "Submitted" } });
  fireEvent.click(invite);
  fireEvent.change(screen.getByLabelText("livekitApiSecret"), { target: { value: "private-draft" } });
  fireEvent.click(screen.getByText("Close editor")); expect(useConfirmStore.getState().options).not.toBeNull();
  await answer(false); expect(screen.getByLabelText("livekitApiSecret")).toHaveValue("private-draft");
});

it("preserves failed server saves and rejects an old response after changing the server", async () => {
  vi.mocked(servers.updateServer).mockResolvedValueOnce({ success: false, error: "failed" });
  render(<Harness platform={false} />);
  const name = await screen.findByRole("textbox", { name: "serverName" });
  fireEvent.change(name, { target: { value: "Keep me" } });
  fireEvent.click(screen.getAllByRole("button", { name: "saveChanges" })[0]);
  await waitFor(() => expect(screen.getAllByRole("button", { name: "saveChanges" })[0]).not.toBeDisabled());
  expect(name).toHaveValue("Keep me");
  let done!: (res: Awaited<ReturnType<typeof servers.updateServer>>) => void;
  vi.mocked(servers.updateServer).mockImplementationOnce(() => new Promise(resolve => { done = resolve; }));
  fireEvent.click(screen.getAllByRole("button", { name: "saveChanges" })[0]);
  vi.mocked(servers.getServer).mockResolvedValue({ success: true, data: { ...server, id: "server-b", name: "Second" } });
  act(() => useServerStore.setState({ activeServerId: "server-b" }));
  await waitFor(() => expect(screen.getByRole("textbox", { name: "serverName" })).toHaveValue("Second"));
  await act(async () => { done({ success: true, data: { ...server, name: "Keep me" } }); });
  expect(screen.getByRole("textbox", { name: "serverName" })).toHaveValue("Second");
});

it("does not erase new LiveKit URL or secrets typed while the old draft is saving", async () => {
  let done!: (res: Awaited<ReturnType<typeof servers.updateServer>>) => void;
  vi.mocked(servers.updateServer).mockImplementationOnce(() => new Promise(resolve => { done = resolve; }));
  render(<Harness platform={false} />);
  const secret = await screen.findByLabelText("livekitApiSecret");
  const key = screen.getByLabelText("livekitApiKey");
  const liveKitUrl = screen.getByLabelText("livekitUrl");
  fireEvent.change(liveKitUrl, { target: { value: "  wss://submitted.test  " } });
  fireEvent.change(key, { target: { value: "submitted-key" } });
  fireEvent.change(secret, { target: { value: "submitted-secret" } });
  const buttons = screen.getAllByRole("button", { name: "saveChanges" });
  fireEvent.click(buttons[buttons.length - 1]);
  fireEvent.change(liveKitUrl, { target: { value: "  wss://newer.test  " } });
  fireEvent.change(key, { target: { value: "new-key" } });
  fireEvent.change(secret, { target: { value: "new-secret" } });
  await act(async () => { done({ success: true, data: server }); });
  expect(key).toHaveValue("new-key"); expect(secret).toHaveValue("new-secret");
  expect(liveKitUrl).toHaveValue("  wss://newer.test  ");
  fireEvent.click(screen.getByText("Close editor")); expect(useConfirmStore.getState().options).not.toBeNull();
  for (const storage of [localStorage, sessionStorage]) {
    expect(JSON.stringify(Object.values(storage))).not.toContain("new-secret");
  }
});

it("normalizes an acknowledged unchanged LiveKit URL and clears the successful draft", async () => {
  vi.mocked(servers.updateServer).mockResolvedValueOnce({ success: true, data: server });
  render(<Harness platform={false} />);
  const liveKitUrl = await screen.findByLabelText("livekitUrl");
  fireEvent.change(liveKitUrl, { target: { value: "  wss://saved.test  " } });
  fireEvent.change(screen.getByLabelText("livekitApiKey"), { target: { value: "local-key" } });
  fireEvent.change(screen.getByLabelText("livekitApiSecret"), { target: { value: "local-secret" } });
  const buttons = screen.getAllByRole("button", { name: "saveChanges" });
  fireEvent.click(buttons[buttons.length - 1]);
  await waitFor(() => expect(liveKitUrl).toHaveValue("wss://saved.test"));
  expect(servers.updateServer).toHaveBeenCalledWith("server-a", { livekit_url: "wss://saved.test", livekit_key: "local-key", livekit_secret: "local-secret" });
  expect(screen.getByLabelText("livekitApiKey")).toHaveValue("");
  expect(screen.getByLabelText("livekitApiSecret")).toHaveValue("");
  fireEvent.click(screen.getByText("Close editor"));
  await waitFor(() => expect(closed).toHaveBeenCalledOnce());
  expect(useConfirmStore.getState().options).toBeNull();
});

it("keeps a failed create draft and drops a successful response from a replaced account", async () => {
  vi.mocked(admin.createLiveKitInstance).mockResolvedValueOnce({ success: false, error: "failed" });
  render(<Harness />); await screen.findByText(a.url);
  fireEvent.click(screen.getByRole("button", { name: "+" }));
  fireEvent.change(url(), { target: { value: "wss://new.test" } });
  fireEvent.change(screen.getByPlaceholderText("platformInstanceApiKeyPlaceholder"), { target: { value: "local-key" } });
  fireEvent.change(screen.getByPlaceholderText("platformInstanceApiSecretPlaceholder"), { target: { value: "private-draft" } });
  fireEvent.click(screen.getByRole("button", { name: "platformAddInstance" }));
  await waitFor(() => expect(url()).not.toBeDisabled());
  expect(url()).toHaveValue("wss://new.test");
  expect(screen.getByPlaceholderText("platformInstanceApiSecretPlaceholder")).toHaveValue("private-draft");
  let done!: (res: Awaited<ReturnType<typeof admin.createLiveKitInstance>>) => void;
  vi.mocked(admin.createLiveKitInstance).mockImplementationOnce(() => new Promise(resolve => { done = resolve; }));
  fireEvent.click(screen.getByRole("button", { name: "platformAddInstance" }));
  act(() => useAuthStore.setState({ user: { id: "other", is_platform_admin: true } as never }));
  await act(async () => { done({ success: true, data: instance("created") }); });
  expect(screen.queryByText("wss://created.example.test")).not.toBeInTheDocument();
  expect(screen.queryByDisplayValue("private-draft")).not.toBeInTheDocument();
});

it("does not report a failed delete as success or discard the selected draft", async () => {
  vi.mocked(admin.deleteLiveKitInstance).mockResolvedValue({ success: false, error: "denied" });
  render(<Harness />); await selectA();
  fireEvent.click(screen.getByRole("button", { name: "platformDeleteInstance" })); await answer(true);
  await waitFor(() => expect(admin.deleteLiveKitInstance).toHaveBeenCalledWith(a.id, undefined));
  await waitFor(() => expect(url()).not.toBeDisabled());
  expect(url()).toHaveValue(a.url); expect(screen.getByText(a.url)).toBeInTheDocument();
});
