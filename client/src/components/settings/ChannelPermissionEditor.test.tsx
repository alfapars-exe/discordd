import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Channel } from "../../types";
import { Permissions } from "../../utils/permissions";

const mocks = vi.hoisted(() => ({
  fetchRoles: vi.fn(),
  fetchOverrides: vi.fn(),
  getOverrides: vi.fn(() => []),
  getOverrideStatus: vi.fn(() => "ready"),
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
    getOverrideStatus: mocks.getOverrideStatus,
    setOverride: mocks.setOverride,
  }),
}));

import ChannelPermissionEditor from "./ChannelPermissionEditor";

beforeEach(() => { vi.clearAllMocks(); mocks.getOverrideStatus.mockReturnValue("ready"); });

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

it("prevents writes before the full role override has loaded", async () => {
  mocks.getOverrideStatus.mockReturnValue("loading");
  render(<ChannelPermissionEditor channel={{ id: "voice-A", type: "voice" } as Channel} />);
  await waitFor(() => expect(screen.getByRole("combobox")).toHaveValue("role-1"));
  fireEvent.click(screen.getAllByTitle("permOverrideAllow")[0]);
  expect(mocks.setOverride).not.toHaveBeenCalled();
});

it("waits for a save before accepting another bit change", async () => {
  let settle!: (ok: boolean) => void;
  mocks.setOverride.mockReturnValueOnce(new Promise<boolean>(resolve => { settle = resolve; }));
  render(<ChannelPermissionEditor channel={{ id: "voice-A", type: "voice" } as Channel} />);
  await waitFor(() => expect(screen.getByRole("combobox")).toHaveValue("role-1"));
  const buttons = screen.getAllByTitle("permOverrideDeny");
  fireEvent.click(buttons[0]);
  fireEvent.click(buttons[1]);
  expect(mocks.setOverride).toHaveBeenCalledTimes(1);
  settle(true);
  await waitFor(() => expect(buttons[1]).toBeEnabled());
});
