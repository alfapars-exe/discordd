/**
 * E2EE API — Device management, PreKey Bundles, Key Backup, and Group Sessions.
 */

import { apiClient } from "./client";
import type {
  DeviceInfo,
  DevicePublicInfo,
  PreKeyBundleResponse,
  KeyBackupResponse,
  ChannelGroupSessionResponse,
  SenderKeyRecipient,
} from "../types";

// ──────────────────────────────────
// Device Management
// ──────────────────────────────────

/** Register new device and upload prekey bundle. POST /api/devices */
export function registerDevice(req: {
  device_id: string;
  display_name: string;
  identity_key: string;
  signing_key: string;
  signed_prekey: string;
  signed_prekey_id: number;
  signed_prekey_signature: string;
  registration_id: number;
  one_time_prekeys: Array<{ prekey_id: number; public_key: string }>;
}) {
  return apiClient<{ device_id: string }>("/devices", {
    method: "POST",
    body: req,
  });
}

/** List own devices. GET /api/devices */
export function listMyDevices() {
  return apiClient<DeviceInfo[]>("/devices");
}

/** Delete a device. DELETE /api/devices/{deviceId} */
export function removeDevice(deviceId: string) {
  return apiClient<null>(`/devices/${deviceId}`, {
    method: "DELETE",
  });
}

/** Upload additional one-time prekeys. POST /api/devices/{deviceId}/prekeys */
export function uploadPrekeys(
  deviceId: string,
  req: {
    one_time_prekeys: Array<{ prekey_id: number; public_key: string }>;
  }
) {
  return apiClient<null>(`/devices/${deviceId}/prekeys`, {
    method: "POST",
    body: req,
  });
}

/** Rotate signed prekey. PUT /api/devices/{deviceId}/signed-prekey */
export function updateSignedPrekey(
  deviceId: string,
  req: {
    signed_prekey: string;
    signed_prekey_id: number;
    signed_prekey_signature: string;
  }
) {
  return apiClient<null>(`/devices/${deviceId}/signed-prekey`, {
    method: "PUT",
    body: req,
  });
}

/** Get remaining prekey count. GET /api/devices/{deviceId}/prekey-count */
export function getPrekeyCount(deviceId: string) {
  return apiClient<{ count: number }>(`/devices/${deviceId}/prekey-count`);
}

// ──────────────────────────────────
// User Devices (Public)
// ──────────────────────────────────

/** Get a user's public device list. GET /api/users/{userId}/devices */
export function listUserDevices(userId: string) {
  return apiClient<DevicePublicInfo[]>(`/users/${userId}/devices`);
}

/** Fetch prekey bundles for all of a user's devices (for X3DH). GET /api/users/{userId}/prekey-bundles */
export function fetchPreKeyBundles(userId: string) {
  return apiClient<PreKeyBundleResponse[]>(`/users/${userId}/prekey-bundles`);
}

// ──────────────────────────────────
// Key Backup
// ──────────────────────────────────

/** Upload/update encrypted key backup. PUT /api/e2ee/key-backup */
export function uploadKeyBackup(req: {
  version: number;
  algorithm: string;
  encrypted_data: string;
  nonce: string;
  salt: string;
}) {
  return apiClient<null>("/e2ee/key-backup", {
    method: "PUT",
    body: req,
  });
}

/** Download encrypted key backup. Returns null data if no backup exists (not 404). */
export function downloadKeyBackup() {
  return apiClient<KeyBackupResponse | null>("/e2ee/key-backup");
}

/** Delete key backup. DELETE /api/e2ee/key-backup */
export function deleteKeyBackup() {
  return apiClient<null>("/e2ee/key-backup", {
    method: "DELETE",
  });
}

// ──────────────────────────────────
// Group Sessions (Server-scoped)
// ──────────────────────────────────

/**
 * Upload one Sender Key distribution, sealed once per recipient device.
 * POST /api/servers/{serverId}/channels/{channelId}/group-sessions
 *
 * The whole envelope set goes in a SINGLE request so the server either has a
 * complete distribution or none of it — a half-delivered distribution would
 * leave some members unable to read the channel.
 *
 * `version` is mandatory and hard-cut: the server rejects anything but 2. The
 * pre-C-03 body ({ session_id, session_data }) shipped the group chain key as
 * readable JSON and is no longer produced by this client.
 */
export function uploadGroupSession(
  serverId: string,
  channelId: string,
  deviceId: string,
  req: {
    session_id: string;
    version: number;
    envelopes: Array<{
      recipient_user_id: string;
      recipient_device_id: string;
      message_type: number;
      ciphertext: string;
    }>;
  }
) {
  return apiClient<null>(
    `/servers/${serverId}/channels/${channelId}/group-sessions?device_id=${encodeURIComponent(deviceId)}`,
    {
      method: "POST",
      body: req,
    }
  );
}

/**
 * Fetch the sealed distributions addressed to THIS device.
 * GET /api/servers/{serverId}/channels/{channelId}/group-sessions?device_id=...
 *
 * Filtering is server-side: every returned row is already ours, so the caller
 * matches on (sender_user_id, sender_device_id, session_id) alone.
 */
export function fetchGroupSessions(
  serverId: string,
  channelId: string,
  deviceId: string
) {
  return apiClient<ChannelGroupSessionResponse[]>(
    `/servers/${serverId}/channels/${channelId}/group-sessions?device_id=${encodeURIComponent(deviceId)}`
  );
}

/**
 * Fetch every device that must receive this channel's Sender Key distribution,
 * with its prekey bundle. GET .../channels/{channelId}/sender-key-recipients
 *
 * Returns the caller's OTHER devices too (so all of a user's devices can read
 * what one of them sent) but not the calling device itself.
 */
export function fetchSenderKeyRecipients(
  serverId: string,
  channelId: string,
  deviceId: string
) {
  // device_id is REQUIRED — the server 400s without it. Over stateless HTTP it
  // is the only way to identify which of the caller's devices is asking, and
  // the roster excludes exactly that device (the caller's OTHER devices are
  // still included: they each need their own envelope). Same convention as the
  // sibling GET .../group-sessions?device_id=.
  return apiClient<SenderKeyRecipient[]>(
    `/servers/${serverId}/channels/${channelId}/sender-key-recipients?device_id=${encodeURIComponent(deviceId)}`
  );
}
