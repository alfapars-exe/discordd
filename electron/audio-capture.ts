/**
 * electron/audio-capture.ts — Process-exclusive system audio capture.
 *
 * Single responsibility: spawn audio-capture.exe (WASAPI loopback that
 * EXCLUDES our process tree), parse its 12-byte PCM header from stdout,
 * and forward header + raw PCM data to the renderer via IPC. Solves the
 * screen-share echo problem (remote voice played by us doesn't get
 * re-captured).
 *
 * Lifecycle:
 *   start() spawns the .exe → header parsed → data streamed → stop() kills
 *
 * Generation IDs: each start() bumps a generation. Stale exit/error events
 * from a previously killed process (still draining its handlers) check the
 * generation and skip cleanup so they don't interfere with a newer session.
 */

import { app } from "electron";
import { ChildProcess, spawn } from "child_process";
import path from "path";
import { getMainWindow } from "./window";

let captureProcess: ChildProcess | null = null;
let captureGeneration = 0;
let headerParsed = false;
let headerBuffer = Buffer.alloc(0);

// PCM data IPC batching. The native helper streams ~384 KB/sec at 48 kHz
// stereo float32, which used to fire `webContents.send("capture-audio-data", chunk)`
// at the raw stdout chunk rate (often >500 calls/sec). Each call goes
// through IPC serialization and lands on the renderer's microtask queue.
// On any frame where the renderer can't drain that queue (GC, layout
// thrash, suspended AudioContext) the queue grew unboundedly and the
// renderer OOM'd ~1 minute into screen-share-with-audio sessions.
//
// We buffer chunks in the main process and flush every FLUSH_INTERVAL_MS
// as one IPC message. That drops the call rate to ~50/sec and lets V8
// reclaim the per-chunk Buffer immediately. If the buffer exceeds
// MAX_BUFFER_BYTES (renderer is hopelessly behind) we drop everything
// and log — newer audio is always more useful than stale audio.
const FLUSH_INTERVAL_MS = 20;
const MAX_BUFFER_BYTES = 100 * 1024; // ~250 ms of float32 stereo @ 48 kHz
let pcmBuffer: Buffer[] = [];
let pcmBufferBytes = 0;
let pcmDroppedBytes = 0;
let flushTimer: NodeJS.Timeout | null = null;

function flushPcmBuffer(): void {
  if (pcmBuffer.length === 0) return;
  const win = getMainWindow();
  if (!win || win.isDestroyed()) {
    pcmBuffer = [];
    pcmBufferBytes = 0;
    return;
  }
  const merged = pcmBuffer.length === 1 ? pcmBuffer[0] : Buffer.concat(pcmBuffer, pcmBufferBytes);
  pcmBuffer = [];
  pcmBufferBytes = 0;
  win.webContents.send("capture-audio-data", merged);
}

function startFlushTimer(): void {
  if (flushTimer) return;
  flushTimer = setInterval(flushPcmBuffer, FLUSH_INTERVAL_MS);
}

function stopFlushTimer(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  pcmBuffer = [];
  pcmBufferBytes = 0;
  pcmDroppedBytes = 0;
}

function enqueuePcm(chunk: Buffer): void {
  // If the renderer has fallen behind to where we've buffered a quarter
  // second of audio, drop the backlog rather than letting it grow into
  // OOM territory. Log once per ~1 MB dropped so we can see this in
  // production without flooding stderr.
  if (pcmBufferBytes + chunk.length > MAX_BUFFER_BYTES) {
    pcmDroppedBytes += pcmBufferBytes + chunk.length;
    pcmBuffer = [];
    pcmBufferBytes = 0;
    if (pcmDroppedBytes >= 1024 * 1024) {
      console.warn(`[audio-capture] renderer behind — dropped ${pcmDroppedBytes} bytes of PCM data`);
      pcmDroppedBytes = 0;
    }
    return;
  }
  pcmBuffer.push(chunk);
  pcmBufferBytes += chunk.length;
}

function exePath(): string {
  // Dev: native/audio-capture.exe (project root)
  // Prod: resources/native/audio-capture.exe (extraResources)
  const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;
  return isDev
    ? path.join(app.getAppPath(), "native", "audio-capture.exe")
    : path.join(process.resourcesPath, "native", "audio-capture.exe");
}

/**
 * Start system audio capture, excluding our own process tree.
 * Windows-only — silently no-ops on macOS/Linux.
 */
