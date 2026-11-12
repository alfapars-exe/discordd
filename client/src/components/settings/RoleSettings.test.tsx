import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { Permissions } from "../../utils/permissions";
import RoleSettings from "./RoleSettings";

const state = vi.hoisted(() => ({
  role: { id: "member", name: "Member", position: 2, permissions: 0, mentionable: true, color: "#eeeeee" },
  updateRole: vi.fn(async () => true),
  fetchRoles: vi.fn(),
  actor: { id: "actor", effective_permissions: 512, roles: [{ position: 3 }] },
}));
vi.mock("react-i18next", async (original) => ({ ...await original<typeof import("react-i18next")>(), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../stores/roleStore", () => ({
  useActiveRoles: () => [state.role],
  useRoleStore: () => ({ selectedRoleId: "member", updateRole: state.updateRole, fetchRoles: state.fetchRoles }),
}));
vi.mock("../../stores/memberStore", () => ({ useActiveMembers: () => [state.actor] }));
vi.mock("../../stores/authStore", () => ({ useAuthStore: (select: (state: {user: {id: string}}) => unknown) => select({ user: { id: "actor" } }) }));

it.each(Object.entries(Permissions))("saves the %s bit from the role editor", async (name, bit) => {
  state.updateRole.mockClear();
  state.role.permissions = 0;
  const { unmount } = render(<RoleSettings />);
  const toggle = screen.getByRole("button", { name: name === "ConnectVoice" ? "permConnect" : "perm" + name });
  await waitFor(() => expect(screen.getByDisplayValue("Member")).toBeInTheDocument());
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "saveChanges" }));
  await waitFor(() => expect(state.updateRole).toHaveBeenCalledWith("member", { permissions: bit }));
  unmount();
  state.updateRole.mockClear();
  state.role.permissions = bit;
  render(<RoleSettings />);
  const enabled = await screen.findByRole("button", { name: name === "ConnectVoice" ? "permConnect" : "perm" + name, pressed: true });
  fireEvent.click(enabled);
  fireEvent.click(screen.getByRole("button", { name: "saveChanges" }));
  await waitFor(() => expect(state.updateRole).toHaveBeenCalledWith("member", { permissions: 0 }));
});
