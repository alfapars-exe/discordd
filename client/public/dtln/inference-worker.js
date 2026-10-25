/* HiChat DTLN: one classic Worker, TFLite interpreter pair and state per session. */
"use strict";
let session = null;
let processState = null;
let audioPort = null;
let nextSequence = 0;
let failed = false;

function reportError(error) {
  if (failed) return;
  failed = true;
  const message = error instanceof Error ? error.message : String(error);
  self.postMessage({ type: "error", session, message });
  if (audioPort) audioPort.postMessage({ type: "error", session, message });
}

self.onmessage = async ({ data }) => {
  if (!data || data.type !== "init" || session !== null) return;
  session = data.session;
  try {
    const base = data.assetBase;
    // These are local, version-matched assets. setWasmPath takes a directory.
    importScripts(`${base}tf.min.js`, `${base}tf-tflite.min.js`, `${base}fft.js`, `${base}dtln-core.js`);
    await self.tf.setBackend("cpu");
    await self.tf.ready();
    // The TFLite loader only recognizes http(s) absolute prefixes. A relative
    // directory is resolved against this worker URL and also works under the
    // packaged app://, capacitor:// and file:// schemes.
    self.tflite.setWasmPath("./");
    const models = await Promise.all([
      self.tflite.loadTFLiteModel(`${base}model_quant_f16_1.tflite`, { numThreads: 1 }),
      self.tflite.loadTFLiteModel(`${base}model_quant_f16_2.tflite`, { numThreads: 1 }),
    ]);
    processState = self.createDtlnProcess(self.tf, self.DtlnFFT, models[0], models[1]);
    let energy = 0;
    for (let hop = 0; hop < 12; hop++) {
      const frame = new Float32Array(128);
      for (let i = 0; i < frame.length; i++) {
        frame[i] = 0.1 * Math.sin((2 * Math.PI * 220 * (hop * 128 + i)) / 16000);
      }
      const result = processState.process(frame);
      for (const sample of result) energy += sample * sample;
    }
    if (!Number.isFinite(energy) || energy === 0) throw new Error("DTLN model warmup produced no valid audio");
    processState.dispose();
    processState = self.createDtlnProcess(self.tf, self.DtlnFFT, models[0], models[1]);
    audioPort = data.port;
    audioPort.onmessage = ({ data: frame }) => {
      if (failed || !frame || frame.session !== session || frame.type !== "frame") return;
      try {
        if (frame.sequence !== nextSequence++) throw new Error("DTLN input sequence discontinuity");
        const output = processState.process(new Float32Array(frame.buffer));
        audioPort.postMessage({ type: "frame", session, sequence: frame.sequence, buffer: output.buffer }, [output.buffer]);
      } catch (error) {
        reportError(error);
      }
    };
    audioPort.start();
    self.postMessage({ type: "ready", session, sampleRate: 16000, hop: 128 });
  } catch (error) {
    reportError(error);
  }
};
self.onunhandledrejection = (event) => {
  event.preventDefault();
  reportError(event.reason);
};
