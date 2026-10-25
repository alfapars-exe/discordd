import { app, contentTracing, dialog } from "electron";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scrubPerformanceTrace } from "./performance-trace-scrub";

const TRACE_DURATION_MS = 30_000;
let active: { cancelled: boolean; stop: () => Promise<string> } | null = null;

export type PerformanceTraceResult = { saved: boolean; cancelled: boolean; path?: string };

export async function capturePerformanceTrace(): Promise<PerformanceTraceResult> {
  if (active) throw new Error("performance trace already active");
  const chosen = await dialog.showSaveDialog({
    title: "HiChat! performance trace",
    defaultPath: path.join(app.getPath("downloads"), `hichat-performance-${Date.now()}.json`),
    filters: [{ name: "JSON trace", extensions: ["json"] }],
  });
  if (chosen.canceled || !chosen.filePath) return { saved: false, cancelled: true };

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "hichat-trace-"));
  const rawPath = path.join(tempDir, "raw.json");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let stopping: Promise<string> | null = null;
  const stop = () => {
    if (!stopping) stopping = contentTracing.stopRecording(rawPath);
    return stopping;
  };
  const state = { cancelled: false, stop };
  try {
    await contentTracing.startRecording({
      included_categories: ["benchmark", "blink", "browser", "cc", "gpu", "netlog", "renderer.scheduler", "toplevel"],
      excluded_categories: ["disabled-by-default-memory-infra"],
      recording_mode: "record-until-full",
    });
    active = state;
    await Promise.race([
      new Promise<void>((resolve) => { timer = setTimeout(resolve, TRACE_DURATION_MS); }),
      new Promise<void>((resolve) => {
        poll = setInterval(() => {
          if (state.cancelled) {
            if (poll) clearInterval(poll);
            resolve();
          }
        }, 100);
      }),
    ]);
    await stop();
    if (state.cancelled) return { saved: false, cancelled: true };
    const raw = await readFile(rawPath, "utf8");
    await writeFile(chosen.filePath, scrubPerformanceTrace(raw), "utf8");
    return { saved: true, cancelled: false, path: chosen.filePath };
  } finally {
    if (timer) clearTimeout(timer);
    if (poll) clearInterval(poll);
    if (active === state) active = null;
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function cancelPerformanceTrace(): Promise<boolean> {
  if (!active) return false;
  active.cancelled = true;
  await active.stop();
  return true;
}
