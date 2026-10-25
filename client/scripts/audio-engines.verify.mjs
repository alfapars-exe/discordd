// Run: node --experimental-vm-modules --test scripts/audio-engines.verify.mjs
// Real shipped WASM + model inference in an isolated AudioWorklet-like realm.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../public/audio-engines/v1/', import.meta.url));
const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
const asset = async name => {
  const bytes = await fs.readFile(path.resolve(root, name));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};

async function realm(rate = 48000, entry = 'engine-worklet.js') {
  let Processor;
  const messages = [];
  const context = vm.createContext({
    WebAssembly, URL, TextDecoder, TextEncoder, Float32Array, performance, setTimeout, clearTimeout,
    // No Node process/require: exercise the same generated glue branch as browsers.
    sampleRate: rate,
    console: { log() {}, debug() {}, warn() {}, error() {} },
    AudioWorkletProcessor: class {
      constructor() { this.port = { postMessage: message => messages.push(message), close() {}, onmessage: null }; }
    },
    postMessage: message => messages.push(message),
    registerProcessor(name, ctor) { assert.match(name, /^hichat-/); Processor = ctor; },
  });
  context.self = context;
  const cache = new Map();
  async function load(file) {
    if (cache.has(file)) return cache.get(file);
    const module = new vm.SourceTextModule(await fs.readFile(file, 'utf8'), {
      context, identifier: file,
      initializeImportMeta(meta) { meta.url = new URL(`file:///${file.replaceAll('\\', '/')}`).href; },
    });
    cache.set(file, module);
    await module.link((specifier, from) => load(path.resolve(path.dirname(from.identifier), specifier)));
    return module;
  }
  const module = await load(path.join(root, entry));
  await module.evaluate();
  return { context, messages, Processor, dsp: cache.get(path.join(root, 'dsp.js'))?.namespace,
    deepfilter: cache.get(path.join(root, 'vendor/deepfilter.js'))?.namespace };
}

async function assets(engine) {
  if (engine === 'deepfilter') return {
    wasmModule: await WebAssembly.compile(await asset('../../deepfilter/v2/pkg/df_bg.wasm')),
    modelBytes: await asset('deepfilter-model.bin'), suppression: 70,
  };
  return { wasmBinary: await asset(`${engine}.wasm`) };
}

test('all binary assets match their pinned manifest hashes', async () => {
  for (const [name, expected] of Object.entries(manifest.files)) {
    const bytes = await asset(name);
    assert.equal(bytes.byteLength, expected.bytes, name);
    assert.equal(crypto.createHash('sha256').update(new Uint8Array(bytes)).digest('hex'), expected.sha256, name);
  }
});

for (const engine of ['rnnoise', 'gtcrn', 'speex', 'deepfilter']) {
  test(`${engine}: real model inference, finite changed output and disposal`, async () => {
    const { dsp } = await realm();
    const instance = await dsp.createDsp(engine, await assets(engine), 48000);
    let seed = 123456;
    let before = 0, after = 0, difference = 0;
    // Stationary noise is a deterministic denoising fixture, not a fake identity
    // model. Let adaptive engines settle, then compare the final second.
    for (let frame = 0; frame < 200; frame++) {
      const input = new Float32Array(instance.frameSize);
      for (let i = 0; i < input.length; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
        input[i] = (seed / 2147483648) * 0.05;
      }
      const original = input.slice();
      const output = instance.process(input);
      assert.equal(output.length, input.length);
      assert.ok(output.every(Number.isFinite));
      if (frame >= 100) for (let i = 0; i < input.length; i++) {
        before += original[i] ** 2;
        after += output[i] ** 2;
        difference += (original[i] - output[i]) ** 2;
      }
    }
    assert.ok(difference > 0.001, `${engine} must not silently pass through`);
    assert.ok(after < before * 0.9, `${engine} should suppress stationary noise; power ratio ${after / before}`);
    instance.setSuppressionLevel?.(25);
    instance.dispose();
    instance.dispose();
    assert.throws(() => instance.process(new Float32Array(instance.frameSize)), /disposed/);
    // A replacement owns fresh state and remains usable after its predecessor.
    const replacement = await dsp.createDsp(engine, await assets(engine), 48000);
    replacement.process(new Float32Array(replacement.frameSize));
    replacement.dispose();
  });
}

test('frame queue preserves continuous sample order across 480/128 boundaries', async () => {
  const { dsp } = await realm();
  const queue = new dsp.FrameQueue({ frameSize: 480, process: frame => frame, dispose() {} });
  const expected = [], actual = [];
  for (let block = 0; block < 50; block++) {
    const input = Float32Array.from({ length: block % 2 ? 128 : 256 }, (_, index) => expected.length + index + 1);
    expected.push(...input);
    const output = new Float32Array(input.length);
    queue.process(input, output);
    actual.push(...output);
  }
  assert.deepEqual(actual.slice(0, 480), Array(480).fill(0));
  assert.deepEqual(actual.slice(480), expected.slice(0, -480));
  queue.dispose();
});