export function startCapture(): void {
  if (process.platform !== "win32") {
    console.log("[audio-capture] not available on this platform");
    return;
  }

  // If a previous capture is still running, kill it first (handles rapid
  // stop→start cycles where the old process hasn't exited yet).
  if (captureProcess) {
    console.log("[audio-capture] killing previous process before restart");
    captureProcess.kill();
    captureProcess = null;
  }

  // Bump generation — old handlers will see the change and skip cleanup.
  const thisGen = ++captureGeneration;
  headerParsed = false;
  headerBuffer = Buffer.alloc(0);
  stopFlushTimer();

  const exe = exePath();
  console.log(`[audio-capture] starting gen=${thisGen}: ${exe} (exclude PID ${process.pid})`);

  captureProcess = spawn(exe, [process.pid.toString()], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  captureProcess.stdout?.on("data", (chunk: Buffer) => {
    if (thisGen !== captureGeneration) return;
    const win = getMainWindow();
    if (!headerParsed) {
      // Accumulate until full 12-byte header
      headerBuffer = Buffer.concat([headerBuffer, chunk]);
      if (headerBuffer.length >= 12) {
        const sampleRate = headerBuffer.readUInt32LE(0);
        const channels = headerBuffer.readUInt16LE(4);
        const bitsPerSample = headerBuffer.readUInt16LE(6);
        const formatTag = headerBuffer.readUInt32LE(8);
        console.log(
          `[audio-capture] format gen=${thisGen}: ${sampleRate}Hz ${channels}ch ${bitsPerSample}bit tag=${formatTag}`,
        );
        win?.webContents.send("capture-audio-header", { sampleRate, channels, bitsPerSample, formatTag });
        headerParsed = true;
        startFlushTimer();
        const remaining = headerBuffer.subarray(12);
        if (remaining.length > 0) enqueuePcm(remaining);
        headerBuffer = Buffer.alloc(0);
      }
    } else {
      enqueuePcm(chunk);
    }
  });

  captureProcess.stderr?.on("data", (data: Buffer) => {
    if (thisGen !== captureGeneration) return;
    const msg = data.toString().trim();
    console.log(`[audio-capture] stderr: ${msg}`);
    getMainWindow()?.webContents.send("capture-audio-error", msg);
  });

  captureProcess.on("exit", (code) => {
    console.log(`[audio-capture] gen=${thisGen} exited code=${code}`);
    if (thisGen !== captureGeneration) {
      console.log(`[audio-capture] ignoring stale exit (current=${captureGeneration})`);
      return;
    }
    // Flush any tail audio before announcing exit so the renderer's
    // worklet drains cleanly instead of clipping mid-word.
    flushPcmBuffer();
    stopFlushTimer();
    const win = getMainWindow();
    win?.webContents.send("capture-audio-error", `EXIT code=${code}`);
    captureProcess = null;
    headerParsed = false;
    win?.webContents.send("capture-audio-stopped");
  });

  captureProcess.on("error", (err) => {
    if (thisGen !== captureGeneration) return;
    console.error("[audio-capture] spawn error:", err);
    stopFlushTimer();
    const win = getMainWindow();
    win?.webContents.send("capture-audio-error", `SPAWN ERROR: ${err.message}`);
    captureProcess = null;
    win?.webContents.send("capture-audio-stopped");
  });
}

/** Stop the running capture and prevent its exit handler from firing. */
export function stopCapture(): void {
  if (process.platform !== "win32") return;
  if (!captureProcess) return;
  console.log(`[audio-capture] stopping gen=${captureGeneration}`);
  captureProcess.kill();
  captureProcess = null;
  headerParsed = false;
  stopFlushTimer();
  // Bump generation so stale exit handler skips renderer notifications
  captureGeneration++;
}

/**
 * Block app quit until the capture process has actually exited (or 2s timeout).
 * Prevents Windows from force-killing it mid-cleanup which causes a visible
 * STATUS_BREAKPOINT crash dialog.
 *
 * Returns null if no process is running (caller can quit immediately).
 * Otherwise returns a promise that resolves when the process is gone.
 */
export function shutdownCapture(): Promise<void> | null {
  if (!captureProcess) return null;
  const proc = captureProcess;
  captureGeneration++;
  captureProcess = null;
  stopFlushTimer();
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      proc.removeAllListeners("exit");
      resolve();
    };
    proc.on("exit", finish);
    setTimeout(finish, 2000);
    proc.kill();
  });
}
