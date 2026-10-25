/**
 * Dev-only, in-page transport acceptance probe. Run via the approved browser
 * page.evaluate() on the local Vite origin; never opens a microphone.
 * A session connects two participants to the local LiveKit dev server. Call
 * run(engine) separately for each engine, then close(). Recordings remain
 * exportable with recordingBase64(id) until the page is closed.
 * Synthetic capture verifies processing and transport, not browser capture DSP
 * effectiveness, subjective speech quality, or acoustic echo cancellation.
 */
import { LocalAudioTrack, Room, RoomEvent, Track } from "livekit-client";
import { MicrophoneTrackProcessor } from "../MicrophoneTrackProcessor.ts";
import { createMicrophonePipeline } from "../microphonePipeline.ts";
import { micPublishFor } from "../micProfile.ts";

export const TRANSPORT_ENGINES = ["rnnoise", "gtcrn", "deepfilter", "dtln", "speex", "webrtc"];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const b64 = (bytes) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const encode = (value) => b64(new TextEncoder().encode(JSON.stringify(value)));

async function localDevToken(identity, room) {
  const now = Math.floor(Date.now() / 1000);
  const body = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    iss: "devkey", sub: identity, nbf: now - 10, exp: now + 900,
    video: { roomJoin: true, room, canPublish: true, canSubscribe: true },
  })}`;
  // Public LiveKit --dev credentials, valid only for the loopback test server.
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${b64(new Uint8Array(signature))}`;
}

