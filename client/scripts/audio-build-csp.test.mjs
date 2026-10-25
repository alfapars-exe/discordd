import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'vite';

test('production microphone gate is a same-origin script asset under the shipped CSP', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const result = await build({
    root,
    configFile: false,
    logLevel: 'silent',
    base: './',
    build: {
      write: false,
      minify: false,
      rollupOptions: { input: path.join(root, 'src/audio/microphonePipeline.ts'), preserveEntrySignatures: 'strict' },
    },
  });
  const files = (Array.isArray(result) ? result : [result]).flatMap(bundle => bundle.output);
  const gate = files.find(file => file.type === 'asset' && /vadGateWorklet.*\.js$/.test(file.fileName));
  assert.ok(gate, 'gate must be emitted as a file, not an inline data: script rejected by CSP');
  assert.match(String(gate.source), /registerProcessor\("vad-gate-processor"/);
  assert.ok(files.some(file => file.type === 'chunk' && file.code.includes(path.basename(gate.fileName))), 'bundle must reference the emitted worklet');
});
