// Only bounded PCM transport runs on the render thread. Heavy model startup
// and inference run in a dedicated, terminable worker.
class DeepFilterBridge extends AudioWorkletProcessor {
  constructor() {
    super();
    this.disposed = false;
    this.workerPort = null;
    this.input = new Float32Array(480);
    this.fill = 0;
    this.output = new Float32Array(480 * 20);
    this.read = 0; this.write = 960; this.available = 960;
    this.sent = 0; this.received = 0; this.underrun = 0; this.frames = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'DESTROY') this.dispose();
      else if (data.type === 'CONNECT' && !this.disposed) {
        this.workerPort = data.port;
        this.workerPort.onmessage = ({ data: result }) => {
          if (this.disposed) return;
          if (result.id !== this.received++ || !(result.samples instanceof Float32Array)
            || result.samples.length !== 480 || !result.samples.every(Number.isFinite)) {
            this.fail('Invalid DeepFilter worker output'); return;
          }
          if (this.available + result.samples.length > this.output.length) { this.fail('DeepFilter output queue overflow'); return; }
          for (const sample of result.samples) { this.output[this.write] = sample; this.write = (this.write + 1) % this.output.length; }
          this.available += result.samples.length;
        };
        this.port.postMessage({ type: 'READY', engine: 'deepfilter', sampleRate, frameSize: 480 });
      }
    };
  }
  fail(message) { this.port.postMessage({ type: 'ERROR', message }); this.dispose(); }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.workerPort?.close(); this.workerPort = null;
    this.input = this.output = null;
    this.port.postMessage({ type: 'DESTROYED' });
    this.port.onmessage = null; this.port.close();
  }
  process(inputs, outputs) {
    if (this.disposed) return false;
    const output = outputs[0]?.[0];
    if (!output) return true;
    if (!this.workerPort) { output.fill(0); return true; }
    const input = inputs[0]?.[0];
    for (let i = 0; i < output.length; i++) {
      this.input[this.fill++] = input?.[i] ?? 0;
      if (this.fill === 480) {
        if (this.sent - this.received >= 10) { output.fill(0); this.fail('DeepFilter inference stopped responding'); return false; }
        this.workerPort.postMessage({ id: this.sent++, samples: this.input }, [this.input.buffer]);
        this.input = new Float32Array(480); this.fill = 0;
      }
      output[i] = this.available ? this.output[this.read] : 0;
      if (this.available) { this.read = (this.read + 1) % this.output.length; this.available--; this.underrun = 0; }
      else if (++this.underrun > 48000) { output.fill(0); this.fail('DeepFilter audio output stopped'); return false; }
    }
    this.frames += output.length;
    if (this.frames >= sampleRate) { this.frames = 0; this.port.postMessage({ type: 'PROCESSING', connected: !!input }); }
    return true;
  }
}
registerProcessor('hichat-deepfilter-bridge-v1', DeepFilterBridge);
