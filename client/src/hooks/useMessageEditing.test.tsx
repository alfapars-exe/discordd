/**
 * Regression tests for QA bug #5 in useMessageEditing: entering edit mode
 * left the browser-default caret at position 0 (fixed by initializing the
 * selection when the conditional textarea mounts), and saveAndExit used trim(), stripping leading
 * whitespace the user typed intentionally (now trimEnd only). Both are
 * pinned here against a real <textarea> in the conditional-mount shape the
 * message component uses.
 */

import { describe, it, expect, vi } from "vitest";
import { StrictMode } from "react";
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
// exists while editing; layout caret initialization sees its committed ref.
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
 * Advances a frame inside act() to observe any delayed caret overwrite.
 */
function flushAnimationFrame() {
  return act(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      }),
  );
}

function renderProbe(initialContent: string | null, saveEdit: (c: string) => unknown, strict = false) {
  // `expose` runs every render, so `latest` always holds the current bag.
  const holder: { latest: UseMessageEditingResult | null } = { latest: null };
  const probe = <Probe initialContent={initialContent} saveEdit={saveEdit}
    expose={(result) => { holder.latest = result; }} />;
  render(strict ? <StrictMode>{probe}</StrictMode> : probe);
  return holder;
}

describe("useMessageEditing — QA bug #5 (edit caret + leading whitespace)", () => {
  it("focuses the textarea and moves the caret to the end of the draft", async () => {
    const content = "hello world";
    const holder = renderProbe(content, vi.fn());

    act(() => holder.latest?.startEdit());

    const textarea = screen.getByLabelText<HTMLTextAreaElement>("edit-message");
    // Probe has no autoFocus: the hook must focus during this commit.
    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(content.length);

    await flushAnimationFrame();

    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(content.length);
    expect(textarea.selectionEnd).toBe(content.length);
  });

  it("preserves a user selection made immediately after opening the editor", async () => {
    const content = "replace this whole message";
    const holder = renderProbe(content, vi.fn());
    act(() => holder.latest?.startEdit());
    const textarea = screen.getByLabelText<HTMLTextAreaElement>("edit-message");
    textarea.focus();
    textarea.setSelectionRange(0, content.length);
    await flushAnimationFrame();
    expect(textarea.selectionStart).toBe(0);
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
  it("does not carry selected mentions from a cancelled edit into the next draft", async () => {
    const save = vi.fn();
    const holder = renderProbe("original", save);
    act(() => holder.latest?.startEdit());
    fireEvent.change(screen.getByLabelText("edit-message"), { target: { value: "@Ali", selectionStart: 4 } });
    act(() => holder.latest?.onMentionSelect({ id: "alice-id", name: "Alice", type: "user" }));
    act(() => holder.latest?.cancel());
    act(() => holder.latest?.startEdit());
    fireEvent.change(screen.getByLabelText("edit-message"), { target: { value: "@Alice is plain text" } });
    await act(async () => { await holder.latest?.saveAndExit(); });
    expect(save).toHaveBeenCalledWith("@Alice is plain text");
  });

  it("does not overwrite a new user selection after inserting a mention", async () => {
    const holder = renderProbe("original", vi.fn());
    act(() => holder.latest?.startEdit());
    const textarea = screen.getByLabelText<HTMLTextAreaElement>("edit-message");
    fireEvent.change(textarea, { target: { value: "@Ali", selectionStart: 4 } });
    act(() => holder.latest?.onMentionSelect({ id: "alice-id", name: "Alice", type: "user" }));
    expect(textarea.value).toBe("@Alice ");
    textarea.setSelectionRange(0, textarea.value.length);
    await flushAnimationFrame();
    expect(textarea.selectionStart).toBe(0);
    expect(textarea.selectionEnd).toBe(textarea.value.length);
  });

  it("does not let an older save completion close a replacement edit session", async () => {
    let finishOld!: () => void;
    const save = vi.fn(() => new Promise<void>(resolve => { finishOld = resolve; }));
    const holder = renderProbe("original", save);
    act(() => holder.latest?.startEdit());
    fireEvent.change(screen.getByLabelText("edit-message"), { target: { value: "old pending edit" } });
    let pending: Promise<void> | undefined;
    act(() => { pending = holder.latest?.saveAndExit(); });
    act(() => holder.latest?.cancel());
    act(() => holder.latest?.startEdit());
    fireEvent.change(screen.getByLabelText("edit-message"), { target: { value: "replacement draft" } });
    await act(async () => { finishOld(); await pending; });
    expect(holder.latest?.isEditing).toBe(true);
    expect(holder.latest?.editContent).toBe("replacement draft");
  });

  it.each([
    { type: "user" as const, strict: false },
    { type: "role" as const, strict: false },
    { type: "user" as const, strict: true },
    { type: "role" as const, strict: true },
  ])("preserves active $type mention tokens and trailing draft (StrictMode=$strict)", async ({ type, strict }) => {
    const save = vi.fn();
    const holder = renderProbe("original", save, strict);
    act(() => holder.latest?.startEdit());
    const textarea = screen.getByLabelText<HTMLTextAreaElement>("edit-message");
    fireEvent.change(textarea, { target: { value: "before @a trailing", selectionStart: 9 } });
    act(() => holder.latest?.onMentionSelect({ id: "selected-id", name: "A+B [team]", type }));
    expect(textarea.value).toBe("before @A+B [team]  trailing");
    expect(textarea.selectionStart).toBe("before @A+B [team] ".length);
    expect(textarea.selectionEnd).toBe(textarea.selectionStart);
    await act(async () => { await holder.latest?.saveAndExit(); });
    const token = type === "role" ? "<@&selected-id>" : "<@selected-id>";
    expect(save).toHaveBeenCalledExactlyOnceWith(`before ${token}  trailing`);
    expect(holder.latest?.isEditing).toBe(false);
  });

});
