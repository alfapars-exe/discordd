import { ExternalE2EEKeyProvider, createKeyMaterialFromString } from "livekit-client";

/** Explicit authoritative epoch and SFrame's 8-bit slot; never infer missed rotations. */
export function isMediaKeyVersion(index: unknown, epoch: unknown): index is number {
  return typeof index === "number" && Number.isInteger(index) && index >= 0 && index <= 255
    && typeof epoch === "number" && Number.isSafeInteger(epoch) && epoch >= 0 && index === epoch % 256;
}

/** Ownership fence only; LiveKit still validates the JWT signature/grants. */
export function mediaTokenSubject(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))) as { sub?: unknown };
    return typeof payload.sub === "string" && payload.sub ? payload.sub : null;
  } catch { return null; }
}

export class IndexedVoiceKeyProvider extends ExternalE2EEKeyProvider {
  private requestedEpoch = -1;
  private requestedPassphrase = "";
  private installedEpoch = -1;
  private installedPassphrase = "";
  readonly scope: string;
  constructor(scope = "") { super({ keyringSize: 256 }); this.scope = scope; }
  async setIndexedKey(passphrase: string, index: number, epoch: number, current: () => boolean): Promise<boolean> {
    if (!passphrase || !isMediaKeyVersion(index, epoch) || epoch < this.requestedEpoch) throw new Error("Invalid media key version");
    if ((epoch === this.requestedEpoch && passphrase !== this.requestedPassphrase) || (epoch === this.installedEpoch && passphrase !== this.installedPassphrase)) throw new Error("Conflicting media key epoch");
    this.requestedEpoch = epoch;
    this.requestedPassphrase = passphrase;
    const material = await createKeyMaterialFromString(passphrase);
    if (!current() || epoch !== this.requestedEpoch) return false;
    this.onSetEncryptionKey(material, undefined, index);
    this.installedEpoch = epoch;
    this.installedPassphrase = passphrase;
    return true;
  }
}
