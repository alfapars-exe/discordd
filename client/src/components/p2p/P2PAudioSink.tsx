/**
 * P2PAudioSink — hidden <audio> element that plays the remote P2P stream.
 *
 * Rendered above the tab/panel tree (see AppLayout) so a call's audio keeps
 * playing when the user switches to another chat tab. If this lived inside
 * P2PCallScreen — as it used to — swapping tabs unmounted the component
 * along with its <audio>, and the remote audio cut out until the caller
 * navigated back. Video is still handled inside P2PCallScreen because there
 * is nothing to see when the panel is off-screen.
 *
 * The srcObject assignment mirrors P2PCallScreen's old effect: React can't
 * pass a MediaStream through a prop diff, so we imperatively poke it onto
 * the element ref whenever the store's remoteStream identity changes.
 */

import { useEffect, useRef } from "react";
import { useP2PCallStore } from "../../stores/p2pCallStore";

function P2PAudioSink() {
  const remoteStream = useP2PCallStore((s) => s.remoteStream);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.srcObject = remoteStream ?? null;
    }
  }, [remoteStream]);

  return <audio ref={audioRef} autoPlay playsInline />;
}

export default P2PAudioSink;
