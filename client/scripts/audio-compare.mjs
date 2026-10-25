// node --experimental-vm-modules scripts/audio-compare.mjs [output-directory]
// Set FFMPEG_PATH to include the separate DTLN/TFLite VM on the same fixtures.
// Offline DSP measurements only: no browser graph, gate, devices, or network.
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { strengthToAttenLimDb } from '../src/audio/deepfilterSuppression.ts';

const script = fileURLToPath(import.meta.url);
const client = path.resolve(path.dirname(script), '..');
const assetRoot = path.join(client, 'public/audio-engines/v1');
const fixtureRoot = path.join(client, 'public/audio-test-fixtures');
const outputRoot = path.resolve(process.argv[2] ?? path.join(client, '../artifacts/audio-qa'));
const engines = ['rnnoise', 'gtcrn', 'speex', 'deepfilter'];
const rate = 48000;
const seed = 0x10232026;
const deepfilterParameters = { uiStrength: 70, attenuationLimitDb: strengthToAttenLimDb(70), mapping: 'src/audio/deepfilterSuppression.ts#strengthToAttenLimDb' };
const rms = data => Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / Math.max(1, data.length));
const db = value => 20 * Math.log10(Math.max(value, 1e-12));
const hash = data => crypto.createHash('sha256').update(data).digest('hex');

function readWave(bytes) {
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw Error('Expected RIFF WAV');
  let format, samples;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const name = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4), start = offset + 8;
    if (name === 'fmt ') format = { kind: bytes.readUInt16LE(start), channels: bytes.readUInt16LE(start + 2), rate: bytes.readUInt32LE(start + 4), bits: bytes.readUInt16LE(start + 14) };
    if (name === 'data') samples = bytes.subarray(start, start + length);
    offset = start + length + (length % 2);
  }
  if (!format || !samples || format.channels !== 1) throw Error('Expected mono WAV');
  if (!((format.kind === 3 && format.bits === 32) || (format.kind === 1 && format.bits === 16))) throw Error('Unsupported PCM format');
  const result = new Float32Array(samples.length / (format.bits / 8));
  for (let i = 0; i < result.length; i++) result[i] = format.kind === 3 ? samples.readFloatLE(i * 4) : samples.readInt16LE(i * 2) / 32768;
  return { samples: result, rate: format.rate };
}

function wave(data) {
  const buffer = Buffer.alloc(44 + data.length * 2);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(data.length * 2, 40);
  for (let i = 0; i < data.length; i++) buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(32767 / 32768, data[i])) * 32768), 44 + i * 2);
  return buffer;
}

// Windowed-sinc interpolation, 32 input taps, fixed Hamming window. Upsampling
// a 16 kHz recording cannot restore speech content above 8 kHz.
function resample(input, inputRate) {
  const output = new Float32Array(Math.round(input.length * rate / inputRate));
  for (let i = 0; i < output.length; i++) {
    const position = i * inputRate / rate, center = Math.floor(position);
    let sum = 0, weights = 0;
    for (let n = center - 15; n <= center + 16; n++) {
      const distance = position - n;
      if (Math.abs(distance) >= 16) continue;
      const sinc = distance === 0 ? 1 : Math.sin(Math.PI * distance) / (Math.PI * distance);
      const weight = sinc * (0.54 + 0.46 * Math.cos(Math.PI * distance / 16));
      if (n >= 0 && n < input.length) sum += input[n] * weight;
      weights += weight;
    }
    output[i] = sum / weights;
  }
  return output;
}

