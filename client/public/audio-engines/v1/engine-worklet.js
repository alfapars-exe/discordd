import { createDsp, FrameQueue } from './dsp.js';

class HiChatAudioEngine extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.queue = null;
    this.disposed = false;
    this.frames = 0;
    this.port.onmessage = event => {
      const message = event.data;
      if (message?.type === 'DESTROY') this.dispose();
      if (message?.type === 'CONFIG' && this.queue) {
        try { this.queue.dsp.setSuppressionLevel?.(message.suppression); }
        catch (error) { this.fail(error); }
      }
    };
    const { engine, ...assets } = options.processorOptions;
    if (engine === 'deepfilter') {
      this.fail(new Error('DeepFilter must run in its dedicated worker bridge'));
      return;
    }
    createDsp(engine, assets, sampleRate).then(dsp => {
      // Do not retain transferred model/binary input after initialization.
      assets.wasmBinary = assets.wasmModule = assets.modelBytes = null;
      if (this.disposed) { dsp.dispose(); return; }
      this.queue = new FrameQueue(dsp);
      this.port.postMessage({ type: 'READY', engine, sampleRate, frameSize: dsp.frameSize });
    }).catch(error => this.fail(error));
  }
  fail(error) {
    if (this.disposed) return;
    this.port.postMessage({ type: 'ERROR', message: error instanceof Error ? error.message : String(error) });
    this.dispose();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    try { this.queue?.dispose(); } finally {
      this.queue = null;
      this.port.postMessage({ type: 'DESTROYED' });
      this.port.onmessage = null;
      this.port.close();
    }
  }
  process(inputs, outputs) {
    if (this.disposed) return false;
    const output = outputs[0]?.[0];
    if (!output) return true;
    // Fail closed while starting or failed; the host selects a visible fallback.
    if (!this.queue) { output.fill(0); return true; }
    try { this.queue.process(inputs[0]?.[0], output); }
    catch (error) { output.fill(0); this.fail(error); }
    this.frames += output.length;
    if (!this.disposed && this.frames >= sampleRate) {
      this.frames = 0;
      this.port.postMessage({ type: 'PROCESSING', connected: !!inputs[0]?.[0] });
    }
    return !this.disposed;
  }
}

registerProcessor('hichat-audio-engine-v1', HiChatAudioEngine);
