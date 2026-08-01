/**
 * MemberCardModeration — permission-gated action grid (B2/B3).
 *
 * Kick/Timeout/Ban/TempBan/EditRoles buttons render only for the matching
 * permission flag; Timeout/TempBan open the shared duration picker via
 * setPickerMode instead of calling a handler directly.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import MemberCardModeration from "./MemberCardModeration";

type Props = Parameters<typeof MemberCardModeration>[0];

function renderModeration(overrides: Partial<Props> = {}) {
  const handleKick = vi.fn();
  const handleBan = vi.fn();
  const setPickerMode = vi.fn();
  const setShowRoleEditor = vi.fn();
  render(
    <MemberCardModeration
      canKick={false}
      canTimeout={false}
      canBan={false}
      canManageRoles={false}
      handleKick={handleKick}
      handleBan={handleBan}
      setPickerMode={setPickerMode}
      setShowRoleEditor={setShowRoleEditor}
      {...overrides}
    />
  );
  return { handleKick, handleBan, setPickerMode, setShowRoleEditor };
}

describe("MemberCardModeration", () => {
  it("renders no action buttons when every flag is false", () => {
    renderModeration();
    expect(screen.queryByText("kick")).not.toBeInTheDocument();
    expect(screen.queryByText("timeout")).not.toBeInTheDocument();
    expect(screen.queryByText("ban")).not.toBeInTheDocument();
    expect(screen.queryByText("tempBan")).not.toBeInTheDocument();
    expect(screen.queryByText("editRoles")).not.toBeInTheDocument();
  });

  it("renders Kick only when canKick", () => {
    renderModeration({ canKick: true });
    expect(screen.getByText("kick")).toBeInTheDocument();
    expect(screen.queryByText("timeout")).not.toBeInTheDocument();
  });

  it("renders Timeout only when canTimeout", () => {
    renderModeration({ canTimeout: true });
    expect(screen.getByText("timeout")).toBeInTheDocument();
    expect(screen.queryByText("kick")).not.toBeInTheDocument();
  });

  it("renders both Ban and Temp ban when canBan", () => {
    renderModeration({ canBan: true });
    expect(screen.getByText("ban")).toBeInTheDocument();
    expect(screen.getByText("tempBan")).toBeInTheDocument();
  });

  it("renders Edit Roles only when canManageRoles", () => {
    renderModeration({ canManageRoles: true });
    expect(screen.getByText("editRoles")).toBeInTheDocument();
  });

  it("clicking Kick calls handleKick", () => {
    const { handleKick } = renderModeration({ canKick: true });
    fireEvent.click(screen.getByText("kick"));
    expect(handleKick).toHaveBeenCalledTimes(1);
  });

  it("clicking Ban calls handleBan", () => {
    const { handleBan } = renderModeration({ canBan: true });
    fireEvent.click(screen.getByText("ban"));
    expect(handleBan).toHaveBeenCalledTimes(1);
  });

  it("clicking Timeout sets the picker mode to 'timeout'", () => {
    const { setPickerMode } = renderModeration({ canTimeout: true });
    fireEvent.click(screen.getByText("timeout"));
    expect(setPickerMode).toHaveBeenCalledWith("timeout");
  });

  it("clicking Temp ban sets the picker mode to 'tempban'", () => {
    const { setPickerMode } = renderModeration({ canBan: true });
    fireEvent.click(screen.getByText("tempBan"));
    expect(setPickerMode).toHaveBeenCalledWith("tempban");
  });
});
