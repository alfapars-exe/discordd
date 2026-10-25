import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useKeyboardReorder, moveReorderItem, moveWithinGroup, type ReorderItem } from "./keyboardReorder";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) => {
      const templates: Record<string, string> = {
        reorderPickedUp: "Picked up {{label}}, position {{position}} of {{size}}.",
        reorderMoving: "Moving {{label}}, position {{position}} of {{size}}.",
        reorderSaved: "Order saved.",
        reorderCancelled: "Reordering cancelled.",
        reorderSaveFailed: "Could not save the order. Retry or cancel.",
        reorderRetry: "Retry",
        reorderCancel: "Cancel",
      };
      return (templates[key] ?? key).replace(/{{(\w+)}}/g, (_, name: string) => String(values?.[name] ?? ""));
    },
  }),
}));

const items: ReorderItem[] = [
  { id: "one", label: "One" },
  { id: "two", label: "Two" },
  { id: "three", label: "Three" },
];

function Harness({ commit, enabled = true, scope = "server-a" }: { commit: (ids: string[]) => Promise<boolean>; enabled?: boolean; scope?: string }) {
  const reorder = useKeyboardReorder(items, enabled, commit, scope);
  return (
    <div>
      {reorder.orderedItems.map((item) => (
        <button key={item.id} onKeyDown={(event) => reorder.onKeyDown(event, item.id)}>{item.label}</button>
      ))}
      {reorder.liveRegion}
    </div>
  );
}

