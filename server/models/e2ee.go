package models

import (
	"fmt"
	"strings"
	"time"
)

// E2EEKeyBackup is a server-stored encrypted key backup.
// Client derives AES-256-GCM key from a recovery password (PBKDF2),
// encrypts all E2EE keys, and uploads the blob. Server cannot read the keys.
type E2EEKeyBackup struct {
	ID            string `json:"id"`
	UserID        string `json:"user_id"`
	Version       int    `json:"version"`
	Algorithm     string `json:"algorithm"`
	EncryptedData string `json:"encrypted_data"`
	Nonce         string `json:"nonce"`
	Salt          string `json:"salt"`
	// BackupHMAC (P0-BD-01) is a server-side HMAC-SHA256 over the integrity-
	// relevant fields, keyed by an HKDF subkey of the server master key. It
	// detects at-rest tampering of the opaque blob and is never sent to clients.
	BackupHMAC string    `json:"-"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
}

// CreateKeyBackupRequest is a create/update request for key backup.
type CreateKeyBackupRequest struct {
	Version       int    `json:"version"`
	Algorithm     string `json:"algorithm"`
	EncryptedData string `json:"encrypted_data"`
	Nonce         string `json:"nonce"`
	Salt          string `json:"salt"`
}

// Validate checks required fields.
func (r *CreateKeyBackupRequest) Validate() error {
	if strings.TrimSpace(r.EncryptedData) == "" {
		return fmt.Errorf("encrypted_data is required")
	}
	if strings.TrimSpace(r.Nonce) == "" {
		return fmt.Errorf("nonce is required")
	}
	if strings.TrimSpace(r.Salt) == "" {
		return fmt.Errorf("salt is required")
	}
	if r.Algorithm == "" {
		r.Algorithm = "aes-256-gcm"
	}
	return nil
}

// ChannelGroupSession represents a legacy (pre-v2) Sender Key session row.
//
// ⚠ HISTORICAL — closed by pentest finding C-03 (2026-07-31). Until then, the
// client uploaded the Sender Key distribution as a single plain-JSON blob
// (including the 32-byte symmetric chainKey) shared by every channel member,
// so the server could decrypt every "E2EE" channel message. Migration 075
// deletes all rows from channel_group_sessions and the write/read paths now
// go through channel_sender_key_envelopes instead (see SenderKeyEnvelope):
// the sender seals one opaque envelope per recipient device, and the server
// can only ever read the envelope's own device — never anyone else's.
//
// This type and table are kept only because message_index bookkeeping /
// historical data may still be referenced; no code path writes SessionData
// as a new distribution anymore.
type ChannelGroupSession struct {
	ID             string    `json:"id"`
	ChannelID      string    `json:"channel_id"`
	SenderUserID   string    `json:"sender_user_id"`
	SenderDeviceID string    `json:"sender_device_id"`
	SessionID      string    `json:"session_id"`
	SessionData    string    `json:"session_data"`
	MessageIndex   int       `json:"message_index"`
	CreatedAt      time.Time `json:"created_at"`
}

// SenderKeyEnvelope is a single sealed-per-recipient-device row in
// channel_sender_key_envelopes. ciphertext is opaque to the server — it is a
// Signal PreKey/Whisper message wrapping the Sender Key distribution for
// exactly (recipient_user_id, recipient_device_id).
type SenderKeyEnvelope struct {
	ID                string    `json:"id"`
	ChannelID         string    `json:"channel_id"`
	SenderUserID      string    `json:"sender_user_id"`
	SenderDeviceID    string    `json:"sender_device_id"`
	RecipientUserID   string    `json:"recipient_user_id"`
	RecipientDeviceID string    `json:"recipient_device_id"`
	SessionID         string    `json:"session_id"`
	Version           int       `json:"version"`
	MessageType       int       `json:"message_type"`
	Ciphertext        string    `json:"ciphertext"`
	CreatedAt         time.Time `json:"created_at"`
}

// SenderKeyEnvelopeInput is one recipient-device-sealed envelope in a
// distribution upload.
type SenderKeyEnvelopeInput struct {
	RecipientUserID   string `json:"recipient_user_id"`
	RecipientDeviceID string `json:"recipient_device_id"`
	MessageType       int    `json:"message_type"`
	Ciphertext        string `json:"ciphertext"`
}

// CreateSenderKeyDistributionRequest is the v2 wire format (pentest C-03):
// the sender seals its Sender Key distribution once per recipient device and
// uploads all envelopes together. version must be 2 — there is no
// compatibility path for the legacy single-blob format (see Validate).
type CreateSenderKeyDistributionRequest struct {
	SessionID string                   `json:"session_id"`
	Version   int                      `json:"version"`
	Envelopes []SenderKeyEnvelopeInput `json:"envelopes"`
}

// maxSenderKeyEnvelopes and maxSenderKeyCiphertextLen bound a distribution
// upload (pentest C-03 follow-up finding 3): unbounded envelope count/
// ciphertext length let any channel-send-permitted member write arbitrarily
// large rows and fan out a "1 POST -> N recipient GETs" amplification. 512
// envelopes comfortably covers a large server's worth of devices (well past
// any real member+multi-device count); 16KB per ciphertext is generous for a
// single sealed Signal PreKey/Whisper message, which carries a Sender Key
// distribution, not message content.
const (
	maxSenderKeyEnvelopes     = 512
	maxSenderKeyCiphertextLen = 16384
)

// Validate checks required fields and rejects anything that isn't the v2
// per-recipient envelope format. There is no legacy fallback: callers detect
// a stray "session_data" field (the old wire shape) before this is even
// reached — see CreateGroupSession's rawBody sniff.
func (r *CreateSenderKeyDistributionRequest) Validate() error {
	if strings.TrimSpace(r.SessionID) == "" {
		return fmt.Errorf("session_id is required")
	}
	if r.Version != 2 {
		return fmt.Errorf("version must be 2")
	}
	if len(r.Envelopes) == 0 {
		return fmt.Errorf("envelopes is required")
	}
	if len(r.Envelopes) > maxSenderKeyEnvelopes {
		return fmt.Errorf("envelopes exceeds the maximum of %d", maxSenderKeyEnvelopes)
	}
	for i, e := range r.Envelopes {
		if strings.TrimSpace(e.RecipientUserID) == "" {
			return fmt.Errorf("envelopes[%d].recipient_user_id is required", i)
		}
		if strings.TrimSpace(e.RecipientDeviceID) == "" {
			return fmt.Errorf("envelopes[%d].recipient_device_id is required", i)
		}
		if strings.TrimSpace(e.Ciphertext) == "" {
			return fmt.Errorf("envelopes[%d].ciphertext is required", i)
		}
		if len(e.Ciphertext) > maxSenderKeyCiphertextLen {
			return fmt.Errorf("envelopes[%d].ciphertext exceeds the maximum of %d bytes", i, maxSenderKeyCiphertextLen)
		}
	}
	return nil
}

// SenderKeyEnvelopeResponse is what GetGroupSessions returns to a device:
// only the envelopes sealed for that exact (recipient_user_id,
// recipient_device_id) — never another recipient's ciphertext.
type SenderKeyEnvelopeResponse struct {
	SenderUserID   string    `json:"sender_user_id"`
	SenderDeviceID string    `json:"sender_device_id"`
	SessionID      string    `json:"session_id"`
	Version        int       `json:"version"`
	MessageType    int       `json:"message_type"`
	Ciphertext     string    `json:"ciphertext"`
	CreatedAt      time.Time `json:"created_at"`
}

// SenderKeyRecipient is one device in the sender-key-recipients roster: the
// prekey bundle a sender needs to X3DH-establish a session and seal an
// envelope for that device.
type SenderKeyRecipient struct {
	UserID          string  `json:"user_id"`
	DeviceID        string  `json:"device_id"`
	RegistrationID  int     `json:"registration_id"`
	IdentityKey     string  `json:"identity_key"`
	SigningKey      *string `json:"signing_key,omitempty"`
	SignedPrekeyID  int     `json:"signed_prekey_id"`
	SignedPrekey    string  `json:"signed_prekey"`
	SignedPrekeySig string  `json:"signed_prekey_signature"`
	OneTimePrekeyID *int    `json:"one_time_prekey_id,omitempty"`
	OneTimePrekey   *string `json:"one_time_prekey,omitempty"`
}

// EncryptedMessagePayload carries E2EE fields for encrypted messages.
// Mentions are sent unencrypted so the server can generate notifications —
// a deliberate privacy trade-off (server knows who was mentioned, not the content).
type EncryptedMessagePayload struct {
	EncryptionVersion int               `json:"encryption_version"`
	SenderDeviceID    string            `json:"sender_device_id"`
	Ciphertext        string            `json:"ciphertext,omitempty"`
	Ciphertexts       map[string]string `json:"ciphertexts,omitempty"`
	E2EEMetadata      string            `json:"e2ee_metadata,omitempty"`
	Mentions          []string          `json:"mentions,omitempty"`
}
