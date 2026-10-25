package repository

import (
	"context"
	"time"

	"github.com/argeinfina/hichat/models"
)

// FriendAnniversaryCandidate is an accepted relationship whose anniversary
// day matches the worker's UTC day. Both sides receive one independent
// preference decision.
type FriendAnniversaryCandidate struct {
	FriendshipID   string
	UserID         string
	FriendID       string
	AcceptedAt     time.Time
	AnniversaryDay string
}

// FriendAnniversaryDeliveryRepository provides bounded candidate paging and
// atomically records each recipient's notification decision.
type FriendAnniversaryDeliveryRepository interface {
	DueCandidates(context.Context, string, bool, string, int) ([]FriendAnniversaryCandidate, error)
	Deliver(context.Context, string, int, string, time.Time) (*models.Notification, error)
}
