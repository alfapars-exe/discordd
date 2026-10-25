/** Energy gate, not speaker recognition. All timing is measured in samples. */
class VadGateProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.enabled = false;
    this.open = false;
    this.gain = 0;
    this.hold = 0;
    this.position = 0;
    this.meterSamples = 0;
    this.lookahead = Math.round(sampleRate * 0.01);
    this.delay = [];
    this.energy = new Float32Array(Math.max(1, Math.round(sampleRate * 0.01)));
    this.energyPosition = 0;
    this.energySum = 0;
    this.attack = 1 / Math.max(1, sampleRate * 0.005);
    this.release = 1 / Math.max(1, sampleRate * 0.08);
    this.destroyed = false;
    this.port.onmessage = ({ data }) => {
      if (data?.type === "DESTROY") { this.destroyed = true; return; }
      this.enabled = data?.disabled !== true;
      if (!this.enabled) { this.open = true; this.gain = 1; this.hold = 0; }
      this.openThreshold = 10 ** ((data?.openThresholdDb ?? -52) / 20);
      this.closeThreshold = 10 ** ((data?.closeThresholdDb ?? -58) / 20);
      this.holdSamples = Math.round(sampleRate * (data?.holdMs ?? 300) / 1000);
    };
  }
  process(inputs, outputs) {
    if (this.destroyed) return false;
    const input = inputs[0];
    const output = outputs[0];
    if (!output?.[0]) return true;
    const count = output[0].length;
    while (this.delay.length < output.length) this.delay.push(new Float32Array(this.lookahead + 1));
    let inputPower = 0;
    let outputPower = 0;
    for (let i = 0; i < count; i++) {
      const sample = input?.[0]?.[i] ?? 0;
      const finite = Number.isFinite(sample) ? sample : 0;
      const squared = finite * finite;
      this.energySum += squared - this.energy[this.energyPosition];
      this.energy[this.energyPosition] = squared;
      this.energyPosition = (this.energyPosition + 1) % this.energy.length;
      const rms = Math.sqrt(Math.max(0, this.energySum) / this.energy.length);
      if (this.enabled) {
        if (!this.open && rms >= this.openThreshold) { this.open = true; this.hold = this.holdSamples; }
        if (this.open) {
          if (rms >= this.closeThreshold) this.hold = this.holdSamples;
          else if (this.hold > 0) this.hold--;
          else this.open = false;
        }
        this.gain = this.open ? Math.min(1, this.gain + this.attack) : Math.max(0, this.gain - this.release);
      }
      for (let ch = 0; ch < output.length; ch++) {
        const value = input?.[ch]?.[i] ?? 0;
        const buffer = this.delay[ch];
        buffer[this.position] = Number.isFinite(value) ? value : 0;
        output[ch][i] = this.enabled
          ? buffer[(this.position + 1) % buffer.length] * this.gain
          : buffer[this.position];
      }
      this.position = (this.position + 1) % (this.lookahead + 1);
      inputPower += squared;
      outputPower += output[0][i] ** 2;
    }
    this.meterSamples += count;
    if (this.meterSamples >= sampleRate / 10) {
      this.meterSamples = 0;
      this.port.postMessage({ type: "METER", inputDb: 10 * Math.log10(Math.max(1e-12, inputPower / count)),
        outputDb: 10 * Math.log10(Math.max(1e-12, outputPower / count)), gateOpen: this.open });
    }
    return true;
  }
}
registerProcessor("vad-gate-processor", VadGateProcessor);
