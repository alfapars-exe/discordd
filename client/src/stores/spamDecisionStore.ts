import { create } from "zustand";
import { listSpamDecisions } from "../api/spam";
import { useAuthStore } from "./authStore";
import { getAuthGeneration } from "../api/client";
export type SpamDecision = { user_id: string; source_kind: "channel" | "dm" | "group"; message_id: string; revision: string; status: "restored" | "dismissed" };
type State = { accountId: string | null; decisions: Record<string, SpamDecision>; syncError: boolean; refresh: () => Promise<void>; apply: (decision: SpamDecision) => void };
let generation = 0;
export const useSpamDecisionStore = create<State>((set, get) => ({
  accountId: null, decisions: {},
  syncError: false,
  refresh: async () => {
    const accountId = useAuthStore.getState().user?.id;
    const authGeneration = getAuthGeneration();
    const version = ++generation;
    if (!accountId) { set({ accountId: null, decisions: {}, syncError: false }); return; }
    if (get().accountId !== accountId) set({ accountId, decisions: {} });
    const before = get().decisions;
    const current = () => generation === version && useAuthStore.getState().user?.id === accountId && getAuthGeneration() === authGeneration;
    let cursor = "";
    const seen = new Set<string>();
    do {
      let response: Awaited<ReturnType<typeof listSpamDecisions>>;
      try {
        response = await listSpamDecisions(cursor, current);
      } catch {
        if (current()) set({ syncError: true });
        return;
      }
      if (!current()) return;
      if (!response.success || !response.data) { set({ syncError: true }); return; }
      set((state) => {
        const decisions = { ...state.decisions };
        for (const entry of response.data!.entries) {
          const key = `${entry.source_kind}:${entry.message_id}`;
          if (decisions[key] !== before[key] || !["restored", "dismissed"].includes(entry.status)) continue;
          decisions[key] = { user_id: accountId, source_kind: entry.source_kind, message_id: entry.message_id, revision: entry.revision, status: entry.status as SpamDecision["status"] };
        }
        return { decisions, syncError: false };
      });
      cursor = response.data.next_cursor ?? "";
      if (cursor && seen.has(cursor)) { set({ syncError: true }); return; }
      seen.add(cursor);
    } while (cursor);
  },
  apply: (decision) => set((state) => ({ accountId: decision.user_id, decisions: { ...(state.accountId === decision.user_id ? state.decisions : {}), [`${decision.source_kind}:${decision.message_id}`]: decision } })),
}));
