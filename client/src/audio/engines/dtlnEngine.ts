import type { EngineHandle } from "./workletEngine";
import workletUrl from "./dtlnWorklet.js?url";
import { resolvePublicAssetBase } from "../publicAssetBase";
import { isNativeApp } from "../../utils/constants";
import { awaitAudioStep, closeAudioContext } from "../audioOperation";

/** DTLN inference is 16 kHz; the caller's 48 kHz graph owns gain/gating. */
export async function createDtlnEngine(
  context: AudioContext,
  options: { signal?: AbortSignal; onError?: (error: Error) => void } = {},
): Promise<EngineHandle> {
  const { signal, onError } = options;
  signal?.throwIfAborted();
  const base = new URL(
    `${resolvePublicAssetBase("dtln", isNativeApp(), import.meta.env.BASE_URL)}/`,
    document.baseURI,
  ).href;
  const session = crypto.randomUUID();
  const modelContext = new AudioContext({ sampleRate: 16000, latencyHint: "interactive" });
  let input: GainNode | undefined;
  let inputBridge: MediaStreamAudioDestinationNode | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let destination: MediaStreamAudioDestinationNode | undefined;
  let output: MediaStreamAudioSourceNode | undefined;
  let node: AudioWorkletNode | undefined;
  let worker: Worker | undefined;
  let channel: MessageChannel | undefined;
  let disposed = false;
  let ready = false;
  let reportedError = false;
  let rejectReady: ((error: Error) => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    signal?.removeEventListener("abort", abort);
    clearTimeout(timeout);
    node?.port.postMessage({ type: "dispose" });
    worker?.terminate();
    channel?.port1.close();
    channel?.port2.close();
    for (const audioNode of [input, inputBridge, source, node, destination, output]) {
      try { audioNode?.disconnect(); } catch { /* already detached */ }
    }
    for (const stream of [inputBridge?.stream, destination?.stream]) {
      stream?.getTracks().forEach((track) => track.stop());
    }
    await closeAudioContext(modelContext);
  };
  const abort = () => {
    const error = new DOMException("DTLN initialization cancelled", "AbortError");
    rejectReady?.(error);
    void dispose();
  };
  const fail = (error: Error) => {
    if (disposed || reportedError) return;
    reportedError = true;
    if (!ready) rejectReady?.(error);
    void dispose();
    if (ready) onError?.(error);
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (modelContext.sampleRate !== 16000) throw new Error("This browser cannot create the 16 kHz DTLN context");
    await awaitAudioStep(modelContext.audioWorklet.addModule(workletUrl), "DTLN worklet module", signal);
    signal?.throwIfAborted();
    input = context.createGain();
    input.channelCount = 1;
    input.channelCountMode = "explicit";
    inputBridge = context.createMediaStreamDestination();
    inputBridge.channelCount = 1;
    source = modelContext.createMediaStreamSource(inputBridge.stream);
    destination = modelContext.createMediaStreamDestination();
    destination.channelCount = 1;
    output = context.createMediaStreamSource(destination.stream);
    node = new AudioWorkletNode(modelContext, "hichat-dtln-bridge", {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      channelCount: 1, channelCountMode: "explicit", processorOptions: { session },
    });
    channel = new MessageChannel();
    worker = new Worker(`${base}inference-worker.js`, { name: `hichat-dtln-${session}` });
    node.port.onmessage = ({ data }) => {
      if (data?.session === session && data.type === "error") fail(new Error(data.message));
    };
    node.onprocessorerror = () => fail(new Error("DTLN AudioWorklet crashed"));
    const initialized = new Promise<void>((resolve, reject) => {
      rejectReady = reject;
      timeout = setTimeout(() => reject(new Error("DTLN model loading timed out")), 45000);
      worker!.onerror = (event) => fail(new Error(event.message || "DTLN Worker crashed"));
      worker!.onmessageerror = () => fail(new Error("DTLN Worker message could not be decoded"));
      worker!.onmessage = ({ data }) => {
        if (data?.session !== session) return;
        if (data.type === "error") fail(new Error(data.message));
        if (data.type === "ready" && data.sampleRate === 16000 && data.hop === 128) {
          clearTimeout(timeout);
          resolve();
        }
      };
    });
    worker.postMessage({ type: "init", assetBase: base, session, port: channel.port2 }, [channel.port2]);
    await initialized;
    signal?.throwIfAborted();
    if (disposed) throw new Error("DTLN engine was disposed during initialization");
    node.port.postMessage({ type: "connect", session, port: channel.port1 }, [channel.port1]);
    input.connect(inputBridge);
    source.connect(node);
    node.connect(destination);
    await awaitAudioStep(modelContext.resume(), "DTLN audio context", signal);
    signal?.throwIfAborted();
    if (disposed) throw new Error("DTLN engine failed while resuming audio");
    ready = true;
    signal?.removeEventListener("abort", abort);
    return { input, output, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
