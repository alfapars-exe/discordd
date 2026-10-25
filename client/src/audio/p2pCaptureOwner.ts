import type{P2PCall}from "../types/p2p";
/** Ringing is signaling only. Production P2P media starts after acceptance
 * changes status to active, before either side starts local preparation. */
export function ownsP2PCapture(call:Pick<P2PCall,"status">|null|undefined):boolean{return call?.status==="active";}
