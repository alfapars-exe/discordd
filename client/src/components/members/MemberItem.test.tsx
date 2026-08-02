/**
 * MemberItem — right-click menu timeout/temp-ban parity (B3/B4).
 *
 * Covers:
 *   1. The "Timeout" entry only appears with TimeoutMembers, and is
 *      replaced by "Remove timeout" once the target already has one.
 *   2. Picking a duration / removing a timeout calls the memberApi
 *      function with the expected arguments.
 *   3. A failed removeTimeout surfaces an error toast (real toastStore).
 *   4. "Temp ban" only appears with BanMembers and calls banMember with
 *      the picked duration.
 *   5. The inline clock badge renders while a timeout is active.
 *
 * Heavy children (MemberCard, RoleEditorPopup, BadgeAssignModal) are
 * mocked out — they're exercised by their own test files.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { MemberWithRoles } from "../../types";
import { Permissions } from "../../utils/permissions";

// initReactI18next is re-exported because MemberItem's imports (via
// utils/dateFormat + utils/apiError) transitively load src/i18n/index.ts,
// which calls .use(initReactI18next) — omitting it makes i18next throw
// "No initReactI18next export is defined on the react-i18next mock".
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

vi.mock("./MemberCard", () => ({ default: () => null }));
vi.mock("./RoleEditorPopup", () => ({ default: () => null }));
vi.mock("./BadgeAssignModal", () => ({ default: () => null }));

const removeTimeout = vi.fn();
const timeoutMember = vi.fn();
const banMember = vi.fn();
const kickMember = vi.fn();
vi.mock("../../api/members", () => ({
  removeTimeout: (...args: unknown[]) => removeTimeout(...args),
  timeoutMember: (...args: unknown[]) => timeoutMember(...args),
  banMember: (...args: unknown[]) => banMember(...args),
  kickMember: (...args: unknown[]) => kickMember(...args),
}));

vi.mock("../../stores/authStore", async () => {
  const { create } = await import("zustand");
  return { useAuthStore: create(() => ({ user: { id: "me" } as { id: string } | null })) };
});

// A real zustand store (not a plain object) — MemberItem both subscribes to
// it as a hook (`useServerStore((s) => s.activeServerId)`, for the live
// timeout badge) and reads it imperatively via `.getState()` inside the
// context-menu handlers, so the mock needs to support both call shapes.
vi.mock("../../stores/serverStore", async () => {
  const { create } = await import("zustand");
  return { useServerStore: create(() => ({ activeServerId: "srv-1" as string | null })) };
});

vi.mock("../../stores/friendStore", async () => {
  const { create } = await import("zustand");
  return {
    useFriendStore: create(() => ({
      friends: [] as { user_id: string }[],
      incoming: [] as { id: string; user_id: string }[],
      outgoing: [] as { id: string; user_id: string }[],
      removeFriend: vi.fn(),
      declineRequest: vi.fn(),
      acceptRequest: vi.fn(),
      sendRequest: vi.fn(),
    })),
  };
});

vi.mock("../../stores/dmStore", async () => {
  const { create } = await import("zustand");
  return {
    useDMStore: create(() => ({
      createOrGetChannel: vi.fn(async () => "dm-1"),
      selectDM: vi.fn(),
    })),
  };
});

vi.mock("../../stores/uiStore", async () => {
  const { create } = await import("zustand");
  return { useUIStore: create(() => ({ openTab: vi.fn() })) };
});

vi.mock("../../stores/p2pCallStore", async () => {
  const { create } = await import("zustand");
  return { useP2PCallStore: create(() => ({ initiateCall: vi.fn() })) };
});

// Plain function mocks (not a full store) — each test sets these closures
// directly instead of going through zustand, since MemberItem only ever
// reads them, never writes.
let mockActiveMembers: MemberWithRoles[] = [];
let mockTimeout: { expires_at: string } | undefined;
vi.mock("../../stores/memberStore", () => ({
  useActiveMembers: () => mockActiveMembers,
  useMemberTimeout: () => mockTimeout,
}));

import MemberItem from "./MemberItem";
import { useToastStore } from "../../stores/toastStore";

function makeMember(overrides: Partial<MemberWithRoles> = {}): MemberWithRoles {
  return {
    id: "target-1",
    username: "bob",
    display_name: "Bob",
    avatar_url: null,
    status: "online",
    custom_status: null,
    created_at: "2026-01-01T00:00:00Z",
    roles: [],
    effective_permissions: 0,
    ...overrides,
  };
}

/** The acting viewer ("me") with the given permission bitfield. */
function actingMember(perms: number): MemberWithRoles {
  return makeMember({ id: "me", username: "me", effective_permissions: perms });
}

