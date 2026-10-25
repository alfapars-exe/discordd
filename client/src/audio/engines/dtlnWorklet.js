/* Audio thread only: bounded transport to the dedicated DTLN inference Worker. */
class DtlnBridgeProcessor extends AudioWorkletProcessor {
  constructor({ processorOptions }) {
    super();
    this.session = processorOptions.session;
    this.workerPort = null;
    this.sequence = 0;
    this.receivedSequence = 0;
    this.pending = 0;
    this.queue = [];
    this.offset = 0;
    this.started = false;
    this.failed = false;
    this.emptyBlocks = 0;
    this.inputFrame = new Float32Array(128);
    this.inputOffset = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type === "dispose") {
        this.failed = true;
        this.queue.length = 0;
        this.workerPort?.close();
      } else if (data.type === "connect" && data.session === this.session) {
        this.workerPort = data.port;
        this.workerPort.onmessage = ({ data: response }) => this.receive(response);
        this.workerPort.start();
      }
    };
  }

  fail(message) {
    if (this.failed) return;
    this.failed = true;
    this.queue.length = 0;
    this.port.postMessage({ type: "error", session: this.session, message });
  }

  receive(response) {
    if (this.failed || response.session !== this.session) return;
    if (response.type === "error") return this.fail(response.message);
    if (response.type !== "frame") return;
    if (response.sequence !== this.receivedSequence++) return this.fail("DTLN output sequence discontinuity");
    const frame = new Float32Array(response.buffer);
    if (frame.length !== 128 || frame.some((value) => !Number.isFinite(value))) return this.fail("DTLN invalid output frame");
    this.pending--;
    if (this.queue.length >= 8) return this.fail("DTLN output queue exceeded 64 ms");
    this.queue.push(frame);
  }

  process(inputs, outputs) {
    const output = outputs[0]?.[0];
    if (!output) return true;
    output.fill(0);
    if (this.failed) return false;
    const input = inputs[0]?.[0];
    // Disconnected input is common while preparing the graph. Do not queue
    // inference or start a stall timer until actual graph input is connected.
    if (!input || !this.workerPort) return true;
    for (let i = 0; i < input.length; i++) {
      this.inputFrame[this.inputOffset++] = input[i];
      if (this.inputOffset === 128) {
        if (this.pending >= 8) {
          this.fail("DTLN inference cannot keep up with real time (64 ms backlog)");
          return false;
        }
        const buffer = this.inputFrame.buffer;
        this.workerPort.postMessage({ type: "frame", session: this.session, sequence: this.sequence++, buffer }, [buffer]);
        this.pending++;
        this.inputFrame = new Float32Array(128);
        this.inputOffset = 0;
      }
    }
    // 24 ms of prefill absorbs worker scheduling jitter. No unbounded latency.
    if (!this.started && this.queue.length >= 3) this.started = true;
    if (!this.started) return true;
    for (let i = 0; i < output.length; i++) {
      const frame = this.queue[0];
      if (!frame) break;
      output[i] = frame[this.offset++];
      if (this.offset === frame.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    if (this.queue.length === 0) {
      this.emptyBlocks++;
      if (this.emptyBlocks >= 8) this.fail("DTLN output stalled for 64 ms");
    } else {
      this.emptyBlocks = 0;
    }
    return !this.failed;
  }
}
registerProcessor("hichat-dtln-bridge", DtlnBridgeProcessor);