function deadline(promise, message, milliseconds = 10000) {
  let timer;
  return Promise.race([promise, new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

function makeSyntheticSource(context, captureConstraintsLog, fixtureBuffer) {
  const source = context.createBufferSource();
  const sampleRate = context.sampleRate;
  const buffer = fixtureBuffer ?? context.createBuffer(1, sampleRate * 3, sampleRate);
  if (!fixtureBuffer) {
    const samples = buffer.getChannelData(0);
    let seed = 0x526e6473;
    let phase = 0;
    for (let i = 0; i < samples.length; i++) {
      const t = i / sampleRate;
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      const noise = ((seed >>> 0) / 4294967296 - 0.5) * 0.008;
      phase += 2 * Math.PI * (145 + 35 * Math.sin(t * 8)) / sampleRate;
      const envelope = 0.3 + 0.7 * Math.sin(Math.PI * 3.5 * t) ** 2;
      samples[i] = envelope * (0.15 * Math.sin(phase) + 0.06 * Math.sin(phase * 2) + 0.03 * Math.sin(phase * 3)) + noise;
    }
  }
  source.buffer = buffer;
  source.loop = !fixtureBuffer;
  const destination = context.createMediaStreamDestination();
  destination.channelCount = 1;
  source.connect(destination);
  let started = false;
  const start = () => { if (!started) { started = true; source.start(); } };
  if (!fixtureBuffer) start();
  // A MediaStreamDestination track is not a capture device: Chromium rejects
  // hardware sample-rate/echo-cancellation constraints on it. Preserve the
  // production pipeline policy calls, but simulate only these synthetic track
  // methods and record every requested policy (including fallback clones).
  let nextTrackId = 0;
  const instrument = (track) => {
    const trackId = `synthetic-${nextTrackId++}`;
    const clone = track.clone.bind(track);
    const actualSettings = track.getSettings.bind(track);
    let simulatedSuppression = actualSettings().noiseSuppression;
    Object.defineProperty(track, "applyConstraints", { configurable: true, value: async (constraints = {}) => {
      captureConstraintsLog.push({ trackId, constraints: structuredClone(constraints) });
      if (typeof constraints.noiseSuppression === "boolean") simulatedSuppression = constraints.noiseSuppression;
    } });
    Object.defineProperty(track, "getSettings", { configurable: true, value: () => ({ ...actualSettings(),
      ...(simulatedSuppression === undefined ? {} : { noiseSuppression: simulatedSuppression }) }) });
    Object.defineProperty(track, "clone", { configurable: true, value: () => instrument(clone()) });
    return track;
  };
  return { track: instrument(destination.stream.getAudioTracks()[0]), start,
    get started() { return started; },
    dispose() {
    if (started) source.stop();
    source.disconnect(); destination.disconnect();
    destination.stream.getTracks().forEach((track) => track.stop());
  } };
}

function nextRemoteAudio(room) {
  let handler;
  let rejectWait;
  const pending = new Promise((resolve, reject) => {
    rejectWait = reject;
    handler = (track) => { if (track.kind === "audio") resolve(track); };
    room.on(RoomEvent.TrackSubscribed, handler);
  });
  const promise = deadline(pending, "LiveKit did not deliver a remote audio track").finally(() => room.off(RoomEvent.TrackSubscribed, handler));
  void promise.catch(() => {});
  return { promise, cancel() { room.off(RoomEvent.TrackSubscribed, handler); rejectWait(new Error("Remote audio wait cancelled")); } };
}

async function directPeerPair(track) {
  const sender = new RTCPeerConnection({ iceServers: [] });
  const receiver = new RTCPeerConnection({ iceServers: [] });
  const remote = new Promise((resolve) => { receiver.ontrack = (event) => resolve(event.track); });
  const iceQueues = new Map([[sender, []], [receiver, []]]);
  for (const [from, to] of [[sender, receiver], [receiver, sender]]) {
    from.onicecandidate = ({ candidate }) => {
      if (!candidate) return;
      if (to.remoteDescription) void to.addIceCandidate(candidate).catch(() => {});
      else iceQueues.get(to).push(candidate);
    };
  }
  const flushIce = async (peer) => {
    for (const candidate of iceQueues.get(peer).splice(0)) await peer.addIceCandidate(candidate);
  };
  try {
    const rtpSender = sender.addTrack(track, new MediaStream([track]));
    await sender.setLocalDescription(await sender.createOffer());
    await receiver.setRemoteDescription(sender.localDescription);
    await flushIce(receiver);
    await receiver.setLocalDescription(await receiver.createAnswer());
    await sender.setRemoteDescription(receiver.localDescription);
    await flushIce(sender);
    const received = await deadline(remote, "P2P did not deliver a remote audio track");
    await deadline(new Promise((resolve, reject) => {
      const check = () => {
        if (receiver.connectionState === "connected") resolve();
        if (receiver.connectionState === "failed" || receiver.connectionState === "closed") reject(new Error(`P2P ${receiver.connectionState}`));
      };
      receiver.onconnectionstatechange = check;
      check();
    }), "P2P ICE did not connect");
    return { track: received, rtpSender, receiver, close() { sender.close(); receiver.close(); } };
  } catch (error) { sender.close(); receiver.close(); throw error; }
}

function monitor(context, track) {
  const source = context.createMediaStreamSource(new MediaStream([track]));
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  const silent = context.createGain();
  silent.gain.value = 0;
  source.connect(analyser); analyser.connect(silent); silent.connect(context.destination);
  const samples = new Float32Array(analyser.fftSize);
  const values = [];
  let finite = true;
  return {
    sample() {
      analyser.getFloatTimeDomainData(samples);
      let power = 0;
      for (const value of samples) { finite &&= Number.isFinite(value); power += value * value; }
      values.push(Math.sqrt(power / samples.length));
    },
    result() { return { finite, frames: values.length, nonzeroFrames: values.filter((v) => v > 1e-7).length,
      maxRms: Math.max(0, ...values), meanRms: values.reduce((sum, v) => sum + v, 0) / Math.max(1, values.length) }; },
    close() { source.disconnect(); analyser.disconnect(); silent.disconnect(); },
  };
}

function trackSnapshot(track) {
  return track ? { id: track.id, enabled: track.enabled, muted: track.muted, readyState: track.readyState,
    settings: track.getSettings() } : null;
}
function contextSnapshot(context) {
  return context ? { state: context.state, currentTime: context.currentTime, sampleRate: context.sampleRate,
    baseLatency: context.baseLatency, outputLatency: context.outputLatency } : null;
}
async function rtpStats(read) {
  try {
    const reports = await read();
    if (!reports) return null;
    if (typeof reports.values !== "function") return reports;
    return [...reports.values()].filter((report) => ["inbound-rtp", "outbound-rtp", "remote-inbound-rtp", "remote-outbound-rtp", "media-source"].includes(report.type))
      .map((report) => ({ ...report }));
  } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}

function recorder(track) {
  if (typeof MediaRecorder === "undefined") return null;
  const mime = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"].find((type) => MediaRecorder.isTypeSupported(type));
  if (!mime) return null;
  const instance = new MediaRecorder(new MediaStream([track]), { mimeType: mime });
  const chunks = [];
  instance.ondataavailable = ({ data }) => { if (data.size) chunks.push(data); };
  instance.start();
  return { stop() {
    return deadline(new Promise((resolve, reject) => {
      instance.onstop = () => resolve(new Blob(chunks, { type: mime }));
      instance.onerror = () => reject(new Error("Remote audio recorder failed"));
      if (instance.state === "inactive") resolve(new Blob(chunks, { type: mime }));
      else instance.stop();
    }), "Remote audio recorder did not stop", 3000);
  } };
}

async function pairedPcmRecorder(context, localTrack, remoteTrack) {
  // One render quantum/clock for both channels avoids comparing independent
  // MediaRecorder origins or an offline model with different recurrent state.
  const code = `class PairCapture extends AudioWorkletProcessor {
    constructor() {
      super(); this.block = new Float32Array(8192); this.frames = 0; this.stopped = false;
      this.port.onmessage = ({data}) => { if (data?.type === 'STOP' && !this.stopped) {
        this.flush(); this.stopped = true; this.port.postMessage({type:'DONE'});
      }};
    }
    flush() { if (this.frames) {
      const samples = this.block.slice(0, this.frames * 2);
      this.port.postMessage({type:'PCM',samples}, [samples.buffer]); this.frames = 0;
    }}
    process(inputs, outputs) {
      if (this.stopped) return false;
      const count = outputs[0][0].length;
      for (let i = 0; i < count; i++) {
        this.block[this.frames * 2] = inputs[0]?.[0]?.[i] ?? 0;
        this.block[this.frames * 2 + 1] = inputs[0]?.[1]?.[i] ?? 0;
        if (++this.frames === 4096) this.flush();
      }
      outputs[0][0].fill(0); return true;
    }
  } registerProcessor('hichat-probe-pair-capture', PairCapture);`;
  const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  try { await deadline(context.audioWorklet.addModule(url), "Paired PCM recorder module did not start"); }
  finally { URL.revokeObjectURL(url); }
  const merger = context.createChannelMerger(2);
  const node = new AudioWorkletNode(context, "hichat-probe-pair-capture", {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    channelCount: 2, channelCountMode: "explicit", channelInterpretation: "discrete",
  });
  const sources = [localTrack, remoteTrack].map((track) => context.createMediaStreamSource(new MediaStream([track])));
  const mono = sources.map(() => { const gain = context.createGain(); gain.channelCount = 1; gain.channelCountMode = "explicit"; return gain; });
  sources.forEach((source, index) => { source.connect(mono[index]); mono[index].connect(merger, 0, index); });
  const chunks = [];
  let complete;
  let pending;
  node.port.onmessage = ({ data }) => {
    if (data?.type === "PCM") chunks.push(data.samples);
    if (data?.type === "DONE") complete?.();
  };
  merger.connect(node); node.connect(context.destination);
  return { stop() {
    if (pending) return pending;
    pending = (async () => {
      try {
        await deadline(new Promise((resolve) => { complete = resolve; node.port.postMessage({ type: "STOP" }); }), "Paired PCM recorder did not stop", 3000);
        const sampleCount = chunks.reduce((total, chunk) => total + chunk.length, 0);
        const header = new ArrayBuffer(44);
        const view = new DataView(header);
        const text = (at, value) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)); };
        text(0, "RIFF"); view.setUint32(4, 36 + sampleCount * 4, true); text(8, "WAVEfmt ");
        view.setUint32(16, 16, true); view.setUint16(20, 3, true); view.setUint16(22, 2, true);
        view.setUint32(24, context.sampleRate, true); view.setUint32(28, context.sampleRate * 8, true);
        view.setUint16(32, 8, true); view.setUint16(34, 32, true); text(36, "data"); view.setUint32(40, sampleCount * 4, true);
        if (new Uint8Array(new Uint32Array([1]).buffer)[0] !== 1) throw new Error("Paired PCM export requires little-endian host");
        return new Blob([header, ...chunks], { type: "audio/wav" });
      } finally {
        sources.forEach((source) => source.disconnect()); mono.forEach((gain) => gain.disconnect());
        merger.disconnect(); node.disconnect(); node.port.close();
      }
    })();
    return pending;
  } };
}