describe("keyboard reorder", () => {
  it("moves a preview without committing until the drop key", async () => {
    const commit = vi.fn(async () => true);
    render(<Harness commit={commit} />);
    const one = screen.getByRole("button", { name: "One" });

    fireEvent.keyDown(one, { key: "d", code: "KeyD", ctrlKey: true });
    fireEvent.keyDown(one, { key: "ArrowDown", code: "ArrowDown" });
    expect(screen.getAllByRole("button").slice(0, 3).map((button) => button.textContent)).toEqual(["Two", "One", "Three"]);
    expect(commit).not.toHaveBeenCalled();
    expect(screen.getByText(/Moving One, position 2 of 3/)).toBeInTheDocument();

    fireEvent.keyDown(one, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(commit).toHaveBeenCalledWith(["two", "one", "three"]));
  });

  it("restores the saved visual order on failure and exposes an explicit retry", async () => {
    const commit = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<Harness commit={commit} />);
    const one = screen.getByRole("button", { name: "One" });
    fireEvent.keyDown(one, { key: "d", code: "KeyD", ctrlKey: true });
    fireEvent.keyDown(one, { key: "ArrowDown", code: "ArrowDown" });
    fireEvent.keyDown(one, { key: "Enter", code: "Enter" });

    await screen.findByRole("alert");
    expect(screen.getAllByRole("button").slice(0, 3).map((button) => button.textContent)).toEqual(["One", "Two", "Three"]);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(2));
    expect(commit).toHaveBeenNthCalledWith(2, ["two", "one", "three"]);
  });

  it("does not reorder through an editor field or when cancelled", () => {
    expect(moveReorderItem(["a", "b"], "a", -1)).toEqual(["a", "b"]);
    expect(moveReorderItem(["a", "b"], "missing", 1)).toEqual(["a", "b"]);
    const commit = vi.fn(async () => true);
    render(<>
      <Harness commit={commit} />
      <input aria-label="Rename" />
    </>);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Rename" }), { key: "d", code: "KeyD", ctrlKey: true });
    expect(screen.queryByText(/Picked up/)).not.toBeInTheDocument();

    const one = screen.getByRole("button", { name: "One" });
    fireEvent.keyDown(one, { key: "d", code: "KeyD", ctrlKey: true });
    fireEvent.keyDown(one, { key: "Escape", code: "Escape" });
    expect(commit).not.toHaveBeenCalled();
    expect(screen.getAllByRole("button").slice(0, 3).map((button) => button.textContent)).toEqual(["One", "Two", "Three"]);
  });

  it("keeps channel-list keyboard moves inside their existing category", () => {
    const grouped: ReorderItem[] = [
      { id: "a1", label: "A1", groupId: "a" },
      { id: "a2", label: "A2", groupId: "a" },
      { id: "b1", label: "B1", groupId: "b" },
    ];
    expect(moveWithinGroup(["a1", "a2", "b1"], "a1", 1, grouped)).toEqual(["a2", "a1", "b1"]);
    expect(moveWithinGroup(["a1", "a2", "b1"], "a2", -1, grouped)).toEqual(["a2", "a1", "b1"]);
    const interleaved: ReorderItem[] = [
      { id: "a1", label: "A1", groupId: "a" },
      { id: "b1", label: "B1", groupId: "b" },
      { id: "a2", label: "A2", groupId: "a" },
      { id: "b2", label: "B2", groupId: "b" },
      { id: "a3", label: "A3", groupId: "a" },
    ];
    expect(moveWithinGroup(["a1", "b1", "a2", "b2", "a3"], "a3", -1, interleaved)).toEqual(["a1", "b1", "a3", "a2", "b2"]);
    expect(moveWithinGroup(["a1", "b1", "a2", "b2", "a3"], "a1", -1, interleaved)).toEqual(["a1", "b1", "a2", "b2", "a3"]);
    expect(moveWithinGroup(["a1", "b1", "a2", "b2", "a3"], "a3", 1, interleaved)).toEqual(["a1", "b1", "a2", "b2", "a3"]);
  });

  it("rechecks permission and scope before persisting, and prevents duplicate in-flight commits", async () => {
    let resolveCommit: ((ok: boolean) => void) | undefined;
    const commit = vi.fn(() => new Promise<boolean>((resolve) => { resolveCommit = resolve; }));
    const view = render(<Harness commit={commit} />);
    const one = screen.getByRole("button", { name: "One" });
    fireEvent.keyDown(one, { key: "d", code: "KeyD", ctrlKey: true });
    fireEvent.keyDown(one, { key: "ArrowDown", code: "ArrowDown" });
    view.rerender(<Harness commit={commit} enabled={false} />);
    fireEvent.keyDown(one, { key: "Enter", code: "Enter" });
    expect(commit).not.toHaveBeenCalled();

    view.rerender(<Harness commit={commit} />);
    fireEvent.keyDown(one, { key: "d", code: "KeyD", ctrlKey: true });
    fireEvent.keyDown(one, { key: "Enter", code: "Enter" });
    fireEvent.keyDown(one, { key: "Enter", code: "Enter" });
    expect(commit).toHaveBeenCalledTimes(1);
    resolveCommit?.(true);
    await waitFor(() => expect(screen.getByText("Order saved.")).toBeInTheDocument());

    fireEvent.keyDown(one, { key: "d", code: "KeyD", ctrlKey: true });
    view.rerender(<Harness commit={commit} scope="server-b" />);
    fireEvent.keyDown(one, { key: "Enter", code: "Enter" });
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("discards an in-flight completion after the owning scope changes", async () => {
    let resolveCommit: ((ok: boolean) => void) | undefined;
    const commit = vi.fn(() => new Promise<boolean>((resolve) => { resolveCommit = resolve; }));
    const view = render(<Harness commit={commit} />);
    const one = screen.getByRole("button", { name: "One" });
    const focusSpy = vi.spyOn(one, "focus");
    fireEvent.keyDown(one, { key: "d", code: "KeyD", ctrlKey: true });
    fireEvent.keyDown(one, { key: "Enter", code: "Enter" });
    expect(commit).toHaveBeenCalledTimes(1);

    view.rerender(<Harness commit={commit} scope="another-account" />);
    resolveCommit?.(true);
    await waitFor(() => expect(screen.queryByText("Order saved.")).not.toBeInTheDocument());
    expect(focusSpy).not.toHaveBeenCalled();
  });
});
