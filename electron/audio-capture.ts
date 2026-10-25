/**
 * electron/audio-capture.ts — Process-exclusive system audio capture.
 *
 * The main process owns the native WASAPI child. Startup resolves only after
 * a valid PCM header arrives; all failure paths reject with safe, path-free
 * errors and invalidate stale child events before cleanup.
 */

import { app } from "electron";
import { spawn as nodeSpawn, type ChildProcess } from "child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { getMainWindow } from "./window";
import { appendDiagnostic } from "./diagnostic-log";

type Header = { sampleRate: number; channels: number; bitsPerSample: number; formatTag: number };
type CaptureProcess = Pick<ChildProcess, "stdout" | "stderr" | "kill" | "on" | "removeAllListeners">;
type WorkerDependencies = {
  platform: string;
  processId: number;
  exePath: () => string;
  exists: (filename: string) => boolean;
  spawn: (filename: string, args: string[], options: { stdio: ["pipe", "pipe", "pipe"] }) => CaptureProcess;
  getWindow: typeof getMainWindow;
  log: typeof appendDiagnostic;
  startupTimeoutMs: number;
  shutdownTimeoutMs: number;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
};

const FLUSH_INTERVAL_MS = 20;
const MAX_BUFFER_BYTES = 100 * 1024;
const DEFAULT_STARTUP_TIMEOUT_MS = 5000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2000;
export type SystemCaptureStatus = {
  state: "unavailable" | "stopped" | "starting" | "running" | "error";
  reason?: "unsupported_platform" | "helper_missing" | "permission_denied" | "spawn_failed" | "startup_timeout" | "invalid_audio_format" | "exited_before_ready" | "runtime_error";
  owner?: "screen_share" | "diagnostic";
};
type CaptureOwner = { kind: "screen-share" } | { kind: "diagnostic"; token: string };

