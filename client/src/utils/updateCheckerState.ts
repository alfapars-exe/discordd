export type UpdateInfo = { version: string };
export type UpdateCheckerState = {
  status: "idle" | "downloading" | "ready";
  update: UpdateInfo | null;
  progress: number;
  downloaded: UpdateInfo | null;
  snoozeToken: number | null;
  snoozeGeneration: number;
};
export type UpdateCheckerEvent =
  | { type: "available"; version: string }
  | { type: "progress"; percent: number }
  | { type: "downloaded"; version: string }
  | { type: "error" }
  | { type: "dismiss" }
  | { type: "resume"; token: number };

export const initialUpdateCheckerState: UpdateCheckerState = {
  status: "idle", update: null, progress: 0, downloaded: null,
  snoozeToken: null, snoozeGeneration: 0,
};

function available(state: UpdateCheckerState, version: string): UpdateCheckerState {
  if (state.downloaded?.version === version) return state;
  return { ...state, status: "downloading", update: { version }, progress: 0, downloaded: null, snoozeToken: null };
}
function downloaded(state: UpdateCheckerState, version: string): UpdateCheckerState {
  if (state.downloaded?.version === version) return state;
  const update = { version };
  return { ...state, status: "ready", update, downloaded: update, progress: 100, snoozeToken: null };
}
function resume(state: UpdateCheckerState, token: number): UpdateCheckerState {
  if (state.snoozeToken !== token) return state;
  if (!state.downloaded) return { ...state, snoozeToken: null };
  return { ...state, status: "ready", update: state.downloaded, progress: 100, snoozeToken: null };
}

/** Pure version/readiness transitions; subscription and timer ownership stay in the hook. */
export function updateCheckerState(state: UpdateCheckerState, event: UpdateCheckerEvent): UpdateCheckerState {
  switch (event.type) {
    case "available": return available(state, event.version);
    case "downloaded": return downloaded(state, event.version);
    case "progress": return state.downloaded ? state : { ...state, progress: Math.round(event.percent) };
    case "error": return state.downloaded ? state : { ...state, status: "idle", update: null, progress: 0 };
    case "dismiss": {
      const generation = state.snoozeGeneration + 1;
      return { ...state, status: "idle", snoozeGeneration: generation, snoozeToken: generation };
    }
    case "resume": return resume(state, event.token);
  }
}
