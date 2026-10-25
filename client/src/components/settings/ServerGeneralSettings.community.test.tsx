import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAuthStore } from "../../stores/authStore";
import { useServerStore } from "../../stores/serverStore";
import * as serverApi from "../../api/servers";
import ServerGeneralSettings from "./ServerGeneralSettings";
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }), Trans: () => null, initReactI18next: { type: "3rdParty", init: () => {} } }));
vi.mock("../../stores/memberStore", () => ({ useActiveMembers: () => [{ id: "owner", effective_permissions: 512 }] }));
vi.mock("../../api/servers", () => ({ getServer: vi.fn(), updateServer: vi.fn() }));
vi.mock("./AvatarUpload", () => ({ default: () => null }));
vi.mock("./ServerOwnershipTransfer", () => ({ default: () => null }));
const server = { id: "server-a", name: "Example", owner_id: "owner", icon_url: null, invite_required: false, is_community: false, e2ee_enabled: true, livekit_instance_id: null, afk_timeout_minutes: 60, member_count: 2, created_at: "2026-10-25T12:00:00Z" };
beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ user: { id: "owner" } as never });
  useServerStore.setState({ activeServerId: "server-a" });
  vi.mocked(serverApi.getServer).mockResolvedValue({ success: true, data: server });
  vi.mocked(serverApi.updateServer).mockResolvedValue({ success: true, data: { ...server, is_community: true } });
});
afterEach(() => cleanup());
it("saves explicit classification through the existing guarded server PATCH", async () => {
  render(<ServerGeneralSettings />);
  const toggle = await screen.findByRole("checkbox", { name: "serverCommunityClassification" });
  expect(toggle).not.toBeChecked(); fireEvent.click(toggle);
  fireEvent.click(screen.getByRole("button", { name: "saveChanges" }));
  await waitFor(() => expect(serverApi.updateServer).toHaveBeenCalledWith("server-a", expect.objectContaining({ is_community: true })));
});
it("ignores an old classification response after changing servers", async () => {
  let done!: (value: Awaited<ReturnType<typeof serverApi.getServer>>) => void;
  vi.mocked(serverApi.getServer).mockImplementationOnce(() => new Promise(resolve => { done = resolve; }));
  render(<ServerGeneralSettings />);
  vi.mocked(serverApi.getServer).mockResolvedValue({ success: true, data: { ...server, id: "server-b", name: "Second" } });
  act(() => useServerStore.setState({ activeServerId: "server-b" }));
  await act(async () => { done({ success: true, data: { ...server, is_community: true } }); });
  await waitFor(() => expect(screen.getByRole("textbox", { name: "serverName" })).toHaveValue("Second"));
  expect(screen.getByRole("checkbox", { name: "serverCommunityClassification" })).not.toBeChecked();
});
