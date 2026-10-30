package services

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/ws"
)

// ConfigureChannelDelivery enables the PostgreSQL durable path. Kept separate
// from the constructor so legacy repository fixtures remain independently usable.
func ConfigureChannelDelivery(service MessageService, db *sql.DB) {
	if s, ok := service.(*messageService); ok {
		s.deliveryDB = db
	}
}

// claimChannelSend is called inside the message transaction. ON CONFLICT waits
// for a concurrent winner without aborting the transaction, then reads its result.
func claimChannelSend(ctx context.Context, tx *sql.Tx, channel, user string, req *models.CreateMessageRequest) (string, bool, error) {
	if req.ClientMessageID == "" {
		return "", false, nil
	}
	result, err := tx.ExecContext(ctx, `INSERT INTO channel_send_operations(user_id,channel_id,client_message_id,request_hash) VALUES(?,?,?,?) ON CONFLICT DO NOTHING`, user, channel, req.ClientMessageID, req.RequestHash)
	if err != nil {
		return "", false, err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return "", false, err
	}
	if n == 1 {
		return "", false, nil
	}
	var hash string
	var id sql.NullString
	err = tx.QueryRowContext(ctx, `SELECT request_hash,message_id FROM channel_send_operations WHERE user_id=? AND channel_id=? AND client_message_id=?`, user, channel, req.ClientMessageID).Scan(&hash, &id)
	if err != nil {
		return "", false, err
	}
	if hash != req.RequestHash {
		return "", false, fmt.Errorf("%w: client_message_id already used for another request", pkg.ErrConflict)
	}
	if !id.Valid {
		return "", false, pkg.ErrConflict
	}
	return id.String, true, nil
}

func (s *messageService) AttachmentOutcome(ctx context.Context, id string, index int, attachment *models.Attachment, failure string) error {
	if s.deliveryDB == nil {
		return nil
	}
	status := "failed"
	var attachmentID *string
	if attachment != nil {
		status = "ready"
		attachmentID = &attachment.ID
	}
	_, err := s.deliveryDB.ExecContext(ctx, `UPDATE channel_attachment_jobs SET status=?,attachment_id=?,error=?,updated_at=CURRENT_TIMESTAMP WHERE message_id=? AND file_index=? AND status='preparing'`, status, attachmentID, failure, id, index)
	return err
}

