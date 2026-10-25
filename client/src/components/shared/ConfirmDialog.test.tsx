import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ConfirmDialog from "./ConfirmDialog";
import { useConfirmStore } from "../../stores/confirmStore";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }), initReactI18next: { type: "3rdParty", init: () => {} } }));
describe("confirmation ownership", () => {
  beforeEach(() => useConfirmStore.getState().cancel());
  it("contains keyboard focus and returns it after cancelling the top dialog", async () => {
    const opener = document.createElement("button"); document.body.append(opener); opener.focus();
    render(<ConfirmDialog />);
    let answer!: Promise<boolean>;
    act(() => { answer = useConfirmStore.getState().open({ title: "Discard?", message: "Unsaved form" }); });
    const cancel = screen.getByRole("button", { name: "cancel" });
    const confirm = screen.getByRole("button", { name: "confirm" });
    expect(screen.getByRole("alertdialog", { name: "Discard?" })).toHaveAccessibleDescription("Unsaved form");
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true });
    expect(confirm).toHaveFocus();
    fireEvent.keyDown(confirm, { key: "Tab" });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: "Escape" });
    expect(await answer).toBe(false);
    expect(opener).toHaveFocus(); opener.remove();
  });
  it("settles an overwritten question as cancelled", async () => {
    const old = useConfirmStore.getState().open({ message: "First" });
    const current = useConfirmStore.getState().open({ message: "Second" });
    expect(await old).toBe(false);
    useConfirmStore.getState().confirm();
    expect(await current).toBe(true);
  });
});