test('worklet emits READY only after real inference, then acknowledges termination', async () => {
  const { Processor, messages } = await realm();
  const processor = new Processor({ processorOptions: { engine: 'rnnoise', ...await assets('rnnoise') } });
  assert.equal(messages.length, 0);
  for (let i = 0; i < 200 && !messages.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(messages[0]?.type, 'READY');
  assert.equal(messages[0]?.frameSize, 480);
  // A connected but completely silent microphone must keep the host watchdog alive.
  for (let block = 0; block < 375; block++) processor.process([[new Float32Array(128)]], [[new Float32Array(128)]]);
  assert.ok(messages.some(message => message.type === 'PROCESSING' && message.connected));
  processor.port.onmessage({ data: { type: 'DESTROY' } });
  assert.equal(messages.at(-1).type, 'DESTROYED');
  assert.equal(processor.process([[new Float32Array(128)]], [[new Float32Array(128)]]), false);
});

test('unsupported rate and corrupt model produce ERROR, never READY/passthrough', async () => {
  for (const engine of ['rnnoise', 'gtcrn', 'speex']) {
    const { Processor, messages } = await realm(44100);
    const processor = new Processor({ processorOptions: { engine, ...await assets(engine) } });
    for (let i = 0; i < 200 && !messages.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(messages[0]?.type, 'ERROR');
    assert.ok(!messages.some(message => message.type === 'READY'));
    const output = new Float32Array(128);
    assert.equal(processor.process([[Float32Array.from({ length: 128 }, () => 0.5)]], [[output]]), false);
    assert.ok(output.every(sample => sample === 0));
  }
  const { context, messages } = await realm(48000, 'deepfilter-worker.js');
  const broken = await assets('deepfilter');
  broken.modelBytes = new ArrayBuffer(10);
  await context.onmessage({ data: { type: 'INIT', assets: broken, port: { close() {} } } });
  assert.equal(messages[0]?.type, 'ERROR');
  assert.ok(!messages.some(message => message.type === 'READY'));
});

test('DeepFilter worker acknowledges real inference and transfers finite output frames', async () => {
  const { context, messages } = await realm(48000, 'deepfilter-worker.js');
  const results = [];
  const port = { onmessage: null, postMessage: result => results.push(result), close() {} };
  await context.onmessage({ data: { type: 'INIT', assets: await assets('deepfilter'), port } });
  assert.equal(messages[0]?.type, 'READY');
  for (let id = 0; id < 40; id++) {
    const samples = Float32Array.from({ length: 480 }, (_, i) => .1 * Math.sin((id * 480 + i) * Math.PI / 120));
    port.onmessage({ data: { id, samples } });
    const result = results.at(-1);
    assert.equal(result.id, id);
    assert.equal(result.samples.length, 480);
    assert.ok(result.samples.every(Number.isFinite));
    // A frame sent by the worker can really transfer without detaching its heap.
    const transferred = structuredClone(result.samples, { transfer: [result.samples.buffer] });
    assert.equal(transferred.length, 480);
  }
  port.onmessage({ data: { id: 40, samples: new Float32Array(1) } });
  assert.equal(messages.at(-1).type, 'ERROR');
});

test('DeepFilter render bridge preserves frame order and bounds a stalled worker queue', async () => {
  const { Processor, messages } = await realm(48000, 'deepfilter-bridge-worklet.js');
  const processor = new Processor();
  let respond = true;
  const port = { onmessage: null, close() {}, postMessage: frame => {
    if (respond) port.onmessage({ data: { id: frame.id, samples: frame.samples.slice() } });
  } };
  processor.port.onmessage({ data: { type: 'CONNECT', port } });
  const actual = [];
  for (let block = 0; block < 30; block++) {
    const input = Float32Array.from({ length: 128 }, (_, i) => block * 128 + i + 1);
    const output = new Float32Array(128);
    assert.equal(processor.process([[input]], [[output]]), true);
    actual.push(...output);
  }
  assert.deepEqual(actual.slice(0, 960), Array(960).fill(0));
  assert.deepEqual(actual.slice(960), Array.from({ length: actual.length - 960 }, (_, i) => i + 1));
  respond = false;
  let active = true;
  for (let block = 0; block < 100 && active; block++) active = processor.process([[new Float32Array(128)]], [[new Float32Array(128)]]);
  assert.equal(active, false);
  assert.ok(messages.some(message => message.type === 'ERROR' && message.message.includes('stopped responding')));
  assert.equal(messages.at(-1).type, 'DESTROYED');
});

test('DeepFilter releases per-frame allocations after model warm-up', async t => {
  const { deepfilter } = await realm();
  const runtime = deepfilter.createDeepFilterRuntime();
  const binary = await assets('deepfilter');
  const exports = runtime.initSync(binary.wasmModule);
  const state = runtime.df_create(new Uint8Array(binary.modelBytes), 70);
  const frame = Float32Array.from({ length: 480 }, (_, i) => .1 * Math.sin(i / 20));
  for (let i = 0; i < 100; i++) runtime.df_process_frame(state, frame);
  const before = exports.memory.buffer.byteLength;
  for (let i = 0; i < 1000; i++) {
    const output = runtime.df_process_frame(state, frame);
    assert.ok(output.every(Number.isFinite));
  }
  const after = exports.memory.buffer.byteLength;
  assert.equal(after, before, 'ten seconds of additional PCM must not keep growing the WASM heap');
  t.diagnostic(`WASM linear memory: ${before} -> ${after} bytes after 1000 additional frames`);
  // No unsafe raw-pointer destructor: this isolated realm/worker is discarded.
});