async function fixtures() {
  const bytes = await fs.readFile(path.join(fixtureRoot, 'turkish-fleurs-original.wav'));
  const provenance = JSON.parse(await fs.readFile(path.join(fixtureRoot, 'provenance.json'), 'utf8'));
  if (hash(bytes) !== provenance.source_sha256) throw Error('Original fixture hash mismatch');
  const original = readWave(bytes), speech = resample(original.samples, original.rate);
  let peak = 0;
  for (const value of speech) peak = Math.max(peak, Math.abs(value));
  const clean = new Float32Array(speech.length + 5 * rate);
  for (let i = 0; i < speech.length; i++) clean[i + 3 * rate] = speech[i] * 0.45 / peak;
  let state = seed;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2147483648 - 1; };
  const fan = new Float32Array(clean.length), keyboard = new Float32Array(clean.length), transient = new Float32Array(clean.length);
  let low = 0;
  for (let i = 0; i < fan.length; i++) {
    low = low * 0.985 + random() * 0.015;
    fan[i] = low + 0.018 * Math.sin(2 * Math.PI * 90 * i / rate) + 0.009 * Math.sin(2 * Math.PI * 180 * i / rate);
  }
  const fanScale = 0.025 / rms(fan);
  for (let i = 0; i < fan.length; i++) fan[i] *= fanScale;
  for (let at = Math.round(0.2 * rate); at < keyboard.length; at += Math.round((0.13 + (random() + 1) * 0.11) * rate)) {
    for (let i = 0; i < 0.07 * rate && at + i < keyboard.length; i++) keyboard[at + i] += random() * Math.exp(-i / (0.008 * rate)) * 0.3;
  }
  for (const seconds of [0.5, 2.15, 4.8, 8.1, 11.8, 15.1, clean.length / rate - 0.65]) {
    const at = Math.round(seconds * rate);
    for (let i = 0; i < 0.3 * rate && at + i < transient.length; i++) transient[at + i] += (random() * 0.23 + Math.sin(2 * Math.PI * 130 * i / rate) * 0.11) * Math.exp(-i / (0.035 * rate));
  }
  const variants = { clean, fan: Float32Array.from(clean, (v, i) => v + fan[i]), keyboard: Float32Array.from(clean, (v, i) => v + keyboard[i]), transient: Float32Array.from(clean, (v, i) => v + transient[i]) };
  // Match the saved PCM16 inputs exactly, including for the separate DTLN VM.
  for (const samples of Object.values(variants)) for (let i = 0; i < samples.length; i++) samples[i] = Math.round(Math.max(-1, Math.min(32767 / 32768, samples[i])) * 32768) / 32768;
  return { variants, provenance, sourceRate: original.rate, speechSeconds: speech.length / rate };
}

async function realm() {
  const context = vm.createContext({ WebAssembly, URL, TextDecoder, TextEncoder, performance, setTimeout, clearTimeout, console: { log() {}, debug() {}, warn() {}, error() {} } });
  const cache = new Map();
  async function load(file) {
    if (cache.has(file)) return cache.get(file);
    const module = new vm.SourceTextModule(await fs.readFile(file, 'utf8'), { context, identifier: file, initializeImportMeta(meta) { meta.url = pathToFileURL(file).href; } });
    cache.set(file, module);
    await module.link((specifier, from) => load(path.resolve(path.dirname(from.identifier), specifier)));
    return module;
  }
  const module = await load(path.join(assetRoot, 'dsp.js'));
  await module.evaluate();
  return module.namespace;
}

async function assets(engine) {
  const read = async name => { const b = await fs.readFile(path.resolve(assetRoot, name)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
  return engine === 'deepfilter' ? { wasmModule: await WebAssembly.compile(await read('../../deepfilter/v2/pkg/df_bg.wasm')), modelBytes: await read('deepfilter-model.bin'), suppression: deepfilterParameters.attenuationLimitDb } : { wasmBinary: await read(`${engine}.wasm`) };
}

function percentiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return Object.fromEntries([50, 95, 99].map(p => [`p${p}`, sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p / 100))]]));
}

function correlation(reference, output, lag, stride = 32) {
  let dot = 0, xx = 0, yy = 0;
  for (let i = 3 * rate; i < reference.length - 2 * rate - 12000; i += stride) {
    const x = reference[i], y = output[i + lag] ?? 0;
    dot += x * y; xx += x * x; yy += y * y;
  }
  return dot / Math.sqrt(Math.max(1e-30, xx * yy));
}

function lagEstimate(reference, output) {
  // Coarse envelope correlation avoids aliasing when finding a 1 ms window.
  const envelope = data => Float64Array.from({ length: Math.floor(data.length / 48) }, (_, i) => rms(data.subarray(i * 48, i * 48 + 48)));
  const a = envelope(reference), b = envelope(output);
  let best = -Infinity, coarse = 0;
  for (let lag = 0; lag <= 250; lag++) {
    let dot = 0, xx = 0, yy = 0;
    for (let i = 3000; i < a.length - 2250; i++) { const x = a[i], y = b[i + lag]; dot += x * y; xx += x * x; yy += y * y; }
    const value = dot / Math.sqrt(Math.max(1e-30, xx * yy));
    if (value > best) { best = value; coarse = lag * 48; }
  }
  let lag = coarse;
  best = -Infinity;
  for (let candidate = Math.max(0, coarse - 96); candidate <= coarse + 96; candidate++) {
    const value = correlation(reference, output, candidate);
    if (value > best) { best = value; lag = candidate; }
  }
  return { samples: lag, milliseconds: lag * 1000 / rate, normalizedCorrelation: best, searchLimitMs: 250 };
}

