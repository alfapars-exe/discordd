/**
 * MemberCardNote — fetch on mount, save on blur only when changed, Ctrl+Enter
 * save, over-limit guard, and the "last edited" line.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && "when" in opts ? `${key}:${String(opts.when)}` : key,
    i18n: { language: "en" },
  }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

vi.mock("../../../utils/dateFormat", () => ({
  formatRelativePast: (iso: string) => `rel(${iso})`,
}));

vi.mock("../../../stores/userNoteStore", async () => {
  const { create } = await vi.importActual<typeof import("zustand")>("zustand");
  return {
    useUserNoteStore: create(() => ({
      notesByUserId: {} as Record<string, { note: string; updated_at: string | null }>,
      fetchNote: vi.fn(async () => {}),
      saveNote: vi.fn(async () => true),
    })),
  };
});

vi.mock("../../../stores/toastStore", async () => {
  const { create } = await vi.importActual<typeof import("zustand")>("zustand");
  return { useToastStore: create(() => ({ addToast: vi.fn() })) };
});

import MemberCardNote from "./MemberCardNote";
import { useUserNoteStore } from "../../../stores/userNoteStore";
import { useToastStore } from "../../../stores/toastStore";

const saveNote = () => vi.mocked(useUserNoteStore.getState().saveNote);
const fetchNote = () => vi.mocked(useUserNoteStore.getState().fetchNote);
const addToast = () => vi.mocked(useToastStore.getState().addToast);

beforeEach(() => {
  vi.clearAllMocks();
  useUserNoteStore.setState({ notesByUserId: {} });
});

describe("MemberCardNote", () => {
  it("fetches the note on mount and renders the stored text + last edited", () => {
    useUserNoteStore.setState({
      notesByUserId: { "u-2": { note: "met at demo", updated_at: "2026-10-20T10:00:00Z" } },
    });
    render(<MemberCardNote userId="u-2" />);
    expect(fetchNote()).toHaveBeenCalledWith("u-2");
    expect(screen.getByLabelText("userNote")).toHaveValue("met at demo");
    expect(screen.getByText("userNoteLastEdited:rel(2026-10-20T10:00:00Z)")).toBeInTheDocument();
  });

  it("saves on blur only when the text changed", async () => {
    useUserNoteStore.setState({ notesByUserId: { "u-2": { note: "same", updated_at: null } } });
    render(<MemberCardNote userId="u-2" />);
    const input = screen.getByLabelText("userNote");

    // Untouched → blur is a no-op.
    await act(async () => { fireEvent.blur(input); });
    expect(saveNote()).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "changed" } });
    await act(async () => { fireEvent.blur(input); });
    expect(saveNote()).toHaveBeenCalledWith("u-2", "changed");
    expect(addToast()).toHaveBeenCalledWith("success", "userNoteSaved");
  });

  it("saves on Ctrl+Enter", async () => {
    render(<MemberCardNote userId="u-3" />);
    const input = screen.getByLabelText("userNote");
    fireEvent.change(input, { target: { value: "quick" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    });
    expect(saveNote()).toHaveBeenCalledWith("u-3", "quick");
  });

  it("refuses to save an over-limit note and warns instead", async () => {
    render(<MemberCardNote userId="u-4" />);
    const input = screen.getByLabelText("userNote");
    fireEvent.change(input, { target: { value: "x".repeat(1025) } });
    await act(async () => { fireEvent.blur(input); });
    expect(saveNote()).not.toHaveBeenCalled();
    expect(addToast()).toHaveBeenCalledWith("warning", "userNoteTooLong");
  });

  it("toasts an error when the save fails", async () => {
    saveNote().mockResolvedValueOnce(false);
    render(<MemberCardNote userId="u-5" />);
    const input = screen.getByLabelText("userNote");
    fireEvent.change(input, { target: { value: "will fail" } });
    await act(async () => { fireEvent.blur(input); });
    expect(addToast()).toHaveBeenCalledWith("error", "userNoteSaveError");
  });
});
