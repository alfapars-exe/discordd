import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAnchoredCard } from "./useAnchoredCard";

function Card({ onClose, childOpen = false }: { onClose: () => void; childOpen?: boolean }) {
  const { cardRef } = useAnchoredCard({ top: 8, left: 8 }, onClose, childOpen);
  return <div ref={cardRef}><input aria-label="Profile note" /></div>;
}

describe("useAnchoredCard keyboard dismissal", () => {
  it("closes on Escape from a focused field and prevents outer default handling", () => {
    const onClose = vi.fn();
    render(<Card onClose={onClose} />);
    screen.getByRole("textbox").focus();
    expect(fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" })).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("leaves child modals and composing input alone, then resumes after child closes", () => {
    const onClose = vi.fn();
    const { rerender } = render(<Card onClose={onClose} childOpen />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    rerender(<Card onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape", isComposing: true });
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("respects handled Escape and removes listeners on unmount", () => {
    const onClose = vi.fn();
    const { unmount } = render(<Card onClose={onClose} />);
    const handled = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    handled.preventDefault();
    document.dispatchEvent(handled);
    unmount();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
