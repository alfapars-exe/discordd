// node scripts/audio-compare-dtln.mjs [output-directory] [ffmpeg-path]
// Uses the exact shipped classic Worker runtime/model without browser or gate.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const client = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(client, 'public/dtln');
const outputRoot = path.resolve(process.argv[2] ?? path.join(client, '../artifacts/audio-qa'));
const ffmpeg = process.argv[3] ?? process.env.FFMPEG_PATH ?? 'ffmpeg';
const rate = 48000;
const modelRate = 16000;
const frameSamples = 128;
const rms = data => Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / Math.max(1, data.length));
const db = value => 20 * Math.log10(Math.max(value, 1e-12));
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const pinnedAssets = JSON.parse(fs.readFileSync(path.join(assets, 'asset-manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
const assetProvenance = {
  tfjs: pinnedAssets.tfjs, tflite: pinnedAssets.tflite, dtln: pinnedAssets.dtln,
  files: Object.fromEntries([...Object.keys(pinnedAssets.files), 'inference-worker.js', 'dtln-core.js', 'fft.js'].sort().map(name => {
    const bytes = fs.readFileSync(path.join(assets, name)), sha256 = hash(bytes);
    if (pinnedAssets.files[name] && pinnedAssets.files[name] !== sha256) throw Error(`DTLN asset hash mismatch: ${name}`);
    return [name, { bytes: bytes.length, sha256 }];
  })),
};
const percentiles = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return Object.fromEntries([50, 95, 99].map(p => [`p${p}`, sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p / 100))]]));
};

function readWave(bytes) {
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw Error('Expected RIFF WAV');
  let format, samples;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const name = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4), start = offset + 8;
    if (name === 'fmt ') format = { kind: bytes.readUInt16LE(start), channels: bytes.readUInt16LE(start + 2), rate: bytes.readUInt32LE(start + 4), bits: bytes.readUInt16LE(start + 14) };
    if (name === 'data') samples = bytes.subarray(start, start + length);
    offset = start + length + (length % 2);
  }
  if (!format || !samples || format.channels !== 1 || format.kind !== 1 || format.bits !== 16 || format.rate !== rate) throw Error('Expected mono PCM16 48 kHz input');
  return Float32Array.from({ length: samples.length / 2 }, (_, i) => samples.readInt16LE(i * 2) / 32768);
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
function resample(data, from, to) {
  const input = Buffer.alloc(data.length * 4);
  for (let i = 0; i < data.length; i++) input.writeFloatLE(data[i], i * 4);
  const child = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'f32le', '-ar', String(from), '-ac', '1', '-i', 'pipe:0', '-af', `aresample=${to}:resampler=swr:filter_size=64:phase_shift=10:cutoff=0.95:exact_rational=1`, '-f', 'f32le', '-ar', String(to), '-ac', '1', 'pipe:1'], { input, windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 30000 });
  if (child.error || child.status !== 0) throw child.error ?? Error(child.stderr.toString());
  return Float32Array.from({ length: child.stdout.length / 4 }, (_, i) => child.stdout.readFloatLE(i * 4));
}

