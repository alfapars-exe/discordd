// Reusable browser QA. Call with a running context created by a user gesture.
// Uses synthetic audio only; never requests microphone permission.
import { createWorkletEngine } from './workletEngine.ts';
import { createMicrophonePipeline } from '../microphonePipeline.ts';

export async function probeGateBehavior() {
  const context = new AudioContext({ sampleRate: 48000 }); await context.resume();
  const oscillator = context.createOscillator(); oscillator.frequency.value = 1500;
  const quiet = context.createGain(); quiet.gain.value = 0.0001;
  const destination = context.createMediaStreamDestination();
  oscillator.connect(quiet); quiet.connect(destination); oscillator.start();
  const track = destination.stream.getAudioTracks()[0];
  // Synthetic sources cannot implement capture-device DSP constraints.
  track.applyConstraints = async () => {};
  let pipeline;
  const settings = { noiseReduction: false, noiseReductionEngine: 'rnnoise', noiseSuppressionLevel: 'medium',
    micSensitivity: 50, inputVolume: 100, deepfilterSuppression: 70, micProfile: 'konusma', inputDevice: '' };
  const results = [];
  try {
    pipeline = await createMicrophonePipeline(track, settings);
    const source = context.createMediaStreamSource(new MediaStream([pipeline.processedTrack]));
    const meter = context.createAnalyser(); meter.fftSize = 2048;
    const silent = context.createGain(); silent.gain.value = 0;
    source.connect(meter); meter.connect(silent); silent.connect(context.destination);
    for (const [micSensitivity, inputVolume] of [[50,100],[100,100],[100,200],[50,200]]) {
      await pipeline.update({ ...settings, micSensitivity, inputVolume });
      await new Promise(resolve => setTimeout(resolve, 600));
      const buffer = new Float32Array(meter.fftSize); meter.getFloatTimeDomainData(buffer);
      results.push({ micSensitivity, inputVolume, power: buffer.reduce((sum,v)=>sum+v*v,0)/buffer.length, status: pipeline.getStatus() });
    }
    source.disconnect(); meter.disconnect(); silent.disconnect();
    const ratio = results[2].power / results[1].power;
    const inputDbDifference = Math.abs(results[1].status.inputDb - results[2].status.inputDb);
    return { captureConstraintsSimulated: true, results, gainPowerRatio: ratio, inputDbDifference,
      passed: results[0].power < 1e-12 && results[1].power > 1e-10 && ratio > 3.2 && ratio < 4.8 &&
        inputDbDifference < 0.2 && results[3].power < 1e-12 && results.every(result=>result.status.activeEngine==='none'&&result.status.gateAvailable) };
  } finally {
    await pipeline?.dispose(); oscillator.stop(); oscillator.disconnect(); quiet.disconnect(); destination.disconnect(); track.stop(); await context.close();
  }
}

export async function probeWorkletEngine(context, engine, { cycles = 1, durationMs = 750 } = {}) {
  const results = [];
  for (let cycle = 0; cycle < cycles; cycle++) {
    const errors = [];
    const started = performance.now();
    let handle;
    const source = context.createOscillator(); source.type = 'sawtooth'; source.frequency.value = 180;
    const input = context.createGain(); input.gain.value = 0.15;
    const meter = context.createAnalyser(); meter.fftSize = 2048;
    const silent = context.createGain(); silent.gain.value = 0;
    try {
      handle = await createWorkletEngine(context, engine, { suppression: 70, onError: error => errors.push(error.message) });
      const loadMs = performance.now() - started;
      source.connect(input); input.connect(handle.input); handle.output.connect(meter); meter.connect(silent); silent.connect(context.destination);
      source.start();
      let power = 0, frames = 0, nonzero = 0, finite = true;
      const buffer = new Float32Array(meter.fftSize);
      const end = performance.now() + durationMs;
      while (performance.now() < end) {
        await new Promise(resolve => setTimeout(resolve, 50));
        meter.getFloatTimeDomainData(buffer);
        finite &&= buffer.every(Number.isFinite);
        const sum = buffer.reduce((value, sample) => value + sample * sample, 0);
        if (sum > 1e-10) nonzero++;
        power += sum; frames++;
      }
      results.push({ cycle, loadMs, frames, nonzero, finite, rms: Math.sqrt(power / (frames * buffer.length)), errors });
    } finally {
      source.stop(); source.disconnect(); input.disconnect(); meter.disconnect(); silent.disconnect();
      await handle?.dispose();
    }
  }
  return { engine, passed: results.every(result => result.finite && result.nonzero > 0 && !result.errors.length), results };
}

