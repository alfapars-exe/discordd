import './utf8.js';
import { Rnnoise } from './vendor/rnnoise.js';
import { GtcrnProcessor, loadGtcrnModule } from './vendor/gtcrn.js';
import { SpeexPreprocessor, loadSpeexModule } from './vendor/speex.js';
import { createDeepFilterRuntime } from './vendor/deepfilter.js';

// The callers pass a dB attenuation limit, already mapped from the UI strength.
const suppressionDb = value => Math.max(0, Math.min(100, Number.isFinite(value) ? value : 70));

export async function createDsp(engine, assets, rate) {
  if (rate !== 48000) throw new Error(`Audio engines require 48000 Hz, received ${rate}`);
  let state = null;
  let runtime = null;
  let frameSize;
  let processFrame;
  let setSuppressionLevel;
  let release;
  try {
    if (engine === 'rnnoise') {
      runtime = await Rnnoise.loadBinary(assets.wasmBinary);
      state = runtime.createDenoiseState();
      frameSize = runtime.frameSize;
      if (frameSize !== 480) throw new Error('Unexpected RNNoise frame size');
      processFrame = frame => {
        for (let i = 0; i < frame.length; i++) frame[i] *= 32767;
        state.processFrame(frame);
        for (let i = 0; i < frame.length; i++) frame[i] /= 32767;
        return frame;
      };
      release = () => state?.destroy();
    } else if (engine === 'gtcrn') {
      runtime = await loadGtcrnModule({ wasmBinary: assets.wasmBinary, locateFile: name => name });
      state = new GtcrnProcessor(runtime, { sampleRate: rate });
      frameSize = state.frameSize;
      if (frameSize !== 768) throw new Error('Unexpected GTCRN frame size');
      processFrame = frame => state.process(frame);
      release = () => state?.destroy();
    } else if (engine === 'speex') {
      runtime = await loadSpeexModule({ wasmBinary: assets.wasmBinary, locateFile: name => name });
      // 10 ms frames, rather than the previous 128-sample (~2.7 ms) frames.
      frameSize = 480;
      state = new SpeexPreprocessor(runtime, frameSize, rate);
      state.denoise = true;
      processFrame = frame => { state.process(frame); return frame; };
      release = () => state?.destroy();
    } else if (engine === 'deepfilter') {
      // Each instance owns its entire heap. The pinned ABI exposes a destructor
      // for wasm-bindgen DFState wrappers, NOT for df_create's raw pointer.
      // Calling it on that pointer traps. Drop the isolated runtime on dispose.
      runtime = createDeepFilterRuntime();
      runtime.initSync(assets.wasmBinary ?? assets.wasmModule);
      state = runtime.df_create(new Uint8Array(assets.modelBytes), suppressionDb(assets.suppression));
      if (!state) throw new Error('DeepFilter failed to allocate its model');
      frameSize = runtime.df_get_frame_length(state);
      if (frameSize !== 480) throw new Error('Unexpected DeepFilter frame size');
      processFrame = frame => runtime.df_process_frame(state, frame);
      setSuppressionLevel = value => runtime.df_set_atten_lim(state, suppressionDb(value));
      release = () => {};
    } else {
      throw new Error(`Unknown audio engine: ${engine}`);
    }
    const process = frame => {
      if (!runtime) throw new Error('Audio engine was disposed');
      const result = processFrame(frame);
      if (result.length !== frameSize || !result.every(Number.isFinite)) throw new Error(`${engine} returned invalid audio`);
      return result;
    };
    // Actual inference, not merely node construction. Startup silence is valid.
    process(new Float32Array(frameSize));
    return {
      frameSize,
      process,
      setSuppressionLevel,
      dispose() {
        try { release?.(); } finally {
          state = null;
          runtime = null;
          release = null;
          processFrame = null;
          setSuppressionLevel = null;
        }
      },
    };
  } catch (error) {
    try { release?.(); } finally { state = null; runtime = null; }
    throw error;
  }
}

// One fixed frame of buffering keeps frame/quantum boundaries continuous even
// when 480 is not divisible by the render quantum. No allocations in the queue.
export class FrameQueue {
  constructor(dsp) {
    this.dsp = dsp;
    this.input = new Float32Array(dsp.frameSize);
    this.output = new Float32Array(dsp.frameSize * 3);
    this.fill = 0;
    this.read = 0;
    this.write = dsp.frameSize;
    this.available = dsp.frameSize;
  }
  process(input, output) {
    for (let i = 0; i < output.length; i++) {
      this.input[this.fill++] = input?.[i] ?? 0;
      if (this.fill === this.input.length) {
        const result = this.dsp.process(this.input);
        for (let j = 0; j < result.length; j++) {
          this.output[this.write] = result[j];
          this.write = (this.write + 1) % this.output.length;
        }
        this.available += result.length;
        this.fill = 0;
      }
      output[i] = this.available ? this.output[this.read] : 0;
      if (this.available) { this.read = (this.read + 1) % this.output.length; this.available--; }
    }
  }
  dispose() {
    this.dsp?.dispose();
    this.dsp = null;
    this.input = null;
    this.output = null;
  }
}
