package services

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
)

type channelNotificationQueueStub struct {
	job          *repository.ChannelMessageNotificationJob
	ids          []string
	suppressed   map[string]bool
	committed    []*models.Notification
	failCalls    int
	commitCursor string
	commitDone   bool
}

func (q *channelNotificationQueueStub) Enqueue(context.Context, string, string, string, string) error {
	return nil
}
func (q *channelNotificationQueueStub) DeleteByMessageID(context.Context, string) error { return nil }
func (q *channelNotificationQueueStub) DeleteByChannelID(context.Context, string) error { return nil }
func (q *channelNotificationQueueStub) NextBatch(context.Context, int) (*repository.ChannelMessageNotificationJob, []string, error) {
	return q.job, q.ids, nil
}
func (q *channelNotificationQueueStub) SuppressedRecipients(context.Context, *repository.ChannelMessageNotificationJob, []string) (map[string]bool, error) {
	return q.suppressed, nil
}
func (q *channelNotificationQueueStub) FailBatch(context.Context, *repository.ChannelMessageNotificationJob) error {
	q.failCalls++
	return nil
}
func (q *channelNotificationQueueStub) CommitBatch(_ context.Context, _ *repository.ChannelMessageNotificationJob, cursor string, done bool, eligible []*models.Notification) ([]*models.Notification, bool, error) {
	q.commitCursor, q.commitDone, q.committed = cursor, done, eligible
	return nil, true, nil
}

type channelNotificationPreferencesStub struct {
	rows map[string]*models.UserPreferences
	err  error
}

func (p *channelNotificationPreferencesStub) Get(context.Context, string) (*models.UserPreferences, error) {
	return nil, nil
}
func (p *channelNotificationPreferencesStub) Upsert(context.Context, string, json.RawMessage) (*models.UserPreferences, error) {
	return nil, nil
}
func (p *channelNotificationPreferencesStub) GetMany(context.Context, []string) (map[string]*models.UserPreferences, error) {
	return p.rows, p.err
}

func TestChannelMessageNotificationWorkerEnforcesOptInIgnoreAndMuteBeforeCommit(t *testing.T) {
	job := &repository.ChannelMessageNotificationJob{MessageID: "message", ServerID: "server", ChannelID: "channel", ActorID: "actor"}
	queue := &channelNotificationQueueStub{job: job, ids: []string{"u-opt-in", "u-opt-out", "u-ignored", "u-muted"}, suppressed: map[string]bool{"u-muted": true}}
	prefs := &channelNotificationPreferencesStub{rows: map[string]*models.UserPreferences{
		"u-opt-in":  {Data: json.RawMessage(`{"notifications":{"channelMessageNotifications":true}}`)},
		"u-opt-out": {Data: json.RawMessage(`{"notifications":{"channelMessageNotifications":false}}`)},
		"u-ignored": {Data: json.RawMessage(`{"notifications":{"channelMessageNotifications":true},"privacy":{"ignoredUsers":{"actor":true}}}`)},
		"u-muted":   {Data: json.RawMessage(`{"notifications":{"channelMessageNotifications":true}}`)},
	}}
	worker := NewChannelMessageNotificationWorker(queue, prefs, nil, nil)
	processed, err := worker.ProcessNextBatch(context.Background())
	if err != nil || !processed {
		t.Fatalf("processed=%v err=%v", processed, err)
	}
	if len(queue.committed) != 1 || queue.committed[0].UserID != "u-opt-in" {
		t.Fatalf("eligible=%#v", queue.committed)
	}
	if queue.commitCursor != "u-muted" || !queue.commitDone {
		t.Fatalf("cursor=%q done=%v", queue.commitCursor, queue.commitDone)
	}
}

func TestChannelMessageNotificationWorkerSchedulesRetryOnBatchReadFailure(t *testing.T) {
	job := &repository.ChannelMessageNotificationJob{MessageID: "message"}
	queue := &channelNotificationQueueStub{job: job, ids: []string{"u-opt-in"}}
	prefs := &channelNotificationPreferencesStub{err: errors.New("temporary preference read failure")}
	worker := NewChannelMessageNotificationWorker(queue, prefs, nil, nil)
	processed, err := worker.ProcessNextBatch(context.Background())
	if processed || err == nil || queue.failCalls != 1 {
		t.Fatalf("processed=%v err=%v FailBatch calls=%d", processed, err, queue.failCalls)
	}
}
