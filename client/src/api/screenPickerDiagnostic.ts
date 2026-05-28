/**
 * screenPickerDiagnostic — forward main-process screen picker events to /client-log.
 *
 * The Electron main process emits structured diagnostic events from
 * `electron/screen-picker.ts` (request_handler_start, sources_query_*,
 * picker_shown, result_received, handler_error, …). On their own the
 * renderer never sees them — they sit in the main process's IPC pipe.
 * This module attaches one preload listener at boot and rewrites each
 * event into a `screen_picker_<phase>` row on the admin app-logs feed
 * so they sit alongside the renderer's own `screen_share_attempt` /
 * `screen_share_attempt_post` rows.
 *
 * Pairing the renderer rows with the picker rows tells us exactly which
 * leg of the publish path broke when a user reports "I clicked share
 * screen and the app vanished":
 *
 *   attempt           rendered (ok)
 *   attempt_post      rendered after one event-loop tick (still alive)
 *   request_handler_start   main process got the displayMedia handler call
 *   sources_query_start     desktopCapturer.getSources() called
 *   sources_query_done|error  result or timeout
 *   picker_shown            sources sent to renderer, UI should be visible
 *   result_received|cancelled  user clicked something, callback returning
 *   handler_error           thrown unhandled in the handler
 *
 * Missing rows between `attempt` and `result_received` localise the
 * crash to a specific main-process stage. See plan
 * `info-ws-ramses-user-spicy-cascade.md` for the diagnosis flow.
 *
 * Idempotent — guarded by a module-level boolean so a double-mount under
 * StrictMode or HMR doesn't register two listeners.
 */

import { logToServer } from "./clientLog";
import { isElectron } from "../utils/constants";

let installed = false;

// Phases we treat as warnings/errors instead of plain info. Everything not
// listed lands at "info". Keep the set tight so the WARN feed stays
// meaningful for an operator scanning the panel.
const WARN_PHASES = new Set<string>(["sources_query_error", "no_sources"]);
const ERROR_PHASES = new Set<string>(["handler_error"]);

function levelFor(phase: string): "info" | "warn" | "error" {
  if (ERROR_PHASES.has(phase)) return "error";
  if (WARN_PHASES.has(phase)) return "warn";
  return "info";
}

export function installScreenPickerDiagnosticForwarder(): void {
  if (installed) return;
  if (!isElectron()) return;
  const api = window.electronAPI;
  if (!api?.onScreenPickerDiagnostic) return;
  installed = true;

  api.onScreenPickerDiagnostic((event) => {
    const { phase, timestamp, ...rest } = event;
    if (typeof phase !== "string") return;
    // logToServer's metadata is Record<string, scalar>; coerce values
    // that may be objects/arrays into JSON strings so the admin row
    // shows something readable rather than "[object Object]".
    const meta: Record<string, string | number | boolean | null | undefined> = {
      mainTimestamp: typeof timestamp === "number" ? timestamp : null,
    };
    for (const [k, v] of Object.entries(rest)) {
      if (v === null || v === undefined) continue;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        meta[k] = v;
      } else {
        try {
          meta[k] = JSON.stringify(v).slice(0, 256);
        } catch {
          meta[k] = String(v).slice(0, 256);
        }
      }
    }
    logToServer(levelFor(phase), `screen_picker_${phase}`, meta);
  });
}