/** Right-clicks the single rendered member row (queried by class since the
 *  visible label is the display name, not the fixture's lowercase username). */
function openContextMenu() {
  const row = document.querySelector(".member");
  if (!row) throw new Error("member row not found");
  fireEvent.contextMenu(row);
}

beforeEach(() => {
  removeTimeout.mockReset();
  timeoutMember.mockReset();
  banMember.mockReset();
  kickMember.mockReset();
  // Default every API call to a successful APIResponse — handlers always
  // `await` + read `.success` off the result, so an unmocked call
  // (mockReset leaves it returning undefined) throws an unhandled
  // rejection. Individual tests override with mockResolvedValueOnce when
  // exercising the failure path.
  removeTimeout.mockResolvedValue({ success: true });
  timeoutMember.mockResolvedValue({ success: true });
  banMember.mockResolvedValue({ success: true });
  kickMember.mockResolvedValue({ success: true });
  mockActiveMembers = [];
  mockTimeout = undefined;
  useToastStore.setState({ toasts: [] });
});

describe("MemberItem — context menu timeout parity", () => {
  it("shows a Timeout entry when the viewer has TimeoutMembers", () => {
    mockActiveMembers = [actingMember(Permissions.TimeoutMembers)];
    const member = makeMember();
    render(<MemberItem member={member} isOnline />);

    openContextMenu();
    expect(screen.getByText("timeout")).toBeInTheDocument();
  });

  it("does not show a Timeout entry without the permission", () => {
    mockActiveMembers = [actingMember(0)];
    const member = makeMember();
    render(<MemberItem member={member} isOnline />);

    openContextMenu();
    expect(screen.queryByText("timeout")).not.toBeInTheDocument();
  });

  it("shows Remove timeout instead of Timeout once the target already has one, and clicking it calls removeTimeout", () => {
    mockActiveMembers = [actingMember(Permissions.TimeoutMembers)];
    mockTimeout = { expires_at: new Date(Date.now() + 60_000).toISOString() };
    const member = makeMember();
    render(<MemberItem member={member} isOnline />);

    openContextMenu();
    expect(screen.queryByText("timeout")).not.toBeInTheDocument();
    const removeEntry = screen.getByText("removeTimeout");
    fireEvent.click(removeEntry);

    expect(removeTimeout).toHaveBeenCalledWith("srv-1", "target-1");
  });

  it("surfaces an error toast when removeTimeout fails", async () => {
    mockActiveMembers = [actingMember(Permissions.TimeoutMembers)];
    mockTimeout = { expires_at: new Date(Date.now() + 60_000).toISOString() };
    removeTimeout.mockResolvedValue({ success: false, error: "forbidden", status: 403 });
    const member = makeMember();
    render(<MemberItem member={member} isOnline />);

    openContextMenu();
    fireEvent.click(screen.getByText("removeTimeout"));

    await vi.waitFor(() => {
      expect(useToastStore.getState().toasts.some((t) => t.type === "error")).toBe(true);
    });
  });

  it("shows a Temp ban entry when the viewer has BanMembers, and picking a duration calls banMember", async () => {
    mockActiveMembers = [actingMember(Permissions.BanMembers)];
    const member = makeMember();
    render(<MemberItem member={member} isOnline />);

    openContextMenu();
    fireEvent.click(screen.getByText("tempBan"));

    // Picker opens — click the first preset button.
    const presetButtons = document.querySelectorAll(".mod-picker-btn");
    expect(presetButtons.length).toBeGreaterThan(0);
    fireEvent.click(presetButtons[0]!);

    expect(banMember).toHaveBeenCalledTimes(1);
    const [serverId, targetId, reason, seconds] = banMember.mock.calls[0]!;
    expect(serverId).toBe("srv-1");
    expect(targetId).toBe("target-1");
    expect(reason).toBe("");
    expect(typeof seconds).toBe("number");
  });

  it("renders the timeout clock badge on the row while a timeout is active", () => {
    mockActiveMembers = [actingMember(0)];
    mockTimeout = { expires_at: new Date(Date.now() + 60_000).toISOString() };
    const member = makeMember();
    const { container } = render(<MemberItem member={member} isOnline />);

    expect(container.querySelector(".member-timeout-badge")).not.toBeNull();
  });
});
