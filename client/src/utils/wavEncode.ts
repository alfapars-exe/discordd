/**
 * wavEncode — 16-bit PCM WAV encoding helpers.
 *
 * `audioBufferToWav` was moved here unchanged from SoundUploadForm (soundboard
 * video → audio extraction) so the entrance-sound uploader can share it.
 * `renderClipToWav` decodes any browser-supported audio/video file, renders
 * the trimmed range down to mono 24 kHz and encodes it — the server then
 * parses and re-writes the WAV itself (Faz E, Karar E-4), so nothing here is
 * a security boundary.
 */

/** Target sample rate for entrance clips (5 s mono ≈ 240 KB). */
export const ENTRANCE_SAMPLE_RATE = 24000;

/** Minimal AudioBuffer surface used by the encoder (lets tests pass a fake). */
export type PcmSource = Pick<AudioBuffer, "numberOfChannels" | "sampleRate" | "length" | "getChannelData">;

export function audioBufferToWav(buffer: PcmSource): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1; // PCM
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataLength = buffer.length * blockAlign;
  const headerLength = 44;
  const arrayBuffer = new ArrayBuffer(headerLength + dataLength);
  const view = new DataView(arrayBuffer);

  function writeString(offset: number, str: string) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(36, "data");
  view.setUint32(40, dataLength, true);

  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) channels.push(buffer.getChannelData(ch));

  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channels[ch][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([arrayBuffer], { type: "audio/wav" });
}

/** Decodes a file with a throwaway AudioContext (closed afterwards). */
export async function decodeAudioFile(file: Blob): Promise<AudioBuffer> {
  const data = await file.arrayBuffer();
  const ctx = new AudioContext();
  try {
    return await ctx.decodeAudioData(data);
  } finally {
    ctx.close().catch(() => {});
  }
}

/**
 * Renders [startMs, endMs) of `file` to a mono 24 kHz 16-bit PCM WAV.
 * Throws if the file can't be decoded or the range is empty.
 */
export async function renderClipToWav(file: Blob, startMs: number, endMs: number): Promise<Blob> {
  const decoded = await decodeAudioFile(file);
  const totalMs = (decoded.length / decoded.sampleRate) * 1000;
  const start = Math.max(0, Math.min(startMs, totalMs));
  const end = Math.max(start, Math.min(endMs, totalMs));
  const frames = Math.round(((end - start) / 1000) * ENTRANCE_SAMPLE_RATE);
  if (frames <= 0) throw new Error("empty range");

  const offline = new OfflineAudioContext(1, frames, ENTRANCE_SAMPLE_RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  // Mono down-mix happens on connect (speakers interpretation, 1 channel).
  src.connect(offline.destination);
  src.start(0, start / 1000, (end - start) / 1000);
  const rendered = await offline.startRendering();
  return audioBufferToWav(rendered);
}
