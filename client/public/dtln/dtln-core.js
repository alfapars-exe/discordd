/*
 * DTLN streaming transform, adapted from @sapphi-red/dtln-web 0.1.4
 * src/process.ts and src/fn.ts. Copyright (c) 2021 sapphi-red, MIT.
 * Model: Copyright (c) 2020 Nils L. Westhausen, MIT.
 * See THIRD_PARTY_LICENSES.txt. All mutable state belongs to this instance.
 */
(function () {
  "use strict";
  self.createDtlnProcess = function (tf, FFT, model1, model2) {
    const length = 512;
    const hop = 128;
    const bins = length / 2 + 1;
    const fft = new FFT(length);
    const input = new Float32Array(length);
    const overlap = new Float32Array(length);
    const spectrum = fft.createComplexArray();
    const inverse = fft.createComplexArray();
    const magnitude = new Float32Array(bins);
    const maskedSpectrum = fft.createComplexArray();
    const timeDomain = new Float32Array(length);
    const i1 = model1.inputs;
    const o1 = model1.outputs;
    const i2 = model2.inputs;
    const o2 = model2.outputs;
    let state1 = tf.zeros(i1[0].shape, "float32");
    let state2 = tf.zeros(i2[1].shape, "float32");
    let disposed = false;

    return {
      process(frame) {
        if (disposed) throw new Error("DTLN process is disposed");
        if (!(frame instanceof Float32Array) || frame.length !== hop) {
          throw new Error("DTLN requires exactly 128 samples at 16 kHz");
        }
        for (let j = 0; j < hop; j++) {
          if (!Number.isFinite(frame[j])) throw new Error("DTLN input is not finite");
        }
        input.copyWithin(0, hop);
        input.set(frame, length - hop);
        fft.realTransform(spectrum, input);
        for (let j = 0; j < bins; j++) {
          magnitude[j] = Math.hypot(spectrum[j * 2], spectrum[j * 2 + 1]);
        }

        // Materialize recurrent outputs before the next interpreter invocation:
        // TFLite outputs alias its WASM memory. tidy frees temporary tensors.
        const first = tf.tidy(() => {
          const result = model1.predict({
            [i1[0].name]: state1,
            [i1[1].name]: tf.tensor(magnitude, [1, 1, bins]),
          });
          return {
            mask: new Float32Array(result[o1[0].name].dataSync()),
            state: tf.tensor(new Float32Array(result[o1[1].name].dataSync()), i1[0].shape),
          };
        });
        state1.dispose();
        state1 = first.state;
        for (let j = 0; j < bins; j++) {
          maskedSpectrum[j * 2] = spectrum[j * 2] * first.mask[j];
          maskedSpectrum[j * 2 + 1] = spectrum[j * 2 + 1] * first.mask[j];
        }
        fft.completeSpectrum(maskedSpectrum);
        fft.inverseTransform(inverse, maskedSpectrum);
        for (let j = 0; j < length; j++) timeDomain[j] = inverse[j * 2];
        const second = tf.tidy(() => {
          const result = model2.predict({
            [i2[1].name]: state2,
            [i2[0].name]: tf.tensor(timeDomain, [1, 1, length]),
          });
          return {
            block: new Float32Array(result[o2[1].name].dataSync()),
            state: tf.tensor(new Float32Array(result[o2[0].name].dataSync()), i2[1].shape),
          };
        });
        state2.dispose();
        state2 = second.state;
        overlap.copyWithin(0, hop);
        overlap.fill(0, length - hop);
        for (let j = 0; j < length; j++) overlap[j] += second.block[j];
        const output = overlap.slice(0, hop);
        for (let j = 0; j < hop; j++) {
          if (!Number.isFinite(output[j])) throw new Error("DTLN output is not finite");
        }
        return output;
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        state1.dispose();
        state2.dispose();
        input.fill(0);
        overlap.fill(0);
      },
    };
  };
})();
