/**
 * Regression tests for QA bug #5 in useMessageEditing: entering edit mode
 * left the browser-default caret at position 0 (fixed with the rAF +
 * setSelectionRange effect), and saveAndExit used trim(), stripping leading
 * whitespace the user typed intentionally (now trimEnd only). Both are
 * pinned here against a real <textarea> in the conditional-mount shape the
 * message component uses.
 */

import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import {
  useMessageEditing,
  type UseMessageEditingResult,
} from "./useMessageEditing";

interface ProbeProps {
  initialContent: string | null;
  saveEdit: (newContent: string) => unknown;
  expose: (result: UseMessageEditingResult) => void;
}

// Mirrors how the message component consumes the hook: the textarea only
// exists while editing, so the caret-placement rAF has to survive the
// textarea mounting in the same commit that flips isEditing.
function Probe({ initialContent, saveEdit, expose }: ProbeProps) {
  const editing = useMessageEditing({ initialContent, saveEdit });
  // Destructure like Message.tsx does — react-hooks/refs treats property
  // access on the ref-carrying bag during render as a ref read.
  const { isEditing, editContent, editTextareaRef, onChange } = editing;
  expose(editing);
  if (!isEditing) return null;
  return (
    <textarea
      ref={editTextareaRef}
      value={editContent}
      onChange={onChange}
      aria-label="edit-message"
    />
  );
}

/**
 * Waits one animation frame inside act(). The hook queues its caret rAF in
 * the effect that runs when isEditing flips, so a frame queued after that
 * effect resolves strictly after the caret callback has run.
 */
function flushAnimationFrame() {
  return act(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      }),
  );
}

function renderProbe(initialContent: string | null, saveEdit: (c: string) => unknown) {
  // `expose` runs every render, so `latest` always holds the current bag.
  const holder: { latest: UseMessageEditingResult | null } = { latest: null };
  render(
    <Probe
      initialContent={initialContent}
      saveEdit={saveEdit}
      expose={(result) => {
        holder.latest = result;
      }}
    />,
  );
  return holder;
}

describe("useMessageEditing — QA bug #5 (edit caret + leading whitespace)", () => {
  it("focuses the textarea and moves the caret to the end of the draft", async () => {
    const content = "hello world";
    const holder = renderProbe(content, vi.fn());

    act(() => holder.latest?.startEdit());

    const textarea = screen.getByLabelText<HTMLTextAreaElement>("edit-message");
    // Force the pre-fix browser-default state (caret at 0) before the rAF
    // fires — proves the assertion below can only pass if the hook's
    // setSelectionRange actually ran, not because jsdom defaulted to end.
    textarea.setSelectionRange(0, 0);

    await flushAnimationFrame();

    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(content.length);
    expect(textarea.selectionEnd).toBe(content.length);
  });

  it("preserves leading whitespace on save and trims only the trailing run", async () => {
    const saveEdit = vi.fn();
    const holder = renderProbe("old content", saveEdit);

    act(() => holder.latest?.startEdit());
    await flushAnimationFrame();

    const textarea = screen.getByLabelText<HTMLTextAreaElement>("edit-message");
    fireEvent.change(textarea, { target: { value: "   indented reply   " } });
    expect(holder.latest?.editContent).toBe("   indented reply   ");

    await act(async () => {
      await holder.latest?.saveAndExit();
    });

    expect(saveEdit).toHaveBeenCalledTimes(1);
    expect(saveEdit).toHaveBeenCalledWith("   indented reply");
    expect(holder.latest?.isEditing).toBe(false);
  });
});