/** Factory seam for deterministic lifecycle tests; production uses Electron defaults. */
export function createAudioCaptureWorker(deps: WorkerDependencies) {
  let captureProcess: CaptureProcess | null = null;
  let captureGeneration = 0;
  let headerParsed = false;
  let headerBuffer = Buffer.alloc(0);
  let pcmBuffer: Buffer[] = [];
  let pcmBufferBytes = 0;
  let pcmDroppedBytes = 0;
  let frameSizeBytes = 0;
  let pcmRemainder = Buffer.alloc(0);
  let flushTimer: ReturnType<typeof setInterval> | null = null;
  let pendingStart: { generation: number; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  let captureOwner: CaptureOwner | null = null;
  let lastError: SystemCaptureStatus["reason"];

  function publicReason(reason: string): SystemCaptureStatus["reason"] {
    switch (reason) {
      case "helper_missing": case "startup_timeout": case "invalid_audio_format": case "exited_before_ready": case "permission_denied": case "spawn_failed": return reason;
      default: return "runtime_error";
    }
  }

  function status(): SystemCaptureStatus {
    if (deps.platform !== "win32") return { state: "unavailable", reason: "unsupported_platform" };
    const owner = captureOwner?.kind === "screen-share" ? "screen_share" : captureOwner?.kind;
    if (pendingStart) return { state: "starting", ...(owner ? { owner } : {}) };
    if (captureProcess && headerParsed) return { state: "running", ...(owner ? { owner } : {}) };
    try { if (!deps.exists(deps.exePath())) return { state: "unavailable", reason: "helper_missing" }; }
    catch { return { state: "unavailable", reason: "helper_missing" }; }
    if (lastError) return { state: "error", reason: lastError, ...(owner ? { owner } : {}) };
    return { state: "stopped", ...(owner ? { owner } : {}) };
  }

  function sendCaptureEvent(channel: string, value?: unknown): void {
    if (captureOwner?.kind !== "screen-share") return;
    deps.getWindow()?.webContents.send(channel, value);
  }

  const nativeLog = (level: "info" | "warn" | "error", msg: string, meta?: Record<string, unknown>) =>
    deps.log({ level, source: "native", category: "audio", msg, meta });

  function flushPcmBuffer(): void {
    if (pcmBuffer.length === 0) return;
    if (captureOwner?.kind !== "screen-share") { pcmBuffer = []; pcmBufferBytes = 0; return; }
    const win = deps.getWindow();
    if (!win || win.isDestroyed()) { pcmBuffer = []; pcmBufferBytes = 0; return; }
    const merged = pcmBuffer.length === 1 ? pcmBuffer[0] : Buffer.concat(pcmBuffer, pcmBufferBytes);
    pcmBuffer = []; pcmBufferBytes = 0;
    win.webContents.send("capture-audio-data", merged);
  }

  function startFlushTimer(): void {
    if (!flushTimer) flushTimer = deps.setInterval(flushPcmBuffer, FLUSH_INTERVAL_MS);
  }

  function stopFlushTimer(): void {
    if (flushTimer) { deps.clearInterval(flushTimer); flushTimer = null; }
    pcmBuffer = []; pcmBufferBytes = 0; pcmDroppedBytes = 0;
    // At shutdown no later chunk can complete this partial frame. It is
    // bounded to frameSizeBytes - 1 and intentionally discarded.
    pcmRemainder = Buffer.alloc(0); frameSizeBytes = 0;
  }

  function enqueuePcm(chunk: Buffer): void {
    if (captureOwner?.kind !== "screen-share") return;
    if (frameSizeBytes <= 0) return;
    const data = pcmRemainder.length ? Buffer.concat([pcmRemainder, chunk]) : chunk;
    const alignedLength = data.length - (data.length % frameSizeBytes);
    pcmRemainder = Buffer.from(data.subarray(alignedLength));
    if (alignedLength === 0) return;
    const aligned = data.subarray(0, alignedLength);
    if (pcmBufferBytes + alignedLength > MAX_BUFFER_BYTES) {
      // Both the buffered data and this chunk contain whole frames, so an
      // overflow drops complete frames only and cannot shift channel/sample
      // boundaries in the next delivered batch.
      pcmDroppedBytes += pcmBufferBytes + alignedLength;
      pcmBuffer = []; pcmBufferBytes = 0;
      if (pcmDroppedBytes >= 1024 * 1024) {
        console.warn(`[audio-capture] renderer behind — dropped ${pcmDroppedBytes} bytes of PCM data`);
        nativeLog("warn", "audio_capture_pcm_dropped", { bytes: pcmDroppedBytes });
        pcmDroppedBytes = 0;
      }
      return;
    }
    pcmBuffer.push(aligned); pcmBufferBytes += alignedLength;
  }

  function clearPending(error?: Error): void {
    const pending = pendingStart;
    if (!pending) return;
    pendingStart = null;
    deps.clearTimeout(pending.timer);
    if (error) pending.reject(error); else pending.resolve();
  }

  function safeKill(proc: CaptureProcess | null): void {
    if (!proc) return;
    try { proc.kill(); } catch { /* A process that already exited needs no cleanup. */ }
  }

  function failStartup(generation: number, reason: string, code?: string): void {
    if (generation !== captureGeneration) return;
    const proc = captureProcess;
    captureProcess = null;
    headerParsed = false;
    stopFlushTimer();
    captureGeneration++;
    const safeReason = reason;
    nativeLog("error", "audio_capture_start_failed", code ? { reason: safeReason, code } : { reason: safeReason });
    sendCaptureEvent("capture-audio-error", `START ERROR: ${safeReason}`);
    sendCaptureEvent("capture-audio-stopped");
    lastError = publicReason(reason);
    captureOwner = null;
    clearPending(new Error(`System audio capture could not start (${safeReason}).`));
    safeKill(proc);
  }

  function validHeader(header: Header): boolean {
    return Number.isInteger(header.sampleRate) && header.sampleRate >= 8000 && header.sampleRate <= 192000
      && Number.isInteger(header.channels) && header.channels >= 1 && header.channels <= 8
      && Number.isInteger(header.formatTag) && ((header.formatTag === 3 && header.bitsPerSample === 32)
        || (header.formatTag === 1 && header.bitsPerSample === 16));
  }

  function handleExit(generation: number, code: number | null): void {
    if (generation !== captureGeneration) return;
    nativeLog(code === 0 ? "info" : "warn", "audio_capture_exit", { gen: generation, code });
    if (pendingStart?.generation === generation) {
      failStartup(generation, "exited_before_ready", code === null ? undefined : String(code));
      return;
    }
    // Invalidate this process before notifying the renderer. Some child
    // streams can still drain data/error events after `exit`.
    captureGeneration++;
    flushPcmBuffer(); stopFlushTimer();
    sendCaptureEvent("capture-audio-error", `EXIT code=${code}`);
    captureProcess = null; headerParsed = false;
    sendCaptureEvent("capture-audio-stopped");
    lastError = "runtime_error"; captureOwner = null;
  }

  function startNative(): Promise<void> {
    if (deps.platform !== "win32") return Promise.reject(new Error("System audio capture is unavailable on this platform."));
    if (pendingStart) {
      const previous = captureProcess;
      captureProcess = null; captureGeneration++;
      clearPending(new Error("System audio capture start was superseded."));
      safeKill(previous); stopFlushTimer();
    } else if (captureProcess) {
      const previous = captureProcess;
      captureProcess = null; captureGeneration++;
      safeKill(previous); stopFlushTimer();
    }
    const generation = ++captureGeneration;
    headerParsed = false; headerBuffer = Buffer.alloc(0); stopFlushTimer();
    const filename = deps.exePath();
    if (!deps.exists(filename)) return Promise.reject(new Error("System audio capture helper is not installed."));
    lastError = undefined;
    nativeLog("info", "audio_capture_start", { gen: generation });

    return new Promise<void>((resolve, reject) => {
      const timer = deps.setTimeout(() => failStartup(generation, "startup_timeout"), deps.startupTimeoutMs);
      pendingStart = { generation, resolve, reject, timer };
      let proc: CaptureProcess;
      try {
        proc = deps.spawn(filename, [deps.processId.toString()], { stdio: ["pipe", "pipe", "pipe"] });
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
        failStartup(generation, code === "ENOENT" ? "helper_missing" : code === "EACCES" ? "permission_denied" : "spawn_failed", code);
        return;
      }
      captureProcess = proc;

      proc.stdout?.on("data", (chunk: Buffer) => {
        if (generation !== captureGeneration || !Buffer.isBuffer(chunk)) return;
        const win = deps.getWindow();
        if (!headerParsed) {
          headerBuffer = Buffer.concat([headerBuffer, chunk]);
          if (headerBuffer.length < 12) return;
          const header = {
            sampleRate: headerBuffer.readUInt32LE(0), channels: headerBuffer.readUInt16LE(4),
            bitsPerSample: headerBuffer.readUInt16LE(6), formatTag: headerBuffer.readUInt32LE(8),
          };
          if (!validHeader(header)) { failStartup(generation, "invalid_audio_format"); return; }
          frameSizeBytes = header.channels * (header.bitsPerSample / 8);
          console.log(`[audio-capture] format gen=${generation}: ${header.sampleRate}Hz ${header.channels}ch ${header.bitsPerSample}bit tag=${header.formatTag}`);
          sendCaptureEvent("capture-audio-header", header);
          nativeLog("info", "audio_capture_format", header);
          headerParsed = true;
          if (captureOwner?.kind === "screen-share") startFlushTimer();
          const remaining = headerBuffer.subarray(12);
          if (remaining.length) enqueuePcm(remaining);
          headerBuffer = Buffer.alloc(0);
          if (pendingStart?.generation === generation) clearPending();
        } else enqueuePcm(chunk);
      });

      proc.stderr?.on("data", (data: Buffer) => {
        if (generation !== captureGeneration) return;
        const msg = data.toString().trim();
        console.log(`[audio-capture] stderr: ${msg}`);
        nativeLog("warn", "audio_capture_stderr", { detail: msg });
        sendCaptureEvent("capture-audio-error", msg);
      });
      proc.on("exit", (code: number | null) => handleExit(generation, code));
      proc.on("error", (error: NodeJS.ErrnoException) => {
        if (generation !== captureGeneration) return;
        const code = typeof error.code === "string" ? error.code : undefined;
        if (pendingStart?.generation === generation) failStartup(generation, code === "ENOENT" ? "helper_missing" : code === "EACCES" ? "permission_denied" : "spawn_failed", code);
        else {
          nativeLog("error", "audio_capture_runtime_error", { code: code ?? "unknown" });
          const failedProcess = captureProcess;
          captureGeneration++;
          stopFlushTimer(); captureProcess = null; headerParsed = false;
          sendCaptureEvent("capture-audio-error", "Capture process failed.");
          sendCaptureEvent("capture-audio-stopped");
          lastError = "runtime_error"; captureOwner = null;
          safeKill(failedProcess);
        }
      });
    });
  }

  function start(): Promise<void> {
    if (captureOwner?.kind === "diagnostic") {
      // A live screen share has priority over an opt-in diagnostic run.
      stopNative();
      captureOwner = null;
    }
    captureOwner = { kind: "screen-share" };
    lastError = undefined;
    return startNative().catch(error => {
      if (captureOwner?.kind === "screen-share" && !captureProcess && !pendingStart) captureOwner = null;
      throw error;
    });
  }

  function startDiagnostic(): Promise<string> {
    if (status().state === "unavailable") return Promise.reject(new Error("System audio capture is unavailable."));
    if (captureOwner || captureProcess || pendingStart) return Promise.reject(new Error("System audio capture is already in use."));
    const token = randomUUID();
    captureOwner = { kind: "diagnostic", token };
    lastError = undefined;
    return startNative().then(() => token).catch(error => {
      if (captureOwner?.kind === "diagnostic" && captureOwner.token === token && !captureProcess && !pendingStart) captureOwner = null;
      throw error;
    });
  }

  function stopNative(): void {
    const proc = captureProcess;
    captureProcess = null; headerParsed = false;
    if (pendingStart) clearPending(new Error("System audio capture start was cancelled."));
    captureGeneration++; stopFlushTimer(); safeKill(proc);
  }

  function stop(): void {
    if (captureOwner?.kind !== "screen-share") return;
    stopNative(); captureOwner = null; lastError = undefined;
  }

  function stopDiagnostic(token: string): boolean {
    if (captureOwner?.kind !== "diagnostic" || captureOwner.token !== token) return false;
    stopNative(); captureOwner = null; lastError = undefined; return true;
  }

  function shutdown(): Promise<void> | null {
    captureOwner = null; lastError = undefined;
    const proc = captureProcess;
    if (!proc) {
      if (pendingStart) clearPending(new Error("System audio capture start was cancelled during shutdown."));
      return null;
    }
    captureGeneration++; captureProcess = null; headerParsed = false;
    if (pendingStart) clearPending(new Error("System audio capture start was cancelled during shutdown."));
    stopFlushTimer();
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true; deps.clearTimeout(timer); proc.removeAllListeners("exit"); resolve();
      };
      const timer = deps.setTimeout(finish, deps.shutdownTimeoutMs);
      proc.on("exit", finish); safeKill(proc);
    });
  }

  return { start, stop, shutdown, status, startDiagnostic, stopDiagnostic };
}

function helperPath(): string {
  const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;
  return isDev
    ? path.join(app.getAppPath(), "native", "audio-capture.exe")
    : path.join(process.resourcesPath, "native", "audio-capture.exe");
}

const worker = createAudioCaptureWorker({
  platform: process.platform, processId: process.pid, exePath: helperPath,
  exists: existsSync, spawn: nodeSpawn as WorkerDependencies["spawn"],
  getWindow: getMainWindow, log: appendDiagnostic,
  startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS, shutdownTimeoutMs: DEFAULT_SHUTDOWN_TIMEOUT_MS,
  setTimeout, clearTimeout, setInterval, clearInterval,
});

export const startCapture = worker.start;
export const stopCapture = worker.stop;
export const shutdownCapture = worker.shutdown;
export const getCaptureStatus = worker.status;
export const startDiagnosticCapture = worker.startDiagnostic;
export const stopDiagnosticCapture = worker.stopDiagnostic;