async function compare(engine) {
  const { variants } = await fixtures(), dsp = await realm(), binary = await assets(engine), results = [];
  for (const [name, input] of Object.entries(variants)) {
    const initStart = performance.now();
    const instance = await dsp.createDsp(engine, binary, rate);
    const initializationMs = performance.now() - initStart;
    const output = new Float32Array(input.length), elapsed = [], cpu = [];
    for (let at = 0; at < input.length; at += instance.frameSize) {
      const frame = new Float32Array(instance.frameSize);
      frame.set(input.subarray(at, at + instance.frameSize));
      const cpuStart = process.cpuUsage(), start = performance.now();
      const result = instance.process(frame);
      elapsed.push(performance.now() - start);
      const usage = process.cpuUsage(cpuStart); cpu.push((usage.user + usage.system) / 1000);
      output.set(result.subarray(0, Math.min(result.length, output.length - at)), at);
    }
    instance.dispose();
    const windows = { lead: [1.5 * rate, 2.5 * rate], tail: [input.length - rate, input.length] };
    const noiseOnly = name === 'clean' ? null : Object.fromEntries(Object.entries(windows).map(([window, [start, end]]) => {
      const before = rms(input.subarray(start, end)), after = rms(output.subarray(start, end));
      return [window, { inputRmsDbfs: db(before), outputRmsDbfs: db(after), attenuationDb: db(before) - db(after) }];
    }));
    const destination = path.join(outputRoot, `${engine}-${name}.wav`);
    await fs.writeFile(destination, wave(output));
    results.push({ fixture: name, outputFile: path.basename(destination), frameSamples: instance.frameSize, frameBudgetMs: instance.frameSize * 1000 / rate, frames: elapsed.length, initializationMs, inferenceWallMs: percentiles(elapsed), processCpuMs: percentiles(cpu), noiseOnly, outputLag: lagEstimate(variants.clean, output), outputRmsDbfs: db(rms(output)), finite: output.every(Number.isFinite), clippedSamples: output.reduce((count, v) => count + (Math.abs(v) >= 1 ? 1 : 0), 0) });
    global.gc?.();
  }
  const sourceHashes = { benchmark: hash(await fs.readFile(script)), dsp: hash(await fs.readFile(path.join(assetRoot, 'dsp.js'))) };
  if (engine === 'deepfilter') sourceHashes.suppressionMapping = hash(await fs.readFile(path.join(client, 'src/audio/deepfilterSuppression.ts')));
  await fs.writeFile(path.join(outputRoot, `${engine}.json`), JSON.stringify({ engine, createdAt: new Date().toISOString(), parameters: engine === 'deepfilter' ? deepfilterParameters : {}, sourceHashes, results }, null, 2) + '\n');
}

async function runEngine(engine) {
  const start = performance.now();
  const status = await new Promise(resolve => {
    const args = engine === 'dtln'
      ? [path.join(path.dirname(script), 'audio-compare-dtln.mjs'), outputRoot, process.env.FFMPEG_PATH]
      : ['--experimental-vm-modules', '--expose-gc', script, outputRoot, '--engine', engine];
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 60000);
    child.on('error', error => { clearTimeout(timeout); resolve({ error: error.message }); });
    child.on('close', code => { clearTimeout(timeout); resolve({ code, timedOut }); });
  });
  console.log(`${engine}: ${status.code === 0 ? 'complete' : 'failed'} in ${((performance.now() - start) / 1000).toFixed(1)} s`);
  return status.code === 0 ? JSON.parse(await fs.readFile(path.join(outputRoot, `${engine}.json`), 'utf8')) : { engine, error: status };
}