func (s *messageService) CompleteChannelSend(ctx context.Context, m *models.Message) error {
	if s.deliveryDB == nil {
		s.BroadcastCreate(m)
		return nil
	}
	// Unfinished slots are made explicitly failed, never silently treated as ready.
	tx, err := s.deliveryDB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `UPDATE channel_attachment_jobs SET status='failed',error='attachment preparation interrupted',updated_at=CURRENT_TIMESTAMP WHERE message_id=? AND status='preparing'`, m.ID); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE channel_delivery_outbox SET ready=TRUE WHERE message_id=? AND NOT ready`, m.ID); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	return s.loadAttachmentStates(ctx, m)
}

func (s *messageService) loadAttachmentStates(ctx context.Context, m *models.Message) error {
	rows, err := s.deliveryDB.QueryContext(ctx, `SELECT file_index,filename,status,error,attachment_id FROM channel_attachment_jobs WHERE message_id=? ORDER BY file_index`, m.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	m.AttachmentStates = nil
	for rows.Next() {
		var state models.AttachmentPreparation
		var attachmentID sql.NullString
		if err = rows.Scan(&state.Index, &state.Filename, &state.Status, &state.Error, &attachmentID); err != nil {
			return err
		}
		m.AttachmentStates = append(m.AttachmentStates, state)
		if attachmentID.Valid {
			for i := range m.Attachments {
				if m.Attachments[i].ID == attachmentID.String {
					index := state.Index
					m.Attachments[i].PreparationIndex = &index
				}
			}
		}
	}
	return rows.Err()
}

// StartChannelDelivery returns a stop function which waits for its worker.
func StartChannelDelivery(parent context.Context, service MessageService) func() {
	s, ok := service.(*messageService)
	if !ok || s.deliveryDB == nil {
		return func() { /* No worker exists for a legacy fixture. */ }
	}
	ctx, cancel := channelWorkerContext(parent)
	done := make(chan struct{})
	// Called before HTTP serving under the singleton owner. No live upload
	// can own a preparation left by the previous process.
	startup, startupCancel := context.WithTimeout(ctx, 10*time.Second)
	if err := database.WithTx(startup, s.deliveryDB, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(startup, `UPDATE channel_attachment_jobs SET status='failed',error='attachment preparation interrupted',updated_at=CURRENT_TIMESTAMP WHERE status='preparing'`); err != nil {
			return err
		}
		_, err := tx.ExecContext(startup, `UPDATE channel_delivery_outbox e SET ready=TRUE,lease_until=NULL WHERE published_at IS NULL AND NOT EXISTS(SELECT 1 FROM channel_attachment_jobs a WHERE a.message_id=e.message_id AND a.status='preparing')`)
		return err
	}); err != nil {
		messageLogger.Error("channel preparation recovery failed")
	}
	startupCancel()
	go func() {
		defer close(done)
		ticker := time.NewTicker(500 * time.Millisecond)
		defer ticker.Stop()
		for {
			if ctx.Err() != nil {
				return
			}
			s.deliveryTick(ctx)
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	return func() { cancel(); <-done }
}

func (s *messageService) KeepChannelSendAlive(parent context.Context, id string) func() {
	if s.deliveryDB == nil {
		return func() { /* No worker exists for a legacy fixture. */ }
	}
	ctx, cancel := channelWorkerContext(parent)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				refresh, stop := context.WithTimeout(ctx, 5*time.Second)
				_, err := s.deliveryDB.ExecContext(refresh, `UPDATE channel_attachment_jobs SET updated_at=CURRENT_TIMESTAMP WHERE message_id=? AND status='preparing'`, id)
				stop()
				if err != nil {
					messageLogger.Warn("channel preparation heartbeat failed")
				}
			}
		}
	}()
	return func() { cancel(); <-done }
}

func (s *messageService) deliveryTick(parent context.Context) {
	ctx, cancel := context.WithTimeout(parent, 10*time.Second)
	defer cancel()
	// A crashed multipart handler cannot leave an invisible message forever.
	// Active uploads refresh their slots every ten seconds; a minute without
	// progress marks an abandoned preparation explicitly failed.
	_, err := s.deliveryDB.ExecContext(ctx, `UPDATE channel_attachment_jobs SET status='failed',error='attachment preparation interrupted',updated_at=CURRENT_TIMESTAMP WHERE status='preparing' AND updated_at<CURRENT_TIMESTAMP-INTERVAL '1 minute'`)
	if err != nil {
		return
	}
	_, err = s.deliveryDB.ExecContext(ctx, `UPDATE channel_delivery_outbox e SET ready=TRUE WHERE NOT ready AND NOT EXISTS(SELECT 1 FROM channel_attachment_jobs a WHERE a.message_id=e.message_id AND a.status='preparing')`)
	if err != nil {
		return
	}
	for i := 0; i < 32; i++ {
		if !s.deliverNext(ctx) {
			break
		}
	}
	// Retention only removes successfully published events. Failed work persists.
	_, err = s.deliveryDB.ExecContext(ctx, `DELETE FROM channel_delivery_outbox WHERE event_id IN (SELECT event_id FROM channel_delivery_outbox WHERE published_at IS NOT NULL AND created_at<CURRENT_TIMESTAMP-INTERVAL '7 days' LIMIT 500)`)
	if err != nil {
		messageLogger.Warn("channel outbox retention failed")
	}
}

type channelDeliveryEvent struct {
	ID        string          `json:"event_id"`
	Sequence  int64           `json:"channel_sequence"`
	Op        string          `json:"op"`
	Data      json.RawMessage `json:"d"`
	Channel   string          `json:"-"`
	Message   string          `json:"-"`
	Recipient sql.NullString  `json:"-"`
}

func (s *messageService) deliverNext(ctx context.Context) bool {
	var e channelDeliveryEvent
	var payload string
	// Message mutations retain their channel order independently of personal
	// notifications, so a deferred notification cannot block live chat.
	err := s.deliveryDB.QueryRowContext(ctx, `UPDATE channel_delivery_outbox SET lease_until=CURRENT_TIMESTAMP+INTERVAL '30 seconds',attempts=attempts+1 WHERE event_id=(SELECT e.event_id FROM channel_delivery_outbox e WHERE e.published_at IS NULL AND e.ready AND e.available_at<=CURRENT_TIMESTAMP AND (e.lease_until IS NULL OR e.lease_until<CURRENT_TIMESTAMP) AND NOT EXISTS(SELECT 1 FROM channel_delivery_outbox p WHERE p.channel_id=e.channel_id AND p.channel_sequence<e.channel_sequence AND p.published_at IS NULL AND (p.op<>'notification_create' OR e.op='notification_create')) ORDER BY CASE WHEN e.op='notification_create' THEN 1 ELSE 0 END,e.event_id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING event_id::text,channel_id,channel_sequence,message_id,op,recipient_id,payload::text`).Scan(&e.ID, &e.Channel, &e.Sequence, &e.Message, &e.Op, &e.Recipient, &payload)
	e.Data = json.RawMessage(payload)
	if errors.Is(err, sql.ErrNoRows) {
		return false
	}
	if err != nil {
		messageLogger.Error("channel outbox claim failed", "err", pkg.ErrText(err))
		return false
	}
	err = s.publishDelivery(ctx, &e)
	if err != nil {
		_, updateErr := s.deliveryDB.ExecContext(ctx, `UPDATE channel_delivery_outbox SET lease_until=NULL,available_at=CURRENT_TIMESTAMP+LEAST(attempts::bigint*attempts,300)*INTERVAL '1 second',last_error='publication failed' WHERE event_id=?`, e.ID)
		if updateErr != nil {
			messageLogger.Error("channel outbox retry scheduling failed")
		}
		return true
	}
	_, err = s.deliveryDB.ExecContext(ctx, `UPDATE channel_delivery_outbox SET published_at=CURRENT_TIMESTAMP,lease_until=NULL,last_error=NULL WHERE event_id=?`, e.ID)
	if err != nil {
		messageLogger.Error("channel outbox acknowledgement failed")
	}
	return true
}

func (s *messageService) publishDelivery(ctx context.Context, e *channelDeliveryEvent) error {
	if _, err := s.channelRepo.GetByID(ctx, e.Channel); errors.Is(err, pkg.ErrNotFound) {
		return nil
	} else if err != nil {
		return err
	}
	data, err := s.deliveryPayload(ctx, *e)
	if err != nil {
		return err
	}
	if data == nil {
		return nil
	}
	viewers, ok := s.allowedViewers(e.Channel)
	if !ok {
		return fmt.Errorf("cannot resolve viewers")
	}
	if e.Recipient.Valid {
		permitted := false
		for _, id := range viewers {
			if id == e.Recipient.String {
				permitted = true
				break
			}
		}
		if !permitted {
			return nil
		}
		viewers = []string{e.Recipient.String}
	}
	s.hub.BroadcastToUsers(viewers, ws.Event{Op: e.Op, Data: json.RawMessage(data), EventID: e.ID, ChannelSequence: e.Sequence})
	return nil
}

func (s *messageService) deliveryPayload(ctx context.Context, e channelDeliveryEvent) ([]byte, error) {
	if e.Op == ws.OpMessageDelete {
		return e.Data, nil
	}
	if e.Op == ws.OpNotificationCreate {
		return s.deliveryNotificationPayload(ctx, e)
	}
	m, err := s.messageRepo.GetByID(ctx, e.Message)
	if errors.Is(err, pkg.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	// Use the event's content snapshot so replay never emits a newer edit and
	// then rolls the client back with an older queued event.
	var snapshot models.Message
	if err = json.Unmarshal(e.Data, &snapshot); err != nil {
		return nil, err
	}
	m.Content = snapshot.Content
	m.Ciphertext = snapshot.Ciphertext
	m.E2EEMetadata = snapshot.E2EEMetadata
	m.SenderDeviceID = snapshot.SenderDeviceID
	m.EditedAt = snapshot.EditedAt
	m.Attachments, err = s.attachmentRepo.GetByMessageID(ctx, m.ID)
	if err != nil {
		return nil, err
	}
	m.Mentions, err = s.mentionRepo.GetMentionedUserIDs(ctx, m.ID)
	if err != nil {
		return nil, err
	}
	roles, err := s.roleMentionRepo.GetByMessageIDs(ctx, []string{m.ID})
	if err != nil {
		return nil, err
	}
	m.RoleMentions = roles[m.ID]
	m.Reactions = []models.ReactionGroup{}
	if err = s.loadAttachmentStates(ctx, m); err != nil {
		return nil, err
	}
	if err = s.deliveryDB.QueryRowContext(ctx, `SELECT m.source_sequence,c.server_id FROM messages m JOIN channels c ON c.id=m.channel_id WHERE m.id=?`, m.ID).Scan(&m.SourceSequence, &m.ServerID); err != nil {
		return nil, err
	}
	return json.Marshal(m)
}

func (s *messageService) deliveryNotificationPayload(ctx context.Context, e channelDeliveryEvent) ([]byte, error) {
	// Deleted notification rows (e.g. message deletion) must not be resurrected.
	var readAt sql.NullTime
	var n models.Notification
	if err := json.Unmarshal(e.Data, &n); err != nil {
		return nil, err
	}
	err := s.deliveryDB.QueryRowContext(ctx, `SELECT read_at FROM notifications WHERE id=?`, n.ID).Scan(&readAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if readAt.Valid {
		value := readAt.Time.UTC().Format(time.RFC3339Nano)
		n.ReadAt = &value
	}
	if n.ActorID != nil {
		u, err := s.userRepo.GetByID(ctx, *n.ActorID)
		if err != nil && !errors.Is(err, pkg.ErrNotFound) {
			return nil, err
		}
		if u != nil {
			n.Actor = models.ToPublicUser(u)
		}
	}
	return json.Marshal(n)
}

type ChannelEventPage struct {
	Events  []channelDeliveryEvent `json:"events"`
	Cursor  int64                  `json:"cursor"`
	HasMore bool                   `json:"has_more"`
	Reset   bool                   `json:"reset"`
}

type ChannelDeliveryHealth struct {
	Pending              int64   `json:"pending"`
	Preparing            int64   `json:"preparing"`
	Retrying             int64   `json:"retrying"`
	OldestPendingSeconds float64 `json:"oldest_pending_seconds"`
	MaxAttempts          int     `json:"max_attempts"`
}

func (s *messageService) ChannelDeliveryHealth(ctx context.Context) (*ChannelDeliveryHealth, error) {
	if s.deliveryDB == nil {
		return nil, pkg.ErrNotFound
	}
	health := &ChannelDeliveryHealth{}
	err := s.deliveryDB.QueryRowContext(ctx, `SELECT COUNT(*),COUNT(*) FILTER(WHERE NOT ready),COUNT(*) FILTER(WHERE last_error IS NOT NULL),COALESCE(EXTRACT(EPOCH FROM CURRENT_TIMESTAMP-MIN(created_at)),0),COALESCE(MAX(attempts),0) FROM channel_delivery_outbox WHERE published_at IS NULL`).Scan(&health.Pending, &health.Preparing, &health.Retrying, &health.OldestPendingSeconds, &health.MaxAttempts)
	return health, err
}

func (s *messageService) ChannelEvents(ctx context.Context, server, channel, user string, after int64) (*ChannelEventPage, error) {
	if s.deliveryDB == nil {
		return nil, pkg.ErrNotFound
	}
	if _, err := s.validateChannelScope(ctx, server, channel); err != nil {
		return nil, err
	}
	perms, err := s.permResolver.ResolveChannelPermissions(ctx, user, channel)
	if err != nil {
		return nil, err
	}
	if !models.PermCanReadChannel(perms) {
		return nil, pkg.ErrForbidden
	}
	page := &ChannelEventPage{Events: []channelDeliveryEvent{}, Cursor: after}
	var latest, floor int64
	if err = s.deliveryDB.QueryRowContext(ctx, `SELECT last_event_sequence,COALESCE((SELECT MIN(channel_sequence) FROM channel_delivery_outbox WHERE channel_id=? AND created_at>=CURRENT_TIMESTAMP-INTERVAL '7 days'),last_event_sequence+1) FROM channels WHERE id=?`, channel, channel).Scan(&latest, &floor); err != nil {
		return nil, err
	}
	if after == 0 || after < floor-1 || after > latest {
		page.Reset = true
		page.Cursor = latest
		return page, nil
	}
	// Unready attachments block the cursor; a later call will continue.
	rows, err := s.deliveryDB.QueryContext(ctx, `SELECT event_id::text,channel_sequence,message_id,op,recipient_id,payload::text FROM channel_delivery_outbox e WHERE channel_id=? AND channel_sequence>? AND ready AND NOT EXISTS(SELECT 1 FROM channel_delivery_outbox p WHERE p.channel_id=e.channel_id AND p.channel_sequence<=e.channel_sequence AND NOT p.ready) ORDER BY channel_sequence LIMIT 101`, channel, after)
	if err != nil {
		return nil, err
	}
	var events []channelDeliveryEvent
	for rows.Next() {
		e := channelDeliveryEvent{Channel: channel}
		var payload string
		if err = rows.Scan(&e.ID, &e.Sequence, &e.Message, &e.Op, &e.Recipient, &payload); err != nil {
			rows.Close()
			return nil, err
		}
		e.Data = json.RawMessage(payload)
		events = append(events, e)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	page.HasMore = len(events) > 100
	if page.HasMore {
		events = events[:100]
	}
	if err = s.hydrateReplayEvents(ctx, page, events, user); err != nil {
		return nil, err
	}
	// Authorization is rechecked after hydration as well.
	perms, err = s.permResolver.ResolveChannelPermissions(ctx, user, channel)
	if err != nil {
		return nil, err
	}
	if !models.PermCanReadChannel(perms) {
		return nil, pkg.ErrForbidden
	}
	return page, nil
}

// channelWorkerContext transfers cancellation ownership to the returned worker stop function.
func channelWorkerContext(parent context.Context) (context.Context, context.CancelFunc) {
	return context.WithCancel(parent)
}

func (s *messageService) hydrateReplayEvents(ctx context.Context, page *ChannelEventPage, events []channelDeliveryEvent, user string) error {
	for _, e := range events {
		page.Cursor = e.Sequence
		if e.Recipient.Valid && e.Recipient.String != user {
			continue
		}
		data, loadErr := s.deliveryPayload(ctx, e)
		if loadErr != nil {
			return loadErr
		}
		if data != nil {
			e.Data = data
			page.Events = append(page.Events, e)
		}
	}
	return nil
}
