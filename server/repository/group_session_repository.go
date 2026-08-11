package repository

import (
	"context"

	"github.com/argeinfina/hichat/models"
)

// GroupSessionRepository defines data access for Sender Key distribution
// envelopes (pentest C-03: sealed per recipient device, not a shared blob).
type GroupSessionRepository interface {
	// Upsert writes every envelope in req for (channel_id, sender_user_id,
	// sender_device_id, session_id) in a single transaction — all envelopes
	// in a distribution land together, or none do.
	Upsert(ctx context.Context, channelID, senderUserID, senderDeviceID string, req *models.CreateSenderKeyDistributionRequest) error
	// GetForRecipient returns only the envelopes sealed for exactly
	// (recipient_user_id, recipient_device_id) in a channel — never another
	// recipient's ciphertext.
	GetForRecipient(ctx context.Context, channelID, recipientUserID, recipientDeviceID string) ([]models.SenderKeyEnvelopeResponse, error)
	// DeleteByChannel removes all envelopes for a channel (called during key rotation).
	DeleteByChannel(ctx context.Context, channelID string) error
	// DeleteByUser removes a user's envelopes (as sender) from a channel (called when user leaves).
	DeleteByUser(ctx context.Context, channelID, userID string) error
}