async function writeReport(report) {
  report.benchmarkSourceSha256 = hash(await fs.readFile(script));
  report.parameters = { deepfilter: deepfilterParameters };
  await fs.writeFile(path.join(outputRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  const { source: provenance, results } = report;
  const lines = ['# Offline Turkish audio comparison', '', `[FLEURS](https://huggingface.co/datasets/google/fleurs) sample ${provenance.source_filename}, by ${provenance.attribution} Licensed [CC BY 4.0](${provenance.license_url}). Derived fixtures resample, normalize, pad and add synthetic noise; engine outputs apply denoising.`, '', `DeepFilterNet3 uses the app default UI strength ${deepfilterParameters.uiStrength}%, mapped by the shared app helper to a ${deepfilterParameters.attenuationLimitDb} dB attenuation limit.`, '', ...report.limitations.map(value => `- ${value}`), '', '| Engine / output WAV | Fixture / input WAV | Inference p50 / p95 / p99 (ms) | Lag (ms) | Correlation | Noise attenuation lead / tail (dB) |', '| --- | --- | --- | --- | --- | --- |'];
  for (const item of results) for (const result of item.results ?? []) lines.push(`| [${item.engine}](${result.outputFile}) | [${result.fixture}](inputs/${result.fixture}.wav) | ${Object.values(result.inferenceWallMs).map(v => v.toFixed(3)).join(' / ')} | ${result.outputLag.milliseconds.toFixed(2)} | ${result.outputLag.normalizedCorrelation.toFixed(3)} | ${result.noiseOnly ? Object.values(result.noiseOnly).map(v => v.attenuationDb.toFixed(1)).join(' / ') : 'n/a'} |`);
  for (const failure of results.filter(item => item.error)) lines.push(`\nFailed: ${failure.engine}: ${JSON.stringify(failure.error)}`);
  lines.push('', 'See report.json for immutable recording provenance, machine details, CPU accounting, initialization cost and measurement definitions. Input and output WAV files are PCM16 mono 48 kHz; inference uses the exact saved PCM16 input samples, and output measurements precede PCM16 output quantization.', '');
  await fs.writeFile(path.join(outputRoot, 'report.md'), lines.join('\n'));
}

await fs.mkdir(outputRoot, { recursive: true });
if (process.argv[3] === '--engine') {
  if (!engines.includes(process.argv[4])) throw Error('Unknown engine');
  await compare(process.argv[4]);
} else if (process.argv[3] === '--refresh') {
  const engine = process.argv[4];
  if (!engines.includes(engine)) throw Error('Unknown engine');
  const report = JSON.parse(await fs.readFile(path.join(outputRoot, 'report.json'), 'utf8'));
  const { variants } = await fixtures();
  for (const [name, samples] of Object.entries(variants)) if (hash(wave(samples)) !== report.fixtureFiles[name].sha256) throw Error('Cannot refresh against different input fixtures');
  const result = await runEngine(engine);
  if (result.error) throw Error(`Refresh failed: ${JSON.stringify(result.error)}`);
  report.results = report.results.map(previous => previous.engine === engine ? result : previous);
  report.updatedAt = new Date().toISOString();
  await writeReport(report);
} else {
  const { variants, provenance, sourceRate, speechSeconds } = await fixtures();
  await fs.mkdir(path.join(outputRoot, 'inputs'), { recursive: true });
  const fixtureFiles = {};
  for (const [name, samples] of Object.entries(variants)) {
    const bytes = wave(samples);
    await fs.writeFile(path.join(outputRoot, 'inputs', `${name}.wav`), bytes);
    fixtureFiles[name] = { path: `inputs/${name}.wav`, bytes: bytes.length, sha256: hash(bytes), seconds: samples.length / rate };
  }
  const results = [];
  for (const engine of [...engines, ...(process.env.FFMPEG_PATH ? ['dtln'] : [])]) {
    const result = await runEngine(engine);
    if (engine === 'dtln' && !result.error && result.results.some(item => item.inputSha256 !== fixtureFiles[item.fixture].sha256)) throw Error('DTLN fixture hash mismatch');
    results.push(result);
  }
  const engineManifest = JSON.parse(await fs.readFile(path.join(assetRoot, 'manifest.json'), 'utf8'));
  const dspSourceSha256 = hash(await fs.readFile(path.join(assetRoot, 'dsp.js')));
  const report = { createdAt: new Date().toISOString(), environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model }, sampleRate: rate, sourceRate, source: provenance, seed, fixtureFiles, engineManifest, dspSourceSha256, speechSeconds, leadingNoiseOnlySeconds: 3, trailingNoiseOnlySeconds: 2, fixtureGeneration: '32-tap Hamming-windowed sinc 16-to-48 kHz interpolation; speech peak 0.45; deterministic LCG; fan RMS 0.025; decaying keyboard bursts and transients', limitations: ['One read Turkish sentence, originally 16 kHz: cannot evaluate full-band speech above 8 kHz or represent all speakers.', 'Synthetic noise is controlled and repeatable; no subjective quality verdict or target-speaker isolation is measured.', 'Engine-only synchronous DSP: excludes FrameQueue, AudioWorklet/Worker queues, resampling transport, energy gate, LiveKit, device and browser latency.', 'Process CPU time has coarse OS accounting and can be zero per frame; inference wall-time percentiles are useful CPU-budget proxies, not end-to-end latency.', 'Output lag is waveform cross-correlation against clean speech over a bounded 0-250 ms search, not an acoustic latency measurement.', results.some(item => item.engine === 'dtln' && !item.error) ? 'DTLN uses its real TFLite Worker VM with offline 64-tap anti-alias 48-to-16-to-48 kHz resampling. Inference times exclude resampling, and attenuation includes its bandwidth restriction.' : 'DTLN omitted; set FFMPEG_PATH to include its separate TFLite/Worker VM.', 'WebRTC capture noise suppression is unmeasured: this offline harness does not emulate browser microphone DSP.'], results };
  await writeReport(report);
  if (results.some(result => result.error)) process.exitCode = 1;
}
