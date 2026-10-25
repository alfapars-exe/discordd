/** Retained for compatibility; never offered by the user-facing engine selector. */
export async function createLegacyKrispProcessor() {
  const { KrispNoiseFilter, isKrispNoiseFilterSupported } = await import("@livekit/krisp-noise-filter");
  if (!isKrispNoiseFilterSupported()) throw new Error("Legacy filter unsupported");
  return KrispNoiseFilter();
}
