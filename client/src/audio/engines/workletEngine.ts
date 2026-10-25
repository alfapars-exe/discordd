import manifest from "../../../public/audio-engines/v1/manifest.json";
import { resolvePublicAssetBase } from "../publicAssetBase";
import { strengthToAttenLimDb } from "../deepfilterSuppression";
import { isNativeApp } from "../../utils/constants";

export type WorkletEngine = "rnnoise" | "gtcrn" | "speex" | "deepfilter";
export interface EngineHandle {
  input: AudioNode;
  output: AudioNode;
  setSuppressionLevel?: (strength: number) => void;
  dispose: () => Promise<void>;
}

const binaryCache = new Map<string, Promise<ArrayBuffer>>();
const moduleCache = new WeakMap<AudioContext, Promise<void>>();
const deepfilterModuleCache = new WeakMap<AudioContext, Promise<void>>();
const STARTUP_TIMEOUT_MS = 20_000;
const DISPOSE_TIMEOUT_MS = 500;
type AssetPath = keyof typeof manifest.files;

function abortError(): DOMException { return new DOMException("Audio engine startup cancelled", "AbortError"); }

function waitFor<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? abortError());
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? abortError());
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function assetBase(): string {
  const base = resolvePublicAssetBase("audio-engines/v1", isNativeApp(), import.meta.env.BASE_URL);
  return new URL(`${base}/`, document.baseURI).href;
}

function loadAsset(base: string, path: AssetPath): Promise<ArrayBuffer> {
  const url = new URL(path, base).href;
  let pending = binaryCache.get(url);
  if (!pending) {
    pending = (async () => {
      // Shared successful assets survive track changes. A caller's cancellation
      // must not cancel another caller's download; failed requests are evicted.
      const response = await fetch(url);
      if (!response.ok && response.status !== 0) throw new Error(`Audio asset download failed (${response.status})`);
      const bytes = await response.arrayBuffer();
      const expected = manifest.files[path];
      if (bytes.byteLength !== expected.bytes) throw new Error(`Audio asset size mismatch: ${path}`);
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
      if (hash !== expected.sha256) throw new Error(`Audio asset checksum mismatch: ${path}`);
      return bytes;
    })().catch(error => { binaryCache.delete(url); throw error; });
    binaryCache.set(url, pending);
  }
  return pending;
}

function register(context: AudioContext, base: string, deepfilter: boolean): Promise<void> {
  const cache = deepfilter ? deepfilterModuleCache : moduleCache;
  let pending = cache.get(context);
  if (!pending) {
    pending = context.audioWorklet.addModule(new URL(deepfilter ? "deepfilter-bridge-worklet.js" : "engine-worklet.js", base).href)
      .catch(error => { cache.delete(context); throw error; });
    cache.set(context, pending);
  }
  return pending;
}

function supportsSimd(): boolean {
  return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
}

