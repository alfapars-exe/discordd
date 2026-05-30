/**
 * electron/crash-reporter.ts — Local crash capture.
 *
 * Wires Chromium's native crash reporter (writes .dmp dumps under the user
 * data dir) and listens for render-process-gone / child-process-gone events.
 * On each event we serialize the details to `last-crash.json` so the next
 * successful login can ship it to the server — at the moment of crash the
 * WebSocket is gone and any fetch is racy, so we persist first and send
 * later.
 *
 * Why not upload directly:
 *   - At render-process-gone time the renderer is dead; we can't ask it to
 *     send a fetch on our behalf.
 *   - Doing it from main needs to know which API base URL + access token
 *     to use, which depends on user-configured settings the renderer owns.
 *   - The simplest robust path: persist locally, let the renderer flush on
 *     next login (it knows the API base URL and has a valid token).
 *
 * File location:
 *   %APPDATA%/HiChat/last-crash.json   (Windows)
 *   ~/Library/Application Support/HiChat/last-crash.json  (macOS)
 *   ~/.config/HiChat/last-crash.json   (Linux)
 *
 * Only the most recent crash is kept (overwritten on each event). The
 * server-side admin panel is the long-term archive.
 */

import { app, crashReporter } from "electron";
import { promises as fs } from "fs";
import path from "path";
import { disablePickerThumbnails, isThumbnailCaptureInFlight } from "./picker-safe-mode";
import { appendDiagnostic, flushDiagnostics } from "./diagnostic-log";

type CrashKind = "render-process-gone" | "child-process-gone";

export type CrashRecord = {
  kind: CrashKind;
  reason: string;
  exitCode?: number;
  serviceName?: string; // child-process-gone only
  processType?: string; // child-process-gone only
  occurredAt: string; // ISO 8601
  // Basename of the newest native crash dump under app.getPath('crashDumps').
  // Attached at consumeLastCrash() time, not at write time — Crashpad may
  // still be flushing the .dmp when the listener fires. Lets support ask
  // the user to send a specific file instead of "anything that looks new".
  dumpFile?: string;
};

let cachedCrashPath: string | null = null;

function crashFilePath(): string {
  if (cachedCrashPath) return cachedCrashPath;
  cachedCrashPath = path.join(app.getPath("userData"), "last-crash.json");
  return cachedCrashPath;
}

// Scan the platform-specific crash dump directory and return the basename of
// the most recently modified .dmp. We can't reliably correlate a specific
// .dmp to a specific listener event because Crashpad finalises dumps on its
// own schedule (often hundreds of ms after the listener fires). At drain time
// (next launch), the newest .dmp is the right one: this app singletons, so the
// dump that caused last-crash.json is the freshest one on disk.
async function findLatestCrashDump(): Promise<string | null> {
  // Scan both `pending` and `completed` — Crashpad starts writes in `pending`
  // and moves finalised dumps to `completed`. We don't care which state, just
  // which is newest. On Linux/Breakpad the same `crashDumps` path resolves
  // somewhere with the same .dmp filename convention.
  const root = app.getPath("crashDumps");
  const candidates: { name: string; mtimeMs: number }[] = [];
  for (const sub of ["pending", "completed", ""]) {
    const dir = sub ? path.join(root, sub) : root;
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue; // missing subdir is fine — Crashpad creates them lazily
    }
    for (const name of entries) {
      if (!name.endsWith(".dmp")) continue;
      try {
        const st = await fs.stat(path.join(dir, name));
        candidates.push({ name, mtimeMs: st.mtimeMs });
      } catch {
        // stat race (file deleted between readdir and stat) — skip
      }
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0].name;
}

async function writeCrashRecord(record: CrashRecord): Promise<void> {
  try {
    const file = crashFilePath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(record), "utf8");
    console.warn(`[crash-reporter] persisted ${record.kind}: ${record.reason}`);
  } catch (err) {
    // If we can't even write to userData something is very wrong — fall back
    // to console only. The crash will go undiagnosed but the app continues.
    console.error("[crash-reporter] failed to write crash record:", err);
  }
}

/**
 * Read and delete the persisted crash record, if any.
 * Returns null when there's nothing to report.
 *
 * Called via IPC after a successful login — the renderer ships it to the
 * server and we delete to avoid double-reporting on the next launch.
 */
