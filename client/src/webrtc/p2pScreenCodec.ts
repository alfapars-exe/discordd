import { getP2PMediaController } from "./p2pMediaController";

type ScreenCodec = "vp9" | "h264";

/** Reorder supported codecs without stripping RTX, RED, FEC or fallbacks. */
export function preferScreenCodec(codecs: RTCRtpCodec[], codec: ScreenCodec, sendCodecs = codecs): RTCRtpCodec[] | null {
  const mime = `video/${codec}`;
  const fmtp = (value: RTCRtpCodec) => (value.sdpFmtpLine ?? "").toLowerCase().split(";").map(part => part.trim()).sort().join(";");
  const preferred = codecs.filter(value => value.mimeType.toLowerCase() === mime && sendCodecs.some(candidate =>
    candidate.mimeType.toLowerCase() === mime && candidate.clockRate === value.clockRate && fmtp(candidate) === fmtp(value)));
  return preferred.length ? [...preferred, ...codecs.filter(value => !preferred.includes(value))] : null;
}

/** The peer's existing controller remains the sole owner of SDP/signaling. */
export class P2PScreenCodecPolicy {
  private preferences: RTCRtpCodec[] = [];
  // This records acknowledged preference order, not a hardware encoder claim.
  private confirmedPreference: ScreenCodec | null = null;
  private pc: RTCPeerConnection;
  private sender: RTCRtpSender;
  constructor(pc: RTCPeerConnection, sender: RTCRtpSender) { this.pc = pc; this.sender = sender; }

  private target() {
    return this.pc.getTransceivers?.().find(value => value.sender === this.sender);
  }

  async apply(codec: ScreenCodec, required: boolean, current: () => boolean): Promise<boolean> {
    if (!current()) return false;
    if (this.confirmedPreference === codec) return true;
    const transceiver = this.target(), controller = getP2PMediaController(this.pc);
    const capabilities = typeof RTCRtpReceiver !== "undefined" ? RTCRtpReceiver.getCapabilities?.("video") : null;
    const sendCapabilities = typeof RTCRtpSender !== "undefined" ? RTCRtpSender.getCapabilities?.("video") : null;
    const next = preferScreenCodec(capabilities?.codecs ?? [], codec, sendCapabilities?.codecs ?? []);
    if (!next || !transceiver?.setCodecPreferences || !controller) {
      if (required) throw new DOMException("Low-latency H264 codec selection is unavailable", "NotSupportedError");
      return true;
    }
    const previous = this.preferences, previousConfirmed = this.confirmedPreference;
    try {
      const accepted = await controller.negotiateMutation(() => {
        transceiver.setCodecPreferences(next);
        this.preferences = next;
        this.confirmedPreference = null;
      }, current);
      if (!current()) return false;
      if (!accepted) throw new DOMException("Screen codec negotiation did not complete", "OperationError");
      if (required) await this.verifyReportedCodec(codec, current);
      if (!current()) return false;
      this.confirmedPreference = codec;
      return true;
    } catch (error) {
      if (current()) {
        // Restore the previous working preference. The controller defers the
        // retry behind any outstanding offer instead of creating SDP glare.
        await controller.negotiateMutation(() => {
          transceiver.setCodecPreferences(previous);
          this.preferences = previous;
          this.confirmedPreference = null;
        }, current).then(accepted => { if (accepted && current()) this.confirmedPreference = previousConfirmed; }).catch(() => {});
      }
      throw error;
    }
  }

  private async verifyReportedCodec(codec: ScreenCodec, current: () => boolean) {
    const wanted = `video/${codec}`;
    const repair = /^video\/(rtx|red|ulpfec|flexfec(?:-03)?)$/i;
    const negotiated = this.sender.getParameters().codecs?.filter(value => value.mimeType.toLowerCase().startsWith("video/") && !repair.test(value.mimeType)) ?? [];
    if (negotiated.length && !negotiated.some(value => value.mimeType.toLowerCase() === wanted)) {
      throw new DOMException("Peer did not negotiate the requested screen codec", "NotSupportedError");
    }
    if (!this.sender.getStats) return;
    const deadline = Date.now() + 750;
    type Sample = { mime: string; id: string; frames: number; timestamp: number };
    let previous: Sample | undefined;
    // A live sender can briefly report its previous codec immediately after the
    // answer. Only advancing frame counters prove current traffic; a disabled
    // capture or stale camera report must remain unknown, not reject the share.
    while (current()) {
      let sample: Sample | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const reports = await Promise.race([this.sender.getStats(), new Promise<null>(resolve => {
          timer = setTimeout(() => resolve(null), Math.max(1, deadline - Date.now()));
        })]);
        if (!reports) return;
        const samples: Sample[] = [];
        reports.forEach(report => {
          if (report.type !== "outbound-rtp" || report.isRemote || report.active === false || (report.kind ?? report.mediaType) !== "video" || !report.codecId) return;
          const value = reports.get(report.codecId)?.mimeType as string | undefined;
          const frames = report.framesEncoded ?? report.framesSent;
          if (value && !repair.test(value) && typeof frames === "number" && typeof report.timestamp === "number") {
            samples.push({ mime: value.toLowerCase(), id: report.id, frames, timestamp: report.timestamp });
          }
        });
        sample = samples[0];
      } catch { return; } finally { clearTimeout(timer); }
      if (!current() || !sample || sample.mime === wanted) return;
      if (previous && (sample.id !== previous.id || sample.frames <= previous.frames || sample.timestamp <= previous.timestamp)) return;
      if (previous && Date.now() >= deadline) throw new DOMException("Peer is sending a fallback screen codec", "NotSupportedError");
      previous = sample;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }

  async restore(current: () => boolean): Promise<boolean> {
    if (!this.preferences.length || !current()) return current();
    const transceiver = this.target(), controller = getP2PMediaController(this.pc);
    if (!transceiver?.setCodecPreferences || !controller) return current();
    return controller.negotiateMutation(() => {
      transceiver.setCodecPreferences([]);
      this.preferences = [];
      this.confirmedPreference = null;
    }, current);
  }
}
