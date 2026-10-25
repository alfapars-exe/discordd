import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Channel } from "../../types";
import { Permissions } from "../../utils/permissions";

const mocks = vi.hoisted(() => ({
  fetchRoles: vi.fn(),
  fetchOverrides: vi.fn(),
  getOverrides: vi.fn(() => []),
  setOverride: vi.fn(async () => true),
  roles: [{ id: "role-1", name: "Members", position: 1 }],
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../stores/roleStore", () => ({
  useRoleStore: (selector: (state: { fetchRoles: typeof mocks.fetchRoles }) => unknown) => selector({ fetchRoles: mocks.fetchRoles }),
  useActiveRoles: () => mocks.roles,
}));
vi.mock("../../stores/channelPermissionStore", () => ({
  useChannelPermissionStore: () => ({
    fetchOverrides: mocks.fetchOverrides,
    getOverrides: mocks.getOverrides,
    setOverride: mocks.setOverride,
  }),
}));

import ChannelPermissionEditor from "./ChannelPermissionEditor";

beforeEach(() => vi.clearAllMocks());

describe("voice channel message permissions", () => {
  it("exposes read and send overrides and persists their permission bits", async () => {
    render(<ChannelPermissionEditor channel={{ id: "voice-A", name: "Lounge", type: "voice" } as Channel} />);
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveValue("role-1"));

    const readRow = screen.getByText("permReadMessages").closest(".perm-tri");
    const sendRow = screen.getByText("permSendMessages").closest(".perm-tri");
    expect(readRow).not.toBeNull();
    expect(sendRow).not.toBeNull();
    fireEvent.click(within(readRow as HTMLElement).getByTitle("permOverrideAllow"));
    await waitFor(() => expect(mocks.setOverride).toHaveBeenCalledWith("voice-A", "role-1", Permissions.ReadMessages, 0));

    mocks.setOverride.mockClear();
    fireEvent.click(within(sendRow as HTMLElement).getByTitle("permOverrideAllow"));
    await waitFor(() => expect(mocks.setOverride).toHaveBeenCalledWith("voice-A", "role-1", Permissions.SendMessages, 0));
  });
});