/** A mono 48 kHz stage. Resolves only after the worklet has run real inference. */
export async function createWorkletEngine(
  context: AudioContext,
  engine: WorkletEngine,
  options: { suppression: number; signal?: AbortSignal; onError?: (error: Error) => void },
): Promise<EngineHandle> {
  if (context.sampleRate !== 48000) throw new Error(`${engine} requires a 48 kHz processing context`);
  if (context.state === "closed" || !context.audioWorklet) throw new Error("AudioWorklet is unavailable");
  const controller = new AbortController();
  const cancel = () => controller.abort(options.signal?.reason ?? abortError());
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timeout = setTimeout(() => controller.abort(new Error(`${engine} startup timed out`)), STARTUP_TIMEOUT_MS);
  const signal = controller.signal;
  const base = assetBase();
  let node: AudioWorkletNode | undefined;
  let worker: Worker | undefined;
  let channel: MessageChannel | undefined;
  let workerStartupError: Error | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let lastProcessingTime: number | undefined;
  let disposal: Promise<void> | undefined;
  let destroyed: (() => void) | undefined;
  let rejectReady: ((reason: Error) => void) | undefined;
  let ready = false;

  const dispose = (): Promise<void> => {
    if (disposal) return disposal;
    disposal = (async () => {
      clearInterval(heartbeatTimer);
      worker?.terminate(); worker = undefined;
      channel?.port1.close(); channel?.port2.close(); channel = undefined;
      if (!node) return;
      const target = node;
      try {
        if (context.state !== "closed") {
          await new Promise<void>(resolve => {
            const timer = setTimeout(resolve, DISPOSE_TIMEOUT_MS);
            destroyed = () => { clearTimeout(timer); resolve(); };
            target.port.postMessage({ type: "DESTROY" });
          });
        }
      } finally {
        target.onprocessorerror = null;
        target.port.onmessage = null;
        target.port.close();
        target.disconnect();
        node = undefined;
        destroyed = undefined;
        rejectReady = undefined;
      }
    })();
    return disposal;
  };

  try {
    const assets: Record<string, unknown> = { engine, suppression: strengthToAttenLimDb(options.suppression) };
    if (engine === "deepfilter") {
      const [wasmBinary, modelBytes] = await waitFor(Promise.all([
        loadAsset(base, "../../deepfilter/v2/pkg/df_bg.wasm"),
        // .bin preserves the gzip archive bytes. Some static servers serve
        // .tar.gz as Content-Encoding:gzip, causing fetch to inflate the model.
        loadAsset(base, "deepfilter-model.bin"),
      ]), signal);
      assets.wasmBinary = wasmBinary;
      assets.modelBytes = modelBytes;
    } else {
      const path: AssetPath = engine === "rnnoise" ? (supportsSimd() ? "rnnoise_simd.wasm" : "rnnoise.wasm") : `${engine}.wasm`;
      assets.wasmBinary = await waitFor(loadAsset(base, path), signal);
    }
    if (engine === "deepfilter") {
      // Keep model construction and inference off the realtime audio thread.
      // Worker termination also releases the private heap despite the old ABI's
      // lack of a destructor for df_create's raw state pointer.
      channel = new MessageChannel();
      worker = new Worker(new URL("deepfilter-worker.js", base), { type: "module", name: "hichat-deepfilter" });
      const initialized = new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => { workerStartupError = error; reject(error); };
        worker!.onerror = event => failed(new Error(event.message || "DeepFilter worker failed"));
        worker!.onmessageerror = () => failed(new Error("DeepFilter worker message failed"));
        worker!.onmessage = ({ data }) => {
          if (data?.type === "ERROR") failed(new Error(String(data.message)));
          else if (data?.type === "READY") {
            if (data.engine !== engine || data.sampleRate !== 48000 || data.frameSize !== 480) reject(new Error("DeepFilter worker readiness mismatch"));
            else resolve();
          }
        };
      });
      worker.postMessage({ type: "INIT", assets, port: channel.port2 }, [channel.port2]);
      await waitFor(initialized, signal);
    }
    await waitFor(register(context, base, engine === "deepfilter"), signal);
    if (signal.aborted) throw signal.reason;
    if (workerStartupError) throw workerStartupError;
    node = new AudioWorkletNode(context, engine === "deepfilter" ? "hichat-deepfilter-bridge-v1" : "hichat-audio-engine-v1", {
      numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1,
      channelCountMode: "explicit", outputChannelCount: [1], processorOptions: engine === "deepfilter" ? {} : assets,
    });
    const failed = (error: Error) => {
      if (disposal) return;
      if (!ready) rejectReady?.(error);
      else { try { options.onError?.(error); } finally { void dispose(); } }
    };
    const initialization = new Promise<void>((resolve, reject) => {
      rejectReady = reject;
      node!.onprocessorerror = () => failed(new Error(`${engine} worklet failed`));
      node!.port.onmessage = event => {
        const message = event.data;
        if (message?.type === "READY") {
          if (message.engine !== engine || message.sampleRate !== 48000) { failed(new Error("Audio engine readiness mismatch")); return; }
          ready = true;
          rejectReady = undefined;
          resolve();
        } else if (message?.type === "PROCESSING") lastProcessingTime = message.connected ? context.currentTime : undefined;
        else if (message?.type === "ERROR") failed(new Error(String(message.message ?? `${engine} failed`)));
        else if (message?.type === "DESTROYED") destroyed?.();
      };
    });
    if (worker && channel) {
      worker.onerror = event => failed(new Error(event.message || "DeepFilter worker failed"));
      worker.onmessageerror = () => failed(new Error("DeepFilter worker message failed"));
      worker.onmessage = ({ data }) => { if (data?.type === "ERROR") failed(new Error(String(data.message))); };
      node.port.postMessage({ type: "CONNECT", port: channel.port1 }, [channel.port1]);
    }
    await waitFor(initialization, signal);
    if (signal.aborted) throw signal.reason;
    const handle: EngineHandle = { input: node, output: node, dispose };
    // Silence still produces heartbeats. Arm only after a connected graph has
    // rendered, and use audio time so browser/context suspension is harmless.
    let lastWatchdogTime = performance.now();
    heartbeatTimer = setInterval(() => {
      const now = performance.now();
      const hostPaused = now - lastWatchdogTime > 3000;
      lastWatchdogTime = now;
      // A background-tab timer or blocked main thread can delay both messages
      // and this timer; allow queued heartbeats to arrive before judging DSP.
      if (hostPaused) {
        if (lastProcessingTime !== undefined) lastProcessingTime = context.currentTime;
        return;
      }
      if (context.state === "running" && lastProcessingTime !== undefined && context.currentTime - lastProcessingTime > 6) {
        failed(new Error(`${engine} audio processing stopped`));
      }
    }, 1000);
    if (engine === "deepfilter") handle.setSuppressionLevel = strength => {
      worker?.postMessage({ type: "CONFIG", suppression: strengthToAttenLimDb(strength) });
    };
    return handle;
  } catch (error) {
    await dispose();
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", cancel);
  }
}