export async function probeDeepFilterWorkers(cycles = 20) {
  const base = '/audio-engines/v1/';
  const [wasmBinary, modelBytes] = await Promise.all([
    fetch('/deepfilter/v2/pkg/df_bg.wasm').then(response => response.arrayBuffer()),
    fetch(`${base}deepfilter-model.bin`).then(response => response.arrayBuffer()),
  ]);
  const results = [];
  for (let cycle = 0; cycle < cycles; cycle++) {
    const worker = new Worker(`${base}deepfilter-worker.js`, { type: 'module', name: `dfn-lifecycle-probe-${cycle}` });
    const channel = new MessageChannel();
    let timer;
    try {
      const started = performance.now();
      await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('DFN worker startup timed out')), 20000);
        worker.onerror = event => reject(new Error(event.message));
        worker.onmessage = ({ data }) => {
          if (data.type === 'ERROR') reject(new Error(data.message));
          else if (data.type === 'READY') { clearTimeout(timer); resolve(); }
        };
        worker.postMessage({ type: 'INIT', assets: { wasmBinary, modelBytes, suppression: 70 }, port: channel.port2 }, [channel.port2]);
      });
      let power = 0;
      for (let id = 0; id < 20; id++) {
        const samples = Float32Array.from({ length: 480 }, (_, i) => .1 * Math.sin(2 * Math.PI * (id * 480 + i) * 180 / 48000));
        const result = await new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('DFN worker frame timed out')), 2000);
          channel.port1.onmessage = ({ data }) => { clearTimeout(timer); resolve(data); };
          channel.port1.postMessage({ id, samples }, [samples.buffer]);
        });
        if (result.id !== id || result.samples.length !== 480 || !result.samples.every(Number.isFinite)) throw new Error('Invalid DFN frame');
        power += result.samples.reduce((value, sample) => value + sample * sample, 0);
      }
      results.push({ cycle, elapsedMs: performance.now() - started, power });
    } finally {
      clearTimeout(timer); worker.terminate(); channel.port1.close(); channel.port2.close();
    }
  }
  return { cycles, passed: results.every(result => result.power > 0), results };
}

/** Real graph continuity under browser-runner-injected asset/capability failures. */
export async function probePipelineFallback(requestedEngine, reportBrowserSuppression = false) {
  const { createMicrophonePipeline } = await import('../microphonePipeline');
  const context = new AudioContext({ sampleRate: 44100 });
  await context.resume();
  const oscillator = context.createOscillator(); oscillator.type = 'sawtooth'; oscillator.frequency.value = 180;
  const input = context.createGain(); input.gain.value = 0.15;
  const capture = context.createMediaStreamDestination();
  oscillator.connect(input); input.connect(capture); oscillator.start();
  const policies = [];
  let policyLocked = false;
  const instrument = track => {
    const nativeSettings = track.getSettings.bind(track);
    const nativeClone = track.clone.bind(track);
    let suppression;
    track.applyConstraints = async constraints => { policies.push(constraints); suppression = constraints.noiseSuppression; };
    track.getSettings = () => ({ ...nativeSettings(), ...(reportBrowserSuppression ? { noiseSuppression: policyLocked || reportBrowserSuppression === 'locked' ? true : suppression } : {}) });
    track.clone = () => instrument(nativeClone());
    return track;
  };
  const track = instrument(capture.stream.getAudioTracks()[0]);
  let pipeline;
  let source;
  const meter = context.createAnalyser(); meter.fftSize = 2048;
  const silent = context.createGain(); silent.gain.value = 0;
  try {
    const settings = { noiseReduction: true, noiseReductionEngine: requestedEngine,
      noiseSuppressionLevel: 'medium', micSensitivity: 100,
      inputVolume: 100, deepfilterSuppression: 70, micProfile: 'konusma', inputDevice: '' };
    pipeline = await createMicrophonePipeline(track, settings);
    const initialStatus = pipeline.getStatus();
    if (reportBrowserSuppression === 'late-locked') {
      policyLocked = true;
      await pipeline.update(settings);
    }
    source = context.createMediaStreamSource(new MediaStream([pipeline.processedTrack]));
    source.connect(meter); meter.connect(silent); silent.connect(context.destination);
    await new Promise(resolve => setTimeout(resolve, 600));
    const samples = new Float32Array(meter.fftSize); meter.getFloatTimeDomainData(samples);
    return { requestedEngine, captureConstraintsSimulated: true, reportBrowserSuppression, initialStatus,
      status: pipeline.getStatus(), finite: samples.every(Number.isFinite),
      power: samples.reduce((sum, value) => sum + value * value, 0) / samples.length, policies };
  } finally {
    source?.disconnect(); meter.disconnect(); silent.disconnect();
    await pipeline?.dispose(); oscillator.stop(); oscillator.disconnect(); input.disconnect(); capture.disconnect(); track.stop(); await context.close();
  }
}
