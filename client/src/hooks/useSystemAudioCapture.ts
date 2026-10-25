/**
 * useSystemAudioCapture — Process-exclusive system audio capture hook.
 *
 * Uses the native audio-capture.exe (WASAPI process loopback) to capture
 * system audio while excluding our own Electron process tree. This prevents
 * the screen share echo problem where remote participants hear their own voice.
 *
 * Audio pipeline:
 *   1. audio-capture.exe captures system audio (excluding Electron PID)
 *   2. Raw PCM data flows via IPC: native → main process → renderer
 *   3. This hook receives PCM data and feeds it to an AudioWorklet
 *   4. AudioWorklet → AudioContext.createMediaStreamDestination()
 *   5. The resulting MediaStreamTrack is returned for LiveKit to publish
 *
 * Usage in VoiceStateManager:
 *   const { start, stop, audioTrack } = useSystemAudioCapture();
 *   // When screen share starts with audio:
 *   await start();
 *   if (audioTrack) localParticipant.publishTrack(audioTrack, ...);
 *   // When screen share stops:
 *   stop();
 *
 * This hook is only active in Electron (isElectron() === true).
 * In browser mode, screen share audio uses getDisplayMedia's built-in audio.
 */

import { useState, useRef, useCallback } from "react";
import { isElectron } from "../utils/constants";
import { logToServer } from "../api/clientLog";

/** Return type of useSystemAudioCapture hook */
interface SystemAudioCapture {
  /** Start the native audio capture process */
  start: () => Promise<MediaStreamTrack | null>;
  /** Stop capture and clean up resources */
  stop: () => void;
  /** Whether capture is currently active */
  isCapturing: boolean;
}

