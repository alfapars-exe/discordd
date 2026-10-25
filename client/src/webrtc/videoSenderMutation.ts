/** Serialize every P2P video mutation on its actual sender, across camera and screen owners. */
const tails = new WeakMap<RTCRtpSender, Promise<void>>();
export function mutateOwnedVideoSender(sender: RTCRtpSender, isCurrent: () => boolean, mutation: () => Promise<void>): Promise<boolean> {
  const previous = tails.get(sender) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    if (!isCurrent()) return false;
    await mutation();
    return isCurrent();
  });
  const tail = operation.then(() => {}, () => {}); tails.set(sender, tail);
  void tail.then(() => { if (tails.get(sender) === tail) tails.delete(sender); });
  return operation;
}
export async function replaceOwnedVideoTrack(sender: RTCRtpSender, track: MediaStreamTrack | null, isCurrent: () => boolean): Promise<boolean> {
  const replaced = await mutateOwnedVideoSender(sender, isCurrent, () => sender.replaceTrack(track));
  return replaced && sender.track === track;
}
