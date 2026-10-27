package repository

import (
	"context"
	"github.com/argeinfina/hichat/models"
)

const ChannelMessageNotificationBatchSize = 100

// ChannelMessageNotificationQueue is a durable, paged fanout queue. A cursor
// is advanced only with the notification inserts for that page.
type ChannelMessageNotificationQueue interface {
	Enqueue(context.Context, string, string, string, string) error
	DeleteByMessageID(context.Context, string) error
	DeleteByChannelID(context.Context, string) error
	NextBatch(context.Context, int) (*ChannelMessageNotificationJob, []string, error)
	SuppressedRecipients(context.Context, *ChannelMessageNotificationJob, []string) (map[string]bool, error)
	FailBatch(context.Context, *ChannelMessageNotificationJob) error
	CommitBatch(context.Context, *ChannelMessageNotificationJob, string, bool, []*models.Notification) ([]*models.Notification, bool, error)
}

type ChannelMessageNotificationJob struct {
	MessageID    string
	ServerID     string
	ChannelID    string
	ActorID      string
	CursorUserID string
	LastBatchAt  string
}
