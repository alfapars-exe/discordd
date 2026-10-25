package models

import "encoding/json"

// MusicControlHead survives empty queues and explicit stops. Protocol adoption
// is sticky: deleting a music_sessions row must never downgrade the API.
type MusicControlHead struct {
	ChannelID       string `json:"channel_id"`
	ServerID        string `json:"server_id"`
	SessionID       string `json:"session_id"`
	Revision        uint64 `json:"revision"`
	MinimumProtocol int    `json:"minimum_protocol"`
}

// MusicOperation binds a retry to its authenticated actor and complete payload.
// RequestHash is a canonical SHA-256 digest computed by the service, never an
// untrusted client digest. Receipts are checked before session/revision CAS.
type MusicOperation struct {
	ActorID          string
	ChannelID        string
	SessionID        string
	RequestID        string
	RequestHash      string
	ExpectedRevision uint64
}

type MusicOperationReceipt struct {
	MusicOperation
	Result json.RawMessage
}

// MusicOperationCommit describes one atomic durable state/receipt change.
// NextHead normally increments Revision, and rotates SessionID on explicit stop.
// A nil Session removes the paused queue while preserving the control head.
type MusicOperationCommit struct {
	Operation MusicOperation
	NextHead  MusicControlHead
	Session   *MusicSession
	Result    json.RawMessage
}
