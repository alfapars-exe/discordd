/**
 * codecSupport — RTCRtpSender capability probes for video codecs.
 *
 * Why here and not inline in the screen-share hook: capability probing
 * has to be sync-friendly (called during useMemo), null-safe on jsdom
 * where RTCRtpSender.getCapabilities doesn't exist, and testable
 * without mounting the hook. Extracting it lets the UI toggle for AV1
 * opt-in stay grey-out-when-unsupported without every component
 * duplicating the browser-feature-detect dance.
 *
 * AV1 rollout notes:
 *   - Chrome 116+ / Edge 116+ ship the AV1 encoder for WebRTC send.
 *   - Firefox ships DECODE only; sending AV1 is behind media.av1 flag.
 *   - Safari: no AV1 send today (2026).
 *   - So a positive canSendAV1() is a strong signal — the negative can
 *     mean either "browser doesn't support" or "wrong browser", both
 *     handled the same way (hide the toggle / fall back to VP9).
 */

/**
 * Normalizes a MIME-type-with-parameters string to a lowercase codec
 * name suffix. "video/AV1", "video/AV1; profile=1" → "av1".
 */
function codecKeyOf(mimeType: string): string {
  const slash = mimeType.indexOf("/");
  if (slash < 0) return mimeType.toLowerCase();
  const afterSlash = mimeType.slice(slash + 1);
  const semi = afterSlash.indexOf(";");
  const base = semi < 0 ? afterSlash : afterSlash.slice(0, semi);
  return base.trim().toLowerCase();
}

/**
 * Returns true iff RTCRtpSender exposes any codec whose MIME type ends
 * in "/<want>" (case-insensitive). Any exception (no RTCRtpSender, no
 * getCapabilities, unrelated throw) resolves to false — a "can we send
 * X?" question must never crash the caller.
 */
function senderSupports(want: string): boolean {
  try {
    if (typeof RTCRtpSender === "undefined") return false;
    const caps = RTCRtpSender.getCapabilities?.("video");
    if (!caps) return false;
    const target = want.toLowerCase();
    return caps.codecs.some((c) => codecKeyOf(c.mimeType) === target);
  } catch {
    return false;
  }
}

export function canSendAV1(): boolean {
  return senderSupports("av1");
}

export function canSendVP9(): boolean {
  return senderSupports("vp9");
}

export function canSendH264(): boolean {
  return senderSupports("h264");
}

/**
 * Returns the strongest codec available for screen-share, in the order
 * we'd prefer if the user hasn't picked anything: VP9 wins by default
 * (best quality/bitrate ratio for text-heavy content), H264 falls back
 * if VP9 isn't sendable, and undefined means "let LiveKit pick" — which
 * happens only on ancient browsers that would fail earlier anyway.
 *
 * AV1 is deliberately NOT auto-preferred: it's still expensive to
 * encode on the CPU path and users should opt in from settings when
 * they have a modern GPU + a screen with heavy text content.
 */
export function preferredScreenShareCodec(): "vp9" | "h264" | undefined {
  if (canSendVP9()) return "vp9";
  if (canSendH264()) return "h264";
  return undefined;
}
