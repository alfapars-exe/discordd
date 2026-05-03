/**
 * useE2EEKeyProvider — manage the LiveKit SFrame end-to-end encryption
 * key provider and its background worker as the passphrase changes.
 *
 * What this owns:
 *
 *   1. ExternalE2EEKeyProvider singleton — derives a CryptoKey from the
 *      server-issued passphrase via PBKDF2. Stable across the session;
 *      passphrase changes call `setKey()` to rotate the derived key
 *      without re-instantiating.
 *
 *   2. SFrame worker — runs the encryption/decryption off the main thread.
 *      Created when a passphrase exists, terminated when it disappears (or
 *      on unmount). The dependency uses `!!e2eePassphrase` so a passphrase
 *      *change* (one non-empty value to another) reuses the same worker —
 *      we only spin up a new worker when toggling between "encrypted" and
 *      "not encrypted" states.
 *
 *   3. Key derivation — calls `setKey(passphrase)` whenever the passphrase
 *      value changes. Errors surface as a toast via the provided callback.
 *
 * The hook returns both pieces so the caller can attach them to LiveKit's
 * RoomOptions.e2ee config:
 *
 *     const { keyProvider, e2eeWorker } = useE2EEKeyProvider(passphrase, ...);
 *     options.e2ee = { keyProvider, worker: e2eeWorker };
 *
 * Was previously ~30 lines inline in VoiceProvider.tsx.
 */

import { useEffect, useMemo } from "react";
import { ExternalE2EEKeyProvider } from "livekit-client";

type Options = {
  /** Called with the SFrame error message when key derivation fails. */
  onError: (err: unknown) => void;
};

export function useE2EEKeyProvider(
  e2eePassphrase: string | null | undefined,
  { onError }: Options,
): {
  keyProvider: ExternalE2EEKeyProvider;
  e2eeWorker: Worker | null;
} {
  // Stable singleton across the whole session — passphrase rotations call
  // setKey() rather than instantiating a new provider.
  const keyProvider = useMemo(() => new ExternalE2EEKeyProvider(), []);

  // Worker lifecycle is bound to "is encryption on?" not "what passphrase?".
  // Re-keying reuses the existing worker; only on/off transitions create or
  // tear down the thread.
  const e2eeWorker = useMemo(() => {
    if (e2eePassphrase) {
      return new Worker(
        new URL("livekit-client/e2ee-worker", import.meta.url),
      );
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!e2eePassphrase]);

  useEffect(() => {
    return () => {
      e2eeWorker?.terminate();
    };
  }, [e2eeWorker]);

  // Derive and install the CryptoKey when the passphrase value changes.
  useEffect(() => {
    if (!e2eePassphrase) return;
    keyProvider.setKey(e2eePassphrase).catch(onError);
  }, [e2eePassphrase, keyProvider, onError]);

  return { keyProvider, e2eeWorker };
}
