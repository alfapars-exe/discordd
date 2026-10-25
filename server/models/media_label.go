package models

import (
	"encoding/hex"
	"fmt"
)

// MediaLabel is an account-private user annotation, not an automated verdict.
// Neither media bytes nor decrypted message text are part of this contract.
type MediaLabel struct {
	UserID          string  `json:"-"`
	SourceKind      string  `json:"source_kind"`
	ChannelID       string  `json:"channel_id"`
	MessageID       string  `json:"message_id"`
	Revision        string  `json:"revision"`
	Fingerprint     string  `json:"fingerprint"`
	Label           string  `json:"label"`
	Version         string  `json:"version,omitempty"`
	ExpectedVersion *string `json:"expected_version,omitempty"`
}

func (e *MediaLabel) Validate(requireLabel bool) error {
	if e == nil {
		return fmt.Errorf("missing media reference")
	}
	ref := SpamInboxEntry{SourceKind: e.SourceKind, ChannelID: e.ChannelID, MessageID: e.MessageID, Revision: e.Revision}
	if err := ref.Validate(false); err != nil {
		return err
	}
	if len(e.Fingerprint) != 64 {
		return fmt.Errorf("invalid media fingerprint")
	}
	decoded, err := hex.DecodeString(e.Fingerprint)
	if err != nil || hex.EncodeToString(decoded) != e.Fingerprint {
		return fmt.Errorf("invalid media fingerprint")
	}
	if (requireLabel || e.Label != "") && e.Label != "ordinary" && e.Label != "sexual" && e.Label != "disturbing" && e.Label != "both" {
		return fmt.Errorf("invalid user media label")
	}
	if e.ExpectedVersion != nil && *e.ExpectedVersion != "" && *e.ExpectedVersion != "legacy" {
		value, err := hex.DecodeString(*e.ExpectedVersion)
		if err != nil || len(value) != 16 || hex.EncodeToString(value) != *e.ExpectedVersion {
			return fmt.Errorf("invalid expected annotation version")
		}
	}
	return nil
}