export function useSystemAudioCapture(): SystemAudioCapture {
  const [isCapturing, setIsCapturing] = useState(false);

  // Refs for cleanup — AudioContext and worklet node must persist across renders
  const audioCtxRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const destRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const startGenerationRef = useRef(0);
  const cancelPendingStartRef = useRef<(() => void) | null>(null);

  const start = useCallback(async (): Promise<MediaStreamTrack | null> => {
    if (!isElectron()) return null;

    const api = window.electronAPI;
    if (!api) return null;

    cancelPendingStartRef.current?.();
    const generation = ++startGenerationRef.current;

    return new Promise<MediaStreamTrack | null>((resolve) => {
      let resolved = false;
      const startupTimeout: { id?: number } = {};
      const releaseResources = (stopNative = true) => {
        api.removeCaptureListeners();
        if (stopNative) void api.stopSystemCapture().catch(() => {});
        if (trackRef.current) { trackRef.current.stop(); trackRef.current = null; }
        if (workletNodeRef.current) { workletNodeRef.current.disconnect(); workletNodeRef.current = null; }
        if (destRef.current) { destRef.current.disconnect(); destRef.current = null; }
        if (audioCtxRef.current) { void audioCtxRef.current.close().catch(() => {}); audioCtxRef.current = null; }
        setIsCapturing(false);
      };
      const fail = (reason: string, error?: unknown) => {
        if (resolved || generation !== startGenerationRef.current) return;
        resolved = true;
        startGenerationRef.current++;
        cancelPendingStartRef.current = null;
        if (startupTimeout.id !== undefined) window.clearTimeout(startupTimeout.id);
        logToServer("warn", "system_audio_capture_failed", {
          reason,
          ...(error instanceof Error ? { errorMessage: error.message.slice(0, 256) } : {}),
        });
        releaseResources();
        resolve(null);
      };
      cancelPendingStartRef.current = () => fail("start_superseded");

      // Remove ALL previous capture listeners before registering new ones.
      // Without this, ipcRenderer.on() accumulates duplicate listeners
      // across screen share sessions. Old listeners from previous sessions
      // intercept events meant for the current session, causing:
      // - Stale "capture-audio-stopped" events resolving new promises as null
      // - Old data listeners posting to disconnected worklet nodes
      api.removeCaptureListeners();

      // Forward main process errors/debug to renderer console
      api.onCaptureAudioError((msg: string) => {
        console.error("[useSystemAudioCapture] Main process:", msg);
        // Only surface real failures — the WASAPI helper emits informational
        // stderr lines we don't care about. EXIT/SPAWN ERROR are the ones
        // that mean the helper actually died.
        if (msg.includes("EXIT") || msg.includes("SPAWN ERROR")) {
          logToServer("warn", "system_audio_capture_failed", {
            reason: "helper_process_died",
            detail: msg.slice(0, 256),
          });
        }
      });

      // Listen for audio header (format info) from native capture
      api.onCaptureAudioHeader(async (header) => {
        if (resolved || generation !== startGenerationRef.current) return;

        try {
          // Create AudioContext matching the capture format
          const ctx = new AudioContext({ sampleRate: header.sampleRate });
          audioCtxRef.current = ctx;

          // Load the PCM feeder worklet processor.
          // URL must be relative — absolute "/" resolves to filesystem root
          // with file:// protocol (production), breaking asar loading.
          const moduleUrl = new URL(
            "pcm-feeder-processor.js",
            window.location.href
          ).href;
          await ctx.audioWorklet.addModule(moduleUrl);
          if (resolved || generation !== startGenerationRef.current) {
            await ctx.close().catch(() => {});
            return;
          }

          // Create worklet node with matching channel count
          const workletNode = new AudioWorkletNode(ctx, "pcm-feeder", {
            outputChannelCount: [header.channels],
            processorOptions: { channelCount: header.channels },
          });
          workletNodeRef.current = workletNode;

          // Create MediaStream destination — this gives us a MediaStreamTrack
          const dest = ctx.createMediaStreamDestination();
          destRef.current = dest;

          // Connect: worklet → destination
          workletNode.connect(dest);

          // The audio track that LiveKit will publish
          const track = dest.stream.getAudioTracks()[0];
          trackRef.current = track;

          // Now listen for PCM data and feed to worklet
          const isFloat = header.formatTag === 3;
          const bytesPerSample = header.bitsPerSample / 8;

          // Track total bytes dropped on the renderer side (separate from
          // the main-process drop counter). We only get here when the main
          // batched buffer made it across IPC but the worklet's port
          // message queue is still backed up — usually because the
          // AudioContext has been throttled (tab hidden, system sleep).
          // Without this counter the queue would grow until V8 OOM'd.
          const MAX_PORT_BACKLOG = 16; // ~80 ms of buffered audio
          let droppedSinceLog = 0;
          let outstandingMessages = 0;
          // The worklet acks each processed chunk via port.onmessage. The
          // ack lets us track how far behind it is without coordinating
          // through a separate channel.
          workletNode.port.onmessage = (event) => {
            if (event.data === "processed") {
              outstandingMessages = Math.max(0, outstandingMessages - 1);
            }
          };

          api.onCaptureAudioData((data: Uint8Array) => {
            if (outstandingMessages > MAX_PORT_BACKLOG) {
              droppedSinceLog += data.byteLength;
              if (droppedSinceLog > 256 * 1024) {
                logToServer("warn", "system_audio_renderer_backlog", {
                  droppedBytes: droppedSinceLog,
                  outstandingMessages,
                });
                droppedSinceLog = 0;
              }
              return;
            }

            // Convert raw bytes to Float32Array for the worklet. Allocate
            // a *copy* (not a view on data.buffer) so we can transfer the
            // underlying ArrayBuffer to the worklet — IPC-supplied Uint8Array
            // backing buffers may be shared/pooled by Electron and aren't
            // safe to neuter.
            let float32Data: Float32Array;
            const sampleCount = Math.floor(data.byteLength / bytesPerSample);
            const samples = new DataView(data.buffer, data.byteOffset, data.byteLength);

            if (isFloat && bytesPerSample === 4) {
              // IPC Buffer views can have a non-zero, unaligned byteOffset.
              // DataView safely reads each little-endian sample without
              // constructing an alignment-sensitive Float32Array view.
              float32Data = new Float32Array(sampleCount);
              for (let i = 0; i < sampleCount; i++) float32Data[i] = samples.getFloat32(i * 4, true);
            } else if (bytesPerSample === 2) {
              // 16-bit little-endian PCM int → float32; DataView also makes
              // this safe for arbitrary IPC byte offsets.
              float32Data = new Float32Array(sampleCount);
              for (let i = 0; i < sampleCount; i++) {
                float32Data[i] = samples.getInt16(i * 2, true) / 32768;
              }
            } else {
              // Unsupported format — skip
              return;
            }

            // Transferable postMessage — neuters our Float32Array's buffer
            // but avoids the structured-clone copy across the worklet
            // boundary, which is the main source of GC pressure here.
            outstandingMessages++;
            workletNode.port.postMessage(float32Data, [float32Data.buffer]);
          });

          setIsCapturing(true);
          resolved = true;
          cancelPendingStartRef.current = null;
          if (startupTimeout.id !== undefined) window.clearTimeout(startupTimeout.id);
          resolve(track);
        } catch (err) {
          console.error("[useSystemAudioCapture] Setup failed:", err);
          fail("worklet_setup", err);
        }
      });

      // Handle capture stop before header arrives
      api.onCaptureAudioStopped(() => {
        console.error("[useSystemAudioCapture] Capture stopped (exe exited before header)");
        if (!resolved) {
          fail("stopped_before_header");
          return;
        }
        if (generation !== startGenerationRef.current) return;
        startGenerationRef.current++;
        cancelPendingStartRef.current = null;
        logToServer("warn", "system_audio_capture_failed", { reason: "helper_stopped_during_capture" });
        releaseResources(false);
      });

      // Tell main process to start the native capture
      api.startSystemCapture().catch((err: unknown) => {
        console.error("[useSystemAudioCapture] Start failed:", err);
        fail("start_rejected", err);
      });

      // Timeout: if header doesn't arrive in 5 seconds, give up
      startupTimeout.id = window.setTimeout(() => {
        if (!resolved) {
          console.error("[useSystemAudioCapture] Timeout waiting for header");
          fail("header_timeout_5s");
        }
      }, 5000);
    });
  }, []);

  const stop = useCallback(() => {
    if (cancelPendingStartRef.current) {
      cancelPendingStartRef.current();
      return;
    }
    startGenerationRef.current++;
    if (!isElectron()) return;

    const api = window.electronAPI;
    if (!api) return;

    // Remove IPC listeners first — prevents stale exit events from
    // the killed process from interfering with future sessions
    api.removeCaptureListeners();

    // Stop the native capture process
    api.stopSystemCapture().catch(() => {
      // Ignore errors during cleanup
    });

    // Stop the MediaStreamTrack
    if (trackRef.current) {
      trackRef.current.stop();
      trackRef.current = null;
    }

    // Disconnect and close AudioContext
    if (workletNodeRef.current) {
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }

    if (destRef.current) {
      destRef.current.disconnect();
      destRef.current = null;
    }

    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }

    setIsCapturing(false);
  }, []);

  return { start, stop, isCapturing };
}
