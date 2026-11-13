import { fromBase64, toBase64 } from "./signalProtocol";
import type { SessionState } from "./types";

export class InvalidBackupSessionError extends Error {
  constructor() { super("Invalid backup session"); this.name = "InvalidBackupSessionError"; }
}

function transform(value: unknown, decode: boolean, depth = 0): unknown {
  if (depth > 256) throw new InvalidBackupSessionError();
  if (!decode && value instanceof Uint8Array) return { __b64: toBase64(value) };
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(child => transform(child, decode, depth + 1));
  if (decode && "__b64" in value) {
    if (typeof value.__b64 !== "string") throw new InvalidBackupSessionError();
    return fromBase64(value.__b64);
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, transform(child, decode, depth + 1)]));
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidBackupSessionError();
  return value as Record<string, unknown>;
}
function key(value: unknown): boolean { return value instanceof Uint8Array && value.length === 32; }
function counter(value: unknown): boolean { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }

/** Preserve the established recursive {__b64:string} representation. */
export function serializeBackupSessionState(state: SessionState): unknown {
  return transform(state, false);
}

/** Decode and validate a ratchet state without touching account storage. */
export function decodeBackupSessionState(json: string): SessionState {
  try {
    const state = record(transform(JSON.parse(json), true));
    const pair = record(state.sendingRatchetKeyPair);
    if (!key(state.rootKey) || !key(pair.publicKey) || !key(pair.privateKey)
      || ![state.sendingChainKey, state.receivingChainKey, state.receivingRatchetKey].every(value => value === null || key(value))
      || ![state.sendMessageNumber, state.receiveMessageNumber, state.previousSendChainLength].every(counter)
      || !Array.isArray(state.skippedMessageKeys)) throw new InvalidBackupSessionError();
    for (const entry of state.skippedMessageKeys) {
      const skipped = record(entry);
      if (typeof skipped.ratchetKey !== "string" || fromBase64(skipped.ratchetKey).length !== 32
        || !counter(skipped.messageNumber) || !key(skipped.messageKey)) throw new InvalidBackupSessionError();
    }
    return state as SessionState;
  } catch { throw new InvalidBackupSessionError(); }
}
