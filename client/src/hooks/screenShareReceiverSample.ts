export type ReceiverStatsBaseline = {
  timestamp: number;
  bytesReceived: number;
  framesDecoded: number;
  framesDropped: number;
  freezeCount: number;
  totalFreezesDuration: number;
  pauseCount: number;
  totalPausesDuration: number;
  jitterBufferDelay: number;
  jitterBufferEmittedCount: number;
  packetsLost: number;
  packetsReceived: number;
  nackCount: number;
  firCount: number;
  pliCount: number;
};

export type ReceiverStatsSnapshot = ReceiverStatsBaseline & {
  frameWidth: number;
  frameHeight: number;
};

/** Copy only cumulative counters; current layer dimensions stay on the sample. */
export function captureReceiverBaseline(
  snap: Readonly<ReceiverStatsSnapshot>,
  now: number,
): ReceiverStatsBaseline {
  return {
    timestamp: now,
    bytesReceived: snap.bytesReceived,
    framesDecoded: snap.framesDecoded,
    framesDropped: snap.framesDropped,
    freezeCount: snap.freezeCount,
    totalFreezesDuration: snap.totalFreezesDuration,
    pauseCount: snap.pauseCount,
    totalPausesDuration: snap.totalPausesDuration,
    jitterBufferDelay: snap.jitterBufferDelay,
    jitterBufferEmittedCount: snap.jitterBufferEmittedCount,
    packetsLost: snap.packetsLost,
    packetsReceived: snap.packetsReceived,
    nackCount: snap.nackCount,
    firCount: snap.firCount,
    pliCount: snap.pliCount,
  };
}

/** Pure deltas preserve counter-reset clamping, rounding and empty denominators. */
export function calculateReceiverDeltas(
  snap: Readonly<ReceiverStatsSnapshot>,
  prev: Readonly<ReceiverStatsBaseline>,
) {
  const dBytes = Math.max(0, snap.bytesReceived - prev.bytesReceived);
  const dDecoded = Math.max(0, snap.framesDecoded - prev.framesDecoded);
  const dDropped = Math.max(0, snap.framesDropped - prev.framesDropped);
  const dFreezeCount = Math.max(0, snap.freezeCount - prev.freezeCount);
  const dFreezeMs = Math.max(
    0,
    (snap.totalFreezesDuration - prev.totalFreezesDuration) * 1000,
  );
  const dPauseCount = Math.max(0, snap.pauseCount - prev.pauseCount);
  const dPauseMs = Math.max(
    0,
    (snap.totalPausesDuration - prev.totalPausesDuration) * 1000,
  );
  // jitterBufferDelay is cumulative seconds across all emitted frames.
  // The delta over delta-emitted frames gives the per-frame mean delay
  // during this window — that's the number that drives "feels laggy".
  const dJitterSec = Math.max(0, snap.jitterBufferDelay - prev.jitterBufferDelay);
  const dEmitted = Math.max(
    0,
    snap.jitterBufferEmittedCount - prev.jitterBufferEmittedCount,
  );
  const jitterBufferDelayMs = dEmitted > 0 ? Math.round((dJitterSec / dEmitted) * 1000) : 0;
  const dLost = Math.max(0, snap.packetsLost - prev.packetsLost);
  const dRecv = Math.max(0, snap.packetsReceived - prev.packetsReceived);
  const lossDenom = dLost + dRecv;
  const packetLossPct = lossDenom > 0 ? Math.round((dLost / lossDenom) * 1000) / 10 : 0;
  const dNack = Math.max(0, snap.nackCount - prev.nackCount);
  const dFir = Math.max(0, snap.firCount - prev.firCount);
  const dPli = Math.max(0, snap.pliCount - prev.pliCount);

  return { dBytes, dDecoded, dDropped, dFreezeCount, dFreezeMs, dPauseCount, dPauseMs, jitterBufferDelayMs, packetLossPct, dNack, dFir, dPli };
}
