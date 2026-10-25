// This development-only entry has its own JS realm. Never import it into the
// human app or put a bot token into apiClient/authStore: hb_ is not a human JWT.
import { publishAuthGenerationChange, publishAuthOwnerChange } from "../api/authSessionEvents";
import * as storage from "../crypto/keyStorage";
import * as signal from "../crypto/signalProtocol";
import { encodePayload, decodePayload } from "../crypto/e2eePayload";
import { PREKEY_BATCH_SIZE, type SignalWireMessage } from "../crypto/types";
import type { DMMessage, PreKeyBundleResponse } from "../types";

type Envelope = { sender_device_id: string; recipient_device_id: string; message_type: number; ciphertext: string };

export class GameTestClient {
  private token = "";
  private owner = "";
  private device = "";
  private generation = 0;
  private channels = new Map<string, string>();
  private received = new Set<string>();

  private async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    if (!this.token || !path.startsWith("/") || path.startsWith("//")) throw new Error("not_connected");
    const own = this.generation;
    const response = await fetch(`/api${path}`, {
      method, credentials: "omit", signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json() as { success?: boolean; code?: string; data?: T };
    if (own !== this.generation) throw new Error("session_changed");
    if (!response.ok || result.success !== true || result.data === undefined) throw new Error(`http_${response.status}:${result.code ?? "request_failed"}`);
    return result.data;
  }

  disconnect() {
    this.generation++;
    this.token = ""; this.owner = ""; this.device = "";
    this.channels.clear(); this.received.clear();
    publishAuthOwnerChange(null); publishAuthGenerationChange(this.generation);
  }

  async connect(token: string) {
    this.disconnect();
    if (!/^hb_[A-Za-z0-9_-]{16,256}$/.test(token)) throw new Error("bot_token_required");
    this.token = token;
    const own = this.generation;
    const me = await this.request<{ id: string; username: string; is_bot: boolean }>("/users/me");
    if (!me.is_bot || !me.id) { this.disconnect(); throw new Error("bot_identity_required"); }
    this.owner = me.id;
    publishAuthOwnerChange(me.id); publishAuthGenerationChange(own);
    const current = () => this.generation === own && this.owner === me.id;
    const registered = await storage.getRegistrationData();
    if (!current()) throw new Error("session_changed");
    if (registered) {
      if (registered.userId !== me.id || !await storage.getIdentityKeyPair()) throw new Error("stored_device_identity_mismatch");
      const devices = await this.request<Array<{ device_id: string }>>("/devices");
      if (!devices.some(device => device.device_id === registered.deviceId)) throw new Error("stored_device_not_registered_keys_preserved");
      this.device = registered.deviceId;
    } else {
      // Do not silently overwrite partial/recoverable identity material.
      if (await storage.getIdentityKeyPair()) throw new Error("partial_device_keys_preserved");
      const deviceID = crypto.randomUUID();
      const keys = await signal.generateAllKeys(current);
      const saved = await this.request<{ device_id: string }>("/devices", "POST", {
        device_id: deviceID, display_name: "HiChat local game test client",
        identity_key: keys.identityPublicKey, signing_key: keys.signingPublicKey,
        signed_prekey: keys.signedPreKey.publicKey, signed_prekey_id: keys.signedPreKey.id,
        signed_prekey_signature: keys.signedPreKey.signature, registration_id: keys.registrationId,
        one_time_prekeys: keys.oneTimePreKeys.map(key => ({ prekey_id: key.id, public_key: key.publicKey })),
      });
      if (saved.device_id !== deviceID || !current()) throw new Error("device_registration_mismatch");
      await storage.setMetadata("deviceId", deviceID);
      await storage.saveRegistrationData({ userId: me.id, deviceId: deviceID, registrationId: keys.registrationId, createdAt: Date.now() });
      await storage.setMetadata("nextPrekeyId", PREKEY_BATCH_SIZE + 1);
      this.device = deviceID;
    }
    if (!current()) throw new Error("session_changed");
    return { id: this.owner, username: me.username, device: this.device };
  }

  private async channel(recipient: string) {
    if (!recipient || recipient === this.owner) throw new Error("human_recipient_required");
    const known = this.channels.get(recipient);
    if (known) return known;
    const result = await this.request<{ id: string }>("/dms", "POST", { user_id: recipient });
    if (!result.id) throw new Error("channel_missing");
    this.channels.set(recipient, result.id);
    return result.id;
  }

  async send(recipient: string, content: string) {
    if (!this.device || !content.trim() || content.length > 2000) throw new Error("message_required");
    const own = this.generation;
    const current = () => this.generation === own && !!this.owner;
    const channelID = await this.channel(recipient);
    const devices = await this.request<Array<{ device_id: string }>>(`/users/${encodeURIComponent(recipient)}/devices`);
    if (!devices.length) throw new Error("recipient_has_no_keys_no_plaintext_fallback");
    const envelopes: Envelope[] = [];
    let bundles: PreKeyBundleResponse[] | undefined;
    for (const device of devices) {
      if (!await signal.hasSessionFor(recipient, device.device_id)) {
        bundles ??= await this.request<PreKeyBundleResponse[]>(`/users/${encodeURIComponent(recipient)}/prekey-bundles`);
        const bundle = bundles.find(item => item.device_id === device.device_id);
        if (!bundle?.signing_key) throw new Error("recipient_signed_keys_missing");
        await signal.processPreKeyBundle(recipient, device.device_id, {
          identityKey: bundle.identity_key, signingKey: bundle.signing_key,
          signedPrekeyId: bundle.signed_prekey_id, signedPrekey: bundle.signed_prekey,
          signedPrekeySignature: bundle.signed_prekey_signature,
          oneTimePrekeyId: bundle.one_time_prekey_id ?? undefined, oneTimePrekey: bundle.one_time_prekey ?? undefined,
          registrationId: bundle.registration_id,
        }, current);
      }
      const wire = await signal.encryptMessage(recipient, device.device_id, encodePayload(content), current);
      envelopes.push({ sender_device_id: this.device, recipient_device_id: device.device_id, message_type: wire.type, ciphertext: JSON.stringify(wire) });
    }
    const ciphertext = JSON.stringify(envelopes);
    const message = await this.request<DMMessage>(`/dms/${encodeURIComponent(channelID)}/messages`, "POST", { encryption_version: 1, ciphertext, sender_device_id: this.device });
    if (message.dm_channel_id !== channelID || message.encryption_version !== 1 || message.user_id !== this.owner || message.application_id !== this.owner || message.content || message.ciphertext !== ciphertext) throw new Error("server_ciphertext_or_origin_mismatch");
    return { id: message.id, channel: channelID, application: message.application_id, encryption: message.encryption_version };
  }

  async poll(recipient: string) {
    if (!this.device) throw new Error("not_connected");
    const own = this.generation;
    const current = () => this.generation === own && !!this.owner;
    const channelID = await this.channel(recipient);
    const page = await this.request<{ messages: DMMessage[] }>(`/dms/${encodeURIComponent(channelID)}/messages?limit=100`);
    const output: Array<{ id: string; content: string }> = [];
    for (const message of page.messages) {
      if (message.user_id === this.owner || this.received.has(message.id)) continue;
      if (message.dm_channel_id !== channelID || message.user_id !== recipient || message.encryption_version !== 1 || !message.ciphertext) throw new Error("encrypted_peer_message_required");
      const envelopes = JSON.parse(message.ciphertext) as Envelope[];
      const addressed = envelopes.find(item => item.recipient_device_id === this.device);
      if (!addressed) throw new Error("message_not_addressed_to_bot_device");
      const plain = await signal.decryptMessage(recipient, addressed.sender_device_id, JSON.parse(addressed.ciphertext) as SignalWireMessage, current);
      output.push({ id: message.id, content: decodePayload(plain).content });
      this.received.add(message.id);
    }
    return output;
  }
}
