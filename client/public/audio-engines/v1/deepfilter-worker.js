// Private worker = private WASM heap. terminate() reclaims the entire model;
// this ABI does not expose a safe destructor for df_create's raw pointer.
import { createDsp } from './dsp.js';

let dsp = null;
let port = null;
let disposed = false;
const fail = error => {
  if (disposed) return;
  self.postMessage({ type: 'ERROR', message: error instanceof Error ? error.message : String(error) });
  disposed = true;
  dsp?.dispose(); dsp = null;
  port?.close(); port = null;
};
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'INIT') {
      if (dsp || disposed) throw new Error('DeepFilter worker initialized twice');
      dsp = await createDsp('deepfilter', data.assets, 48000);
      data.assets.wasmBinary = data.assets.modelBytes = null;
      if (disposed) { dsp.dispose(); dsp = null; return; }
      port = data.port;
      port.onmessage = ({ data: frame }) => {
        if (disposed) return;
        try {
          if (!(frame.samples instanceof Float32Array) || frame.samples.length !== dsp.frameSize) throw new Error('Invalid DeepFilter input frame');
          // Never transfer the WASM linear-memory buffer itself.
          const samples = dsp.process(frame.samples).slice();
          port.postMessage({ id: frame.id, samples }, [samples.buffer]);
        } catch (error) { fail(error); }
      };
      self.postMessage({ type: 'READY', engine: 'deepfilter', sampleRate: 48000, frameSize: dsp.frameSize });
    } else if (data.type === 'CONFIG') dsp?.setSuppressionLevel?.(data.suppression);
  } catch (error) { fail(error); }
};
