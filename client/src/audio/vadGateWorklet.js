/**
 * VadGateProcessor — Hysteresis-based voice activity gate (AudioWorklet).
 *
 * Inserted after RNNoise in the pipeline. Computes RMS energy per block,
 * runs it through a CLOSED → OPEN → CLOSING → CLOSED state machine, and
 * outputs silence when the gate is closed. Two thresholds (dB) prevent
 * flickering on borderline speech:
 *
 *   openThreshold   — gate transitions CLOSED → OPEN above this RMS level
 *   closeThreshold  — gate transitions OPEN → CLOSING below this; then waits
 *                     holdMs at silence before becoming fully CLOSED
 *
 * Pattern adapted from @sapphi-red/web-noise-suppressor's noiseGate but
 * extended with port.postMessage updates so the main thread can switch
 * "Gürültü Engelleme Seviyesi" without recreating the worklet.
 *
 * Backwards-compat: a legacy `{ threshold }` message switches the gate to
 * single-threshold mode (close = open) so existing call sites that haven't
 * been migrated keep working.
 *
 * Pipeline: RNNoise → [VadGateProcessor] → Destination
 */

const State = { CLOSED: 0, OPEN: 1, CLOSING: 2 };
const BLOCK_SIZE = 128;

function dbToLinear(db) {
  return Math.pow(10, db / 20);
}

class VadGateProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // null = gate disabled (pass-through). Two thresholds in dB; close < open
    // gives hysteresis. holdMs is how long we stay CLOSING before fully closing —
    // prevents word-ending clipping.
    this._openLinear = null;   // RMS level for CLOSED → OPEN
    this._closeLinear = null;  // RMS level for OPEN → CLOSING
    this._holdBlocks = 0;      // number of blocks the silent state must persist before CLOSED
    this._state = State.CLOSED;
    this._holdCounter = 0;

    // Smoothing for output (avoids click on state transitions). Block-level
    // gain envelope rather than per-sample to keep CPU low.
    this._gainCurrent = 0;
    this._gainAttack = 0.6;     // ~3 blocks to fully open (≈8 ms at 48 kHz)
    this._gainRelease = 0.05;   // ~80 ms ramp to silence

    this.port.onmessage = (event) => this.handleMessage(event.data);
  }

  handleMessage(data) {
    if (data == null) return;

    if (data.disabled === true) {
      this._openLinear = null;
      this._closeLinear = null;
      this._holdBlocks = 0;
      return;
    }

    if (typeof data.openThresholdDb === "number" && typeof data.closeThresholdDb === "number") {
      this._openLinear = dbToLinear(data.openThresholdDb);
      this._closeLinear = dbToLinear(data.closeThresholdDb);
      const holdMs = typeof data.holdMs === "number" ? data.holdMs : 200;
      const blocksPerSecond = sampleRate / BLOCK_SIZE;
      this._holdBlocks = Math.max(1, Math.ceil((holdMs / 1000) * blocksPerSecond));
      return;
    }

    // Legacy linear RMS threshold (kept for backwards-compat with the
    // sensitivityToThreshold curve in RNNoiseProcessor).
    if (typeof data.threshold === "number") {
      if (data.threshold <= 0) {
        this._openLinear = null;
        this._closeLinear = null;
        this._holdBlocks = 0;
      } else {
        this._openLinear = data.threshold;
        // 6 dB hysteresis below open — equivalent to ratio 0.5
        this._closeLinear = data.threshold * 0.5;
        const blocksPerSecond = sampleRate / BLOCK_SIZE;
        this._holdBlocks = Math.max(1, Math.ceil(0.2 * blocksPerSecond)); // 200 ms
      }
    }
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];

    if (!input || !input[0]) return true;

    // Pass-through when gate disabled.
    if (this._openLinear == null) {
      for (let ch = 0; ch < input.length; ch++) {
        output[ch]?.set(input[ch]);
      }
      return true;
    }

    // RMS across the first channel (mono mic). Cheaper than averaging all
    // channels and the result is the same for typical mono inputs.
    const samples = input[0];
    let sumSq = 0;
    for (let i = 0; i < samples.length; i++) {
      sumSq += samples[i] * samples[i];
    }
    const rms = Math.sqrt(sumSq / samples.length);

    switch (this._state) {
      case State.CLOSED:
        if (rms > this._openLinear) this._state = State.OPEN;
        break;
      case State.OPEN:
        if (rms < this._closeLinear) {
          this._state = State.CLOSING;
          this._holdCounter = 0;
        }
        break;
      case State.CLOSING:
        if (rms > this._closeLinear) {
          this._state = State.OPEN;
        } else if (this._holdCounter >= this._holdBlocks) {
          this._state = State.CLOSED;
        } else {
          this._holdCounter++;
        }
        break;
      default:
        break;
    }

    const gateOpen = this._state === State.OPEN || this._state === State.CLOSING;
    const targetGain = gateOpen ? 1.0 : 0.0;
    const coeff = targetGain > this._gainCurrent ? this._gainAttack : this._gainRelease;
    this._gainCurrent += coeff * (targetGain - this._gainCurrent);
    if (this._gainCurrent < 0.001) this._gainCurrent = 0.0;

    for (let ch = 0; ch < input.length; ch++) {
      if (!output[ch]) continue;
      const inp = input[ch];
      const out = output[ch];
      for (let i = 0; i < inp.length; i++) {
        out[i] = inp[i] * this._gainCurrent;
      }
    }

    return true;
  }
}

registerProcessor("vad-gate-processor", VadGateProcessor);