async function createRuntime() {
  const loadAsset = url => fs.readFileSync(path.join(assets, new URL(url, 'http://dtln.local/').pathname.split('/').at(-1)));
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const sandbox = vm.createContext({
    console: { log() {}, debug() {}, warn() {}, error() {} }, setTimeout, clearTimeout, performance, TextDecoder, TextEncoder,
    URL, URLSearchParams, Blob, Response, Request, Headers, atob, btoa, WebAssembly,
    WorkerGlobalScope: class {}, navigator: { hardwareConcurrency: 2, userAgent: 'DTLN offline QA worker' },
    location: { href: 'http://dtln.local/inference-worker.js', origin: 'http://dtln.local' },
    crossOriginIsolated: false, SharedArrayBuffer: undefined,
    fetch: async url => new Response(loadAsset(String(url)), { headers: { 'Content-Type': String(url).endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream' } }),
    postMessage: message => resolveReady(message),
  });
  sandbox.self = sandbox;
  sandbox.importScripts = (...urls) => { for (const url of urls) vm.runInContext(loadAsset(url).toString('utf8'), sandbox, { filename: url }); };
  vm.runInContext(fs.readFileSync(path.join(assets, 'inference-worker.js'), 'utf8'), sandbox);
  await vm.runInContext("self.onmessage({data:{type:'init',session:'offline',assetBase:'http://dtln.local/',port:{start(){},postMessage(){}}}})", sandbox);
  const message = await ready;
  if (message.type !== 'ready') throw Error(JSON.stringify(message));
  return vm.runInContext('({ state: processState, frame: new Float32Array(128) })', sandbox);
}

// Match audio-compare.mjs: 1 ms envelope search, then sample correlation in
// the same speech-only window. Offline swresample compensates its own delay;
// this is model-only lag, not Worker/AudioWorklet or acoustic latency.
function correlation(reference, output, lag, stride = 32) {
  let dot = 0, xx = 0, yy = 0;
  for (let i = 3 * rate; i < reference.length - 2 * rate - 12000; i += stride) {
    const x = reference[i], y = output[i + lag] ?? 0;
    dot += x * y; xx += x * x; yy += y * y;
  }
  return dot / Math.sqrt(Math.max(1e-30, xx * yy));
}
function lagEstimate(reference, output) {
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

const clean = readWave(fs.readFileSync(path.join(outputRoot, 'inputs/clean.wav')));
const results = [];
for (const name of ['clean', 'fan', 'keyboard', 'transient']) {
  const bytes = fs.readFileSync(path.join(outputRoot, 'inputs', `${name}.wav`));
  const input = readWave(bytes), downsampled = resample(input, rate, modelRate);
  const initialized = performance.now(), runtime = await createRuntime(), initializationMs = performance.now() - initialized;
  const modelOutput = new Float32Array(downsampled.length), elapsed = [], cpu = [];
  try {
    for (let at = 0; at < downsampled.length; at += frameSamples) {
      runtime.frame.fill(0);
      runtime.frame.set(downsampled.subarray(at, at + frameSamples));
      const cpuStart = process.cpuUsage(), start = performance.now();
      const result = runtime.state.process(runtime.frame);
      elapsed.push(performance.now() - start);
      const usage = process.cpuUsage(cpuStart); cpu.push((usage.user + usage.system) / 1000);
      modelOutput.set(result.subarray(0, Math.min(result.length, modelOutput.length - at)), at);
    }
  } finally { runtime.state.dispose(); }
  const output = resample(modelOutput, modelRate, rate);
  if (output.length !== input.length) throw Error(`Unexpected resampling length: ${input.length} to ${output.length}`);
  const windows = { lead: [1.5 * rate, 2.5 * rate], tail: [input.length - rate, input.length] };
  const noiseOnly = name === 'clean' ? null : Object.fromEntries(Object.entries(windows).map(([window, [start, end]]) => {
    const before = rms(input.subarray(start, end)), after = rms(output.subarray(start, end));
    return [window, { inputRmsDbfs: db(before), outputRmsDbfs: db(after), attenuationDb: db(before) - db(after) }];
  }));
  const outputFile = `dtln-${name}.wav`;
  fs.writeFileSync(path.join(outputRoot, outputFile), wave(output));
  results.push({ fixture: name, inputSha256: hash(bytes), outputFile, modelSampleRate: modelRate, frameSamples, frameBudgetMs: frameSamples * 1000 / modelRate, frames: elapsed.length, initializationMs, inferenceWallMs: percentiles(elapsed), processCpuMs: percentiles(cpu), noiseOnly, outputLag: lagEstimate(clean, output), outputRmsDbfs: db(rms(output)), finite: output.every(Number.isFinite), clippedSamples: output.reduce((count, v) => count + (Math.abs(v) >= 1 ? 1 : 0), 0) });
  console.log(`dtln-${name}: ${elapsed.length} hops, p95=${percentiles(elapsed).p95.toFixed(3)} ms, lag=${results.at(-1).outputLag.milliseconds.toFixed(2)} ms`);
}
const ffmpegVersion = spawnSync(ffmpeg, ['-version'], { windowsHide: true, encoding: 'utf8' }).stdout.split(/\r?\n/)[0];
const report = { engine: 'dtln', createdAt: new Date().toISOString(), environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, ffmpeg: ffmpegVersion }, sampleRate: rate, modelSampleRate: modelRate, resampling: 'FFmpeg swresample, float32, filter_size=64, phase_shift=10, cutoff=0.95, exact_rational=1, 48-to-16-to-48 kHz; inference timings exclude resampling.', limitations: ['One Turkish sentence, originally 16 kHz; synthetic noise; cannot rank full-band speech quality, target-speaker isolation or all speakers.', 'Inputs are the exported PCM16 WAV fixtures, shared with the other engine comparisons; input hashes are recorded per fixture.', 'Real shipped TFLite model in classic Worker VM with one interpreter thread and 12-hop warmup, state reset before each fixture. Initialization includes loading and warmup.', 'No energy gate, live browser bridge/queue, microphone, LiveKit or P2P. Offline resampler compensates filter delay, so output lag is model-only correlation, not end-to-end latency.', 'Noise attenuation includes the 16 kHz bandwidth restriction; per-frame process CPU accounting is coarse and may be zero on Windows.', 'Float output drives metrics; exported listening files are PCM16. Values below PCM16 resolution cannot be assessed from the listening files.'], results };
report.assetProvenance = assetProvenance;
fs.writeFileSync(path.join(outputRoot, 'dtln.json'), JSON.stringify(report, null, 2) + '\n');