export async function consumeLastCrash(): Promise<CrashRecord | null> {
  try {
    const file = crashFilePath();
    const raw = await fs.readFile(file, "utf8");
    // Delete first so even if the renderer fetch fails we don't keep
    // re-sending the same record forever. Trade: one missed crash report
    // per network failure, vs. an indefinite duplicate-report loop.
    await fs.unlink(file).catch(() => {});
    const record = JSON.parse(raw) as CrashRecord;
    const dumpFile = await findLatestCrashDump().catch(() => null);
    if (dumpFile) record.dumpFile = dumpFile;
    return record;
  } catch (err: unknown) {
    // ENOENT = no crash, the common case
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return null;
    console.error("[crash-reporter] failed to read crash record:", err);
    return null;
  }
}

/**
 * Initialize crash capture. Must be called BEFORE app.whenReady() so the
 * native crashReporter is registered in time to catch early-life crashes.
 *
 * uploadToServer=false because we have our own pipeline (last-crash.json
 * + admin panel). Setting it true would also try to POST .dmp dumps to a
 * Breakpad/Crashpad submission URL, which we don't run.
 */
export function setupCrashReporter(): void {
  try {
    crashReporter.start({
      productName: "HiChat",
      companyName: "argeinfina",
      submitURL: "https://invalid.local/dummy", // required by Electron API; ignored when uploadToServer=false
      uploadToServer: false,
      compress: true,
    });
  } catch (err) {
    // crashReporter.start can throw on misconfigured environments. We still
    // get the JS-level events below (render-process-gone), so the impact is
    // losing native .dmp files but not the crash event itself.
    console.error("[crash-reporter] crashReporter.start failed:", err);
  }

  // Render process gone — V8 OOM, JS uncaught error in a worker, GPU
  // dependency crash, etc. `details.reason` values include: "clean-exit",
  // "abnormal-exit", "killed", "crashed", "oom", "launch-failed",
  // "integrity-failure". We ignore "clean-exit" (normal close) but capture
  // everything else.
  app.on("render-process-gone", (_event, _webContents, details) => {
    if (details.reason === "clean-exit") return;
    // Renderer died while a thumbnail getSources was in flight → the picker is
    // the prime suspect. Flip safe mode so the next attempt skips capture. This
    // covers the render-crash path where MAIN survives; a main-process crash
    // never reaches here — picker-safe-mode's breadcrumb catches that instead.
    if (isThumbnailCaptureInFlight()) {
      disablePickerThumbnails(`render-process-gone:${details.reason} during thumbnail capture`);
    }
    // Record into the rolling diagnostic log and flush synchronously — this is
    // the kind of event the export bundle exists for, and the renderer (which
    // tees most events) is dead, so main has to write it.
    appendDiagnostic({
      level: "error",
      source: "main",
      category: "crash",
      msg: "render_process_gone",
      meta: { reason: details.reason, exitCode: details.exitCode },
    });
    flushDiagnostics();
    void writeCrashRecord({
      kind: "render-process-gone",
      reason: details.reason,
      exitCode: details.exitCode,
      occurredAt: new Date().toISOString(),
    });
  });

  // Child process gone — covers GPU process, utility processes, network
  // service. GPU crashes during screen share are the prime suspect for the
  // "Electron app vanishes" bug, so capturing this is the whole point of
  // the reporter from this app's perspective.
  app.on("child-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") return;
    // GPU/utility child dying mid-capture → the picker thumbnail path is the
    // prime suspect (this is the documented "GPU crash during screen share").
    // Flip safe mode so the next screen share skips capture.
    if (isThumbnailCaptureInFlight()) {
      disablePickerThumbnails(
        `child-process-gone:${details.type}:${details.reason} during thumbnail capture`,
      );
    }
    appendDiagnostic({
      level: "error",
      source: "main",
      category: "crash",
      msg: "child_process_gone",
      meta: {
        reason: details.reason,
        exitCode: details.exitCode,
        processType: details.type,
        serviceName: details.serviceName,
      },
    });
    flushDiagnostics();
    void writeCrashRecord({
      kind: "child-process-gone",
      reason: details.reason,
      exitCode: details.exitCode,
      serviceName: details.serviceName,
      processType: details.type,
      occurredAt: new Date().toISOString(),
    });
  });
}
