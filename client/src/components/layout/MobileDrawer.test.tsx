import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import MobileDrawer from "./MobileDrawer";

vi.mock("../../utils/uiShell", () => ({ UI_SHELL_V2: true }));
vi.mock("../../hooks/useSwipeGesture", () => ({ useSwipeGesture: () => ({}) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }), initReactI18next: { type: "3rdParty", init: () => {} } }));

describe("V2 mobile drawer accessibility", () => {
  afterEach(() => { document.body.style.overflow = ""; });

  it("keeps a closed drawer mounted but inert and hidden from assistive navigation", () => {
    render(<MobileDrawer side="left" isOpen={false} onClose={vi.fn()}><button>Hidden action</button></MobileDrawer>);
    expect(document.getElementById("mobile-drawer-left")).toHaveAttribute("inert");
    expect(document.getElementById("mobile-drawer-left")).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("button", { name: "Hidden action" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("contains focus, closes on Escape, and restores opener and prior scrolling", async () => {
    document.body.style.overflow = "clip";
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const onClose = vi.fn();
    const content = <><button>First</button><button>Last</button></>;
    const view = render(<MobileDrawer side="left" isOpen onClose={onClose}>{content}</MobileDrawer>);
    expect(screen.getByRole("dialog", { name: "navigation" })).toHaveAttribute("aria-modal", "true");
    await waitFor(() => expect(screen.getByText("First")).toHaveFocus());
    screen.getByText("Last").focus();
    fireEvent.keyDown(screen.getByText("Last"), { key: "Tab" });
    expect(screen.getByText("First")).toHaveFocus();
    fireEvent.keyDown(screen.getByText("First"), { key: "Tab", shiftKey: true });
    expect(screen.getByText("Last")).toHaveFocus();
    opener.focus();
    expect(screen.getByText("First")).toHaveFocus();
    fireEvent.keyDown(screen.getByText("First"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    view.rerender(<MobileDrawer side="left" isOpen={false} onClose={onClose}>{content}</MobileDrawer>);
    expect(opener).toHaveFocus();
    expect(document.body.style.overflow).toBe("clip");
    opener.remove();
  });

  it("yields focus and Escape to a nested settings/dialog portal without closing the drawer", async () => {
    const onClose = vi.fn();
    render(<MobileDrawer side="left" isOpen onClose={onClose}><button>Drawer action</button></MobileDrawer>);
    await waitFor(() => expect(screen.getByText("Drawer action")).toHaveFocus());
    const nested = document.createElement("div");
    nested.setAttribute("role", "dialog");
    const field = document.createElement("button");
    nested.append(field);
    document.body.append(nested);
    field.focus();
    expect(field).toHaveFocus();
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    nested.remove();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not let the other closed drawer disable focus containment", async () => {
    render(<>
      <MobileDrawer side="left" isOpen={false} onClose={vi.fn()}><button>Closed</button></MobileDrawer>
      <MobileDrawer side="right" isOpen onClose={vi.fn()}><button>Member action</button></MobileDrawer>
    </>);
    await waitFor(() => expect(screen.getByText("Member action")).toHaveFocus());
    expect(screen.getByRole("dialog", { name: "members" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByText("Member action"), { key: "Tab" });
    expect(screen.getByText("Member action")).toHaveFocus();
  });
});
