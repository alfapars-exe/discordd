import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ContextMenu from "./ContextMenu";

describe("ContextMenu", () => {
  it("focuses enabled items, navigates submenus and restores focus on close", () => {
    const origin = document.createElement("button"); document.body.append(origin); origin.focus();
    const close = vi.fn();
    const view = render(<ContextMenu state={{ isOpen:true, x:0, y:0, items:[
      { label:"Unavailable", onClick:vi.fn(), disabled:true },
      { label:"First", onClick:vi.fn() },
      { label:"Applications", onClick:vi.fn(), children:[{ label:"Child", onClick:vi.fn() }] },
    ] }} onClose={close} />);
    expect(screen.getByRole("menuitem", { name:"First" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key:"ArrowDown" });
    expect(screen.getByRole("menuitem", { name:/Applications/ })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key:"ArrowRight" });
    expect(screen.getByRole("menuitem", { name:"Child" })).toHaveFocus();
    // Reflow can move a different row under a stationary pointer on mobile.
    fireEvent.mouseEnter(screen.getByRole("menuitem", { name:"First" }).parentElement!);
    expect(screen.getByRole("menuitem", { name:"Child" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key:"Escape" });
    expect(screen.queryByRole("menuitem", { name:"Child" })).not.toBeInTheDocument();
    expect(close).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement!, { key:"Escape" });
    expect(close).toHaveBeenCalledOnce();
    view.unmount(); expect(origin).toHaveFocus(); origin.remove(); cleanup();
  });
  it("opens a nested applications menu and invokes a granted action", () => {
    const invoke = vi.fn();
    const close = vi.fn();
    render(
      <ContextMenu
        state={{
          isOpen: true,
          x: 10,
          y: 10,
          items: [{
            label: "Applications",
            onClick: () => undefined,
            children: [{ label: "Summarize", onClick: invoke }],
          }],
        }}
        onClose={close}
      />,
    );

    fireEvent.click(screen.getByRole("menuitem", { name: /Applications/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Summarize" }));
    expect(invoke).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("shows but cannot invoke a disabled empty state", () => {
    const invoke = vi.fn();
    render(
      <ContextMenu
        state={{
          isOpen: true,
          x: 10,
          y: 10,
          items: [{
            label: "Applications",
            onClick: () => undefined,
            children: [{ label: "No granted actions", onClick: invoke, disabled: true }],
          }],
        }}
        onClose={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /Applications/ }));
    const empty = screen.getByRole("menuitem", { name: "No granted actions" });
    expect(empty).toBeDisabled();
    fireEvent.click(empty);
    expect(invoke).not.toHaveBeenCalled();
  });
});