export async function createTransportProbeSession({ url = "ws://127.0.0.1:17880" } = {}) {
  const endpoint = new URL(url);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)) throw new Error("Transport probe requires a loopback LiveKit server");
  const roomName = `hichat-audio-qa-${crypto.randomUUID()}`;
  const publisher = new Room({ adaptiveStream: false, dynacast: false });
  const subscriber = new Room({ adaptiveStream: false, dynacast: false });
  const recordings = new Map();
  let running = false;
  let closed = false;
  try {
    await Promise.all([
      publisher.connect(url, await localDevToken("synthetic-publisher", roomName), { maxRetries: 0, websocketTimeout: 5000, peerConnectionTimeout: 5000 }),
      subscriber.connect(url, await localDevToken("synthetic-listener", roomName), { maxRetries: 0, websocketTimeout: 5000, peerConnectionTimeout: 5000 }),
    ]);
  } catch (error) { await Promise.all([publisher.disconnect(), subscriber.disconnect()]); throw error; }
  return {
    engines: [...TRANSPORT_ENGINES], roomName,
    async run(engine, { durationMs, record = true, sourceSampleRate = 44100, fixtureUrl, productionPublishProfile = false, diagnosticPair = false } = {}) {
      if (!TRANSPORT_ENGINES.includes(engine)) throw new Error("Unknown free audio engine");
      if (diagnosticPair && !record) throw new Error("Paired PCM diagnostics require recording");
      if (running || closed) throw new Error("Transport session is busy or closed");
      running = true;
      const settings = { noiseReduction: true, noiseReductionEngine: engine, noiseSuppressionLevel: "medium",
        micSensitivity: 100, inputVolume: 100, deepfilterSuppression: 70, micProfile: "konusma", inputDevice: "" };
      const publishOptions = { source: Track.Source.Microphone,
        ...(productionPublishProfile ? micPublishFor("konusma") : { dtx: false, red: false }) };
      const context = new AudioContext({ sampleRate: sourceSampleRate, latencyHint: "interactive" });
      let synthetic, localTrack, processor, directPipeline, pair, remoteWait, liveRemoteTrack;
      const meters = [];
      const recorders = [];
      const remoteAudioElements = [];
      const captureConstraintsLog = [];
      const sourceClock = [];
      const diagnostics = () => ({
        sourceContext: contextSnapshot(context), processorContext: contextSnapshot(processor?.context), sourceClock,
        sourceStarted: synthetic?.started, localTrackMuted: localTrack?.isMuted,
        rawTrack: trackSnapshot(synthetic?.track), livekitProcessedTrack: trackSnapshot(processor?.processedTrack),
        p2pProcessedTrack: trackSnapshot(directPipeline?.processedTrack),
        livekitRemoteTrack: trackSnapshot(liveRemoteTrack), p2pRemoteTrack: trackSnapshot(pair?.track),
        rawPcm: meters[2]?.result(), livekitProcessedPcm: meters[3]?.result(), p2pProcessedPcm: meters[4]?.result(),
        livekitPipelineStatus: processor?.pipeline?.getStatus(), p2pPipelineStatus: directPipeline?.getStatus(),
      });
      try {
        await context.resume();
        sourceClock.push({ stage: "resumed", ...contextSnapshot(context) });
        let fixtureBuffer;
        if (fixtureUrl) {
          const response = await deadline(fetch(fixtureUrl), "Audio fixture download timed out");
          if (!response.ok) throw new Error(`Audio fixture download failed: ${response.status}`);
          fixtureBuffer = await deadline(context.decodeAudioData(await response.arrayBuffer()), "Audio fixture decode timed out");
        }
        synthetic = makeSyntheticSource(context, captureConstraintsLog, fixtureBuffer);
        localTrack = new LocalAudioTrack(synthetic.track, {}, true);
        processor = new MicrophoneTrackProcessor(settings, localTrack);
        const started = performance.now();
        await localTrack.setProcessor(processor);
        await processor.update(settings);
        remoteWait = nextRemoteAudio(subscriber);
        await publisher.localParticipant.publishTrack(localTrack, publishOptions);
        const remote = await remoteWait.promise;
        liveRemoteTrack = remote.mediaStreamTrack;
        directPipeline = await createMicrophonePipeline(synthetic.track, settings);
        pair = await directPeerPair(directPipeline.processedTrack);
        // Match the production receive path: explicitly start playout while
        // keeping the headless diagnostic inaudible. Some browsers do not
        // begin the remote WebRTC audio renderer for an analyser alone.
        for (const track of [remote.mediaStreamTrack, pair.track]) {
          const audio = new Audio();
          audio.muted = true;
          audio.autoplay = true;
          audio.srcObject = new MediaStream([track]);
          document.body.append(audio);
          remoteAudioElements.push(audio);
          await deadline(audio.play(), "Remote audio playout did not start");
        }
        await deadline(subscriber.startAudio(), "LiveKit remote audio playout did not start");
        const setupMs = performance.now() - started;
        sourceClock.push({ stage: "transports-ready-before-local-monitors", ...contextSnapshot(context) });
        meters.push(monitor(context, remote.mediaStreamTrack), monitor(context, pair.track),
          monitor(context, synthetic.track), monitor(context, processor.processedTrack), monitor(context, directPipeline.processedTrack));
        await delay(350);
        if (record) recorders.push(recorder(remote.mediaStreamTrack), recorder(pair.track));
        if (diagnosticPair) recorders.push(await pairedPcmRecorder(context, processor.processedTrack, remote.mediaStreamTrack));
        // A file begins only after both receivers and their recorders are ready.
        // decodeAudioData has resampled it to the requested source context rate.
        if (fixtureBuffer) synthetic.start();
        sourceClock.push({ stage: "recording-start", ...contextSnapshot(context) });
        const requestedDuration = durationMs ?? (fixtureBuffer ? fixtureBuffer.duration * 1000 + 250 : 1800);
        const count = Math.max(10, Math.min(500, Math.ceil(requestedDuration / 50)));
        for (let i = 0; i < count; i++) { await delay(50); meters.forEach((meter) => meter.sample()); }
        sourceClock.push({ stage: "recording-end", ...contextSnapshot(context) });
        const clips = [];
        for (let i = 0; i < recorders.length; i++) {
          const blob = await recorders[i]?.stop();
          if (!blob?.size) continue;
          const paired = i === 2 && diagnosticPair;
          const transport = i === 0 || paired ? "livekit" : "p2p";
          const id = `${engine}-${transport}-${paired ? "pair-" : ""}${recordings.size}`;
          recordings.set(id, blob);
          clips.push({ id, engine, transport, bytes: blob.size, mime: blob.type,
            ...(paired ? { stage: "local-remote-pair", channels: ["local-processed", "remote-received"], sampleRate: context.sampleRate, format: "float32-lossless-same-clock" } : {}) });
        }
        recorders.length = 0;
        const liveStatus = processor.pipeline.getStatus();
        const p2pStatus = directPipeline.getStatus();
        const [livekitSenderStats, livekitReceiverStats, p2pSenderStats, p2pReceiverStats] = await Promise.all([
          rtpStats(() => localTrack.sender?.getStats()), rtpStats(() => remote.getReceiverStats?.()),
          rtpStats(() => pair.rtpSender.getStats()), rtpStats(() => pair.receiver.getStats()),
        ]);
        const result = {
          engine, setupMs, gateSensitivity: 100, sourceSampleRate: context.sampleRate,
          publishProfile: productionPublishProfile ? "konusma" : "controlled", publishOptions,
          fixtureUrl: fixtureUrl ?? null, fixtureDurationMs: fixtureBuffer ? fixtureBuffer.duration * 1000 : null,
          recordingDurationMs: count * 50, fixtureTruncated: fixtureBuffer ? count * 50 < fixtureBuffer.duration * 1000 : false,
          captureConstraintsSimulated: true, captureConstraintsLog,
          diagnostics: { ...diagnostics(), livekitSenderStats, livekitReceiverStats, p2pSenderStats, p2pReceiverStats,
            remotePlayout: remoteAudioElements.map((audio) => ({ paused: audio.paused, readyState: audio.readyState, currentTime: audio.currentTime, muted: audio.muted })) },
          livekit: { ...meters[0].result(), sampleRate: liveStatus.sampleRate, activeEngine: liveStatus.activeEngine, phase: liveStatus.phase, error: liveStatus.error,
            senderUsesProcessedTrack: localTrack.sender?.track === processor.processedTrack },
          p2p: { ...meters[1].result(), sampleRate: p2pStatus.sampleRate, activeEngine: p2pStatus.activeEngine, phase: p2pStatus.phase, error: p2pStatus.error,
            senderUsesProcessedTrack: pair.rtpSender.track === directPipeline.processedTrack },
          recordings: clips,
        };
        // Transport can succeed while the production graph explicitly falls
        // back because this browser cannot start AudioWorklet. Keep that
        // evidence separate from the strict selected-engine acceptance result.
        result.transportPassed = [result.livekit, result.p2p].every((path) => path.finite &&
          path.senderUsesProcessedTrack && path.nonzeroFrames >= Math.floor(count / 2));
        result.passed = [result.livekit, result.p2p].every((path) => path.finite && path.senderUsesProcessedTrack &&
          path.sampleRate === 48000 && path.activeEngine === engine && path.phase === "ready" && path.nonzeroFrames >= Math.floor(count / 2));
        return result;
      } catch (error) { return { engine, passed: false, transportPassed: false,
        publishProfile: productionPublishProfile ? "konusma" : "controlled", publishOptions,
        fixtureUrl: fixtureUrl ?? null,
        captureConstraintsSimulated: true, captureConstraintsLog,
        diagnostics: diagnostics(),
        error: error instanceof Error ? error.message : String(error),
        errorName: error?.name, errorConstraint: error?.constraint, errorStack: error?.stack }; }
      finally {
        remoteWait?.cancel();
        for (const rec of recorders) await rec?.stop().catch(() => {});
        remoteAudioElements.forEach((audio) => { audio.pause(); audio.srcObject = null; audio.remove(); });
        meters.forEach((meter) => meter.close());
        pair?.close();
        if (localTrack) await publisher.localParticipant.unpublishTrack(localTrack, false).catch(() => {});
        await processor?.destroy();
        await directPipeline?.dispose();
        localTrack?.stop(); synthetic?.dispose();
        await context.close().catch(() => {});
        running = false;
      }
    },
    listRecordings() { return [...recordings].map(([id, blob]) => ({ id, bytes: blob.size, mime: blob.type })); },
    async recordingBase64(id) {
      const blob = recordings.get(id);
      if (!blob) throw new Error("Recording not found");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      return btoa(binary);
    },
    async close() {
      if (running) throw new Error("Finish the current engine probe before closing");
      closed = true;
      await Promise.all([publisher.disconnect(), subscriber.disconnect()]);
    },
  };
}
