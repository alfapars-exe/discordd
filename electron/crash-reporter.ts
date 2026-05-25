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

type CrashKind = "render-process-gone" | "child-process-gone";

export type CrashRecord = {
  kind: CrashKind;
  reason: string;
  exitCode?: number;
  serviceName?: string; // child-process-gone only
  processType?: string; // child-process-gone only
  occurredAt: string; // ISO 8601
};

let cachedCrashPath: string | null = null;

function crashFilePath(): string {
  if (cachedCrashPath) return cachedCrashPath;
  cachedCrashPath = path.join(app.getPath("userData"), "last-crash.json");
  return cachedCrashPath;
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
    return JSON.parse(raw) as CrashRecord;
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
