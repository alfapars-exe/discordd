/**
 * User Note Store — the viewer's private notes about other users, keyed by
 * user id. Fetched lazily when a MemberCard opens; saved on blur / Ctrl+Enter.
 */

import { create } from "zustand";
import * as userNotesApi from "../api/userNotes";
import type { UserNote } from "../types";

type UserNoteState = {
  notesByUserId: Record<string, UserNote>;
  /** userId -> fetch in flight (MemberCardNote shows nothing until it lands). */
  loadingByUserId: Record<string, boolean>;

  fetchNote: (userId: string) => Promise<void>;
  /** Resolves true on success; "" clears the note server-side. */
  saveNote: (userId: string, note: string) => Promise<boolean>;
  /** Drop the notes cache (logout) — notes are private to one account. */
  reset: () => void;
};

/** Bumped by reset(); in-flight requests from before it drop their result. */
let generation = 0;

export const useUserNoteStore = create<UserNoteState>((set, get) => ({
  notesByUserId: {},
  loadingByUserId: {},

  fetchNote: async (userId) => {
    if (get().loadingByUserId[userId]) return;
    const gen = generation;
    set((s) => ({ loadingByUserId: { ...s.loadingByUserId, [userId]: true } }));
    try {
      const res = await userNotesApi.getUserNote(userId);
      if (gen === generation && res.success && res.data) {
        const note = res.data;
        set((s) => ({ notesByUserId: { ...s.notesByUserId, [userId]: note } }));
      }
    } finally {
      if (gen === generation) {
        set((s) => ({ loadingByUserId: { ...s.loadingByUserId, [userId]: false } }));
      }
    }
  },

  saveNote: async (userId, note) => {
    const gen = generation;
    const res = await userNotesApi.putUserNote(userId, note);
    if (gen !== generation) return false;
    if (!res.success || !res.data) return false;
    const saved = res.data;
    set((s) => ({ notesByUserId: { ...s.notesByUserId, [userId]: saved } }));
    return true;
  },

  reset: () => {
    generation += 1;
    set({ notesByUserId: {}, loadingByUserId: {} });
  },
}));
