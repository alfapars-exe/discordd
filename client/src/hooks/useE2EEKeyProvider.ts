import { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import { isE2EESupported } from "livekit-client";
import { getAuthSessionSnapshot, subscribeAuthGenerationChanges, subscribeAuthOwnerChanges } from "../api/authSessionEvents";
import { IndexedVoiceKeyProvider, isMediaKeyVersion } from "../audio/voiceEncryptionKeys";

const subscribeSession = (changed: () => void) => {
  const owner = subscribeAuthOwnerChanges(changed), generation = subscribeAuthGenerationChanges(changed);
  return () => { owner(); generation(); };
};
const sessionSnapshot = () => JSON.stringify(getAuthSessionSnapshot());
type Options = { onError: (error: unknown) => void; enabled?: boolean; scope?: string; keyIndex?: number | null; keyEpoch?: number | null; keyContext?: string | null };

/** Current SDK key material must be installed before room admission. Worker
 * derivation can still be pending; enabled GCM fails closed without a key. */
export function useE2EEKeyProvider(passphrase: string | null | undefined, options: Options) {
  const { onError, enabled = Boolean(passphrase), scope = "", keyIndex, keyEpoch, keyContext } = options;
  const scopedRoom = JSON.stringify([scope, keyContext]);
  const authScope = useSyncExternalStore(subscribeSession, sessionSnapshot, sessionSnapshot);
  const keyProvider = useMemo(() => new IndexedVoiceKeyProvider(JSON.stringify([authScope, scopedRoom])), [authScope, scopedRoom]);
  const [workerState, setWorkerState] = useState<{ provider: IndexedVoiceKeyProvider; worker: Worker | null; error: unknown } | null>(null);
  useLayoutEffect(() => {
    if (!enabled) return;
    let active = true;
    let worker: Worker | null = null;
    let error: unknown = null;
    try {
      if (!isE2EESupported()) throw new Error("Encrypted media is unsupported");
      worker = new Worker(new URL("livekit-client/e2ee-worker", import.meta.url));
    } catch (failure) { error = failure; }
    const next = { provider: keyProvider, worker, error };
    queueMicrotask(() => { if (active) setWorkerState(next); });
    return () => { active = false; worker?.terminate(); };
  }, [enabled, keyProvider]);
  const currentWorker = enabled && workerState?.provider === keyProvider ? workerState : null;
  const fingerprint = JSON.stringify([authScope, scopedRoom, passphrase, keyIndex, keyEpoch]);
  const [state, setState] = useState<{ fingerprint: string; ready: boolean; error: unknown; worker: Worker | null } | null>(null);
  useEffect(() => {
    if (!enabled || !currentWorker) return;
    let active = true;
    const current = () => active && sessionSnapshot() === authScope;
    const fail = (error: unknown) => {
      if (!current()) return;
      setState({ fingerprint, ready: false, error, worker: currentWorker.worker }); onError(error);
    };
    if (currentWorker.error || !currentWorker.worker || !getAuthSessionSnapshot().ownerId || !passphrase || !keyContext || !isMediaKeyVersion(keyIndex, keyEpoch)) {
      fail(currentWorker.error ?? new Error("Encrypted media key contract is unavailable"));
      return () => { active = false; };
    }
    void keyProvider.setIndexedKey(passphrase, keyIndex, keyEpoch as number, current).then((installed) => {
      if (installed && current()) setState({ fingerprint, ready: true, error: null, worker: currentWorker.worker });
    }).catch(fail);
    return () => { active = false; };
  }, [enabled, fingerprint, authScope, passphrase, keyIndex, keyEpoch, keyContext, keyProvider, currentWorker, onError]);
  return { keyProvider, e2eeWorker: currentWorker?.worker ?? null, keyReady: enabled && state?.fingerprint === fingerprint && state.worker === currentWorker?.worker && state.ready,
    keyError: state?.fingerprint === fingerprint && state.worker === currentWorker?.worker ? state.error : null, keyScope: fingerprint, ownerScope: JSON.stringify([authScope, scopedRoom]) };
}
