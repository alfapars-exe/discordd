package services

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/ws"
	"strconv"
	"time"
)

// ConfigureDMDelivery binds publication to the database's singleton backend owner.
func ConfigureDMDelivery(service DMService, db *sql.DB) {
	if s, ok := service.(*dmService); ok && s.deliveryDB == nil && database.IsPostgres(db) {
		s.deliveryDB = db
		s.deliveryHub = s.hub
		s.hub = dmDurableHub{s.hub}
	}
}

func durableDMOperation(op string) bool {
	switch op {
	case ws.OpDMMessageCreate, ws.OpDMMessageUpdate, ws.OpDMMessageDelete, ws.OpDMMessagePin, ws.OpDMMessageUnpin, ws.OpDMReactionUpdate, ws.OpDMChannelStatusChange, ws.OpDMRead, "dm_channel_update":
		return true
	}
	return false
}

type dmDurableHub struct{ ws.Broadcaster }

func (h dmDurableHub) BroadcastToUser(user string, event ws.Event) {
	if durableDMOperation(event.Op) {
		return
	}
	if event.Op == ws.OpNotificationCreate {
		if n, ok := event.Data.(*models.Notification); ok && n.DMChannelID != nil {
			return
		}
	}
	h.Broadcaster.BroadcastToUser(user, event)
}

// StartDMDelivery runs only after backend ownership acquisition and before HTTP serving.
// Acknowledgment means dispatch to the hub, not a physical device receipt.
func StartDMDelivery(parent context.Context, service DMService) (func(), error) {
	s, ok := service.(*dmService)
	if !ok || s.deliveryDB == nil {
		return func() {}, nil
	}
	ctx, cancel := context.WithCancel(parent)
	done := make(chan struct{})
	recovery, stop := context.WithTimeout(ctx, 10*time.Second)
	if _, err := s.deliveryDB.ExecContext(recovery, `UPDATE dm_delivery_outbox SET ready=TRUE,lease_until=NULL WHERE published_at IS NULL`); err != nil {
		stop()
		cancel()
		return func() {}, errors.New("DM outbox startup recovery failed")
	}
	stop()
	go func() {
		defer close(done)
		ticker := time.NewTicker(500 * time.Millisecond)
		defer ticker.Stop()
		preparations := time.NewTicker(30 * time.Second)
		defer preparations.Stop()
		retention := time.NewTicker(5 * time.Minute)
		defer retention.Stop()
		for {
			if ctx.Err() != nil {
				return
			}
			s.dmDeliveryTick(ctx)
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			case <-preparations.C:
				s.recoverDMPreparations(ctx)
			case <-retention.C:
				s.cleanDMDelivery(ctx)
			}
		}
	}()
	return func() { cancel(); <-done }, nil
}

// FinalizeDMCreate releases attachment preparation atomically before HTTP success.
func (s *dmService) FinalizeDMCreate(ctx context.Context, message *models.DMMessage) error {
	if s.deliveryDB == nil || message.DeliveryReady {
		return nil
	}
	if _, err := s.deliveryDB.ExecContext(ctx, `UPDATE dm_delivery_outbox SET ready=TRUE WHERE message_id=? AND NOT ready`, message.ID); err != nil {
		return fmt.Errorf("%w: DM outbox completion failed", pkg.ErrInternal)
	}
	message.DeliveryReady = true
	return nil
}

type dmDeliveryEvent struct {
	ID        string          `json:"event_id"`
	Channel   string          `json:"dm_channel_id"`
	Sequence  int64           `json:"dm_sequence,string"`
	Message   sql.NullString  `json:"-"`
	Op        string          `json:"op"`
	Recipient sql.NullString  `json:"-"`
	Payload   json.RawMessage `json:"d,omitempty"`
}

func (s *dmService) dmDeliveryTick(parent context.Context) {
	ctx, cancel := context.WithTimeout(parent, 10*time.Second)
	defer cancel()
	for range 64 {
		if !s.deliverNextDM(ctx) {
			break
		}
	}
}

func (s *dmService) recoverDMPreparations(parent context.Context) {
	ctx, cancel := context.WithTimeout(parent, 10*time.Second)
	defer cancel()
	if _, err := s.deliveryDB.ExecContext(ctx, `UPDATE dm_delivery_outbox SET ready=TRUE WHERE NOT ready AND created_at<CURRENT_TIMESTAMP-INTERVAL '30 minutes'`); err != nil {
		dmLogger.Error("DM outbox preparation recovery failed")
	}
}

func (s *dmService) cleanDMDelivery(parent context.Context) {
	ctx, cancel := context.WithTimeout(parent, 10*time.Second)
	defer cancel()
	if _, err := s.deliveryDB.ExecContext(ctx, `DELETE FROM dm_delivery_outbox WHERE published_at IS NOT NULL AND created_at<CURRENT_TIMESTAMP-INTERVAL '7 days'`); err != nil {
		dmLogger.Error("DM outbox retention failed")
	}
}

func (s *dmService) deliverNextDM(ctx context.Context) bool {
	var e dmDeliveryEvent
	var payload string
	err := s.deliveryDB.QueryRowContext(ctx, `UPDATE dm_delivery_outbox SET lease_until=CURRENT_TIMESTAMP+INTERVAL '30 seconds',attempts=attempts+1 WHERE event_id=(SELECT e.event_id FROM dm_delivery_outbox e WHERE e.published_at IS NULL AND e.ready AND e.available_at<=CURRENT_TIMESTAMP AND (e.lease_until IS NULL OR e.lease_until<CURRENT_TIMESTAMP) AND NOT EXISTS(SELECT 1 FROM dm_delivery_outbox p WHERE p.dm_channel_id=e.dm_channel_id AND p.dm_sequence<e.dm_sequence AND p.published_at IS NULL) ORDER BY e.event_id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING event_id::text,dm_channel_id,dm_sequence,message_id,op,recipient_id,payload::text`).Scan(&e.ID, &e.Channel, &e.Sequence, &e.Message, &e.Op, &e.Recipient, &payload)
	if errors.Is(err, sql.ErrNoRows) {
		return false
	}
	if err != nil {
		dmLogger.Error("DM outbox claim failed")
		return false
	}
	e.Payload = json.RawMessage(payload)
	if err = s.publishDMDelivery(ctx, e); err != nil {
		_, retryErr := s.deliveryDB.ExecContext(ctx, `UPDATE dm_delivery_outbox SET lease_until=NULL,available_at=CURRENT_TIMESTAMP+LEAST(attempts::bigint*attempts,300)*INTERVAL '1 second',last_error='publication failed' WHERE event_id=?`, e.ID)
		if retryErr != nil {
			dmLogger.Error("DM outbox retry scheduling failed")
		}
		return true
	}
	if _, err = s.deliveryDB.ExecContext(ctx, `UPDATE dm_delivery_outbox SET published_at=CURRENT_TIMESTAMP,lease_until=NULL,last_error=NULL WHERE event_id=?`, e.ID); err != nil {
		dmLogger.Error("DM outbox acknowledgement failed")
	}
	return true
}

func (s *dmService) publishDMDelivery(ctx context.Context, e dmDeliveryEvent) error {
	channel, err := s.dmRepo.GetChannelByID(ctx, e.Channel)
	if errors.Is(err, pkg.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if e.Recipient.Valid && e.Recipient.String != channel.User1ID && e.Recipient.String != channel.User2ID {
		return nil
	}
	data, err := s.dmDeliveryPayload(ctx, e, channel)
	if err != nil || data == nil {
		return err
	}
	event := ws.Event{EventID: "dm:" + e.ID, DMSequence: e.Sequence, Op: e.Op, Data: json.RawMessage(data)}
	if e.Recipient.Valid {
		s.deliveryHub.BroadcastToUser(e.Recipient.String, event)
		return nil
	}
	s.deliveryHub.BroadcastToUser(channel.User1ID, event)
	if channel.User1ID != channel.User2ID {
		s.deliveryHub.BroadcastToUser(channel.User2ID, event)
	}
	return nil
}

func (s *dmService) dmDeliveryPayload(ctx context.Context, e dmDeliveryEvent, ch *models.DMChannel) ([]byte, error) {
	switch e.Op {
	case ws.OpNotificationCreate:
		return s.dmNotificationPayload(ctx, e, ch)
	case ws.OpDMChannelStatusChange:
		return json.Marshal(map[string]any{"dm_channel_id": ch.ID, "status": ch.Status, "initiated_by": ch.InitiatedBy})
	case "dm_channel_update":
		return json.Marshal(ch)
	case ws.OpDMRead:
		var cursor *string
		var count int
		err := s.deliveryDB.QueryRowContext(ctx, `SELECT last_read_message_id,unread_count FROM dm_reads WHERE user_id=? AND dm_channel_id=?`, e.Recipient.String, ch.ID).Scan(&cursor, &count)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		return json.Marshal(map[string]any{"dm_channel_id": ch.ID, "user_id": e.Recipient.String, "last_read_message_id": cursor, "unread_count": count})
	case ws.OpDMMessageDelete:
		return json.Marshal(map[string]string{"id": e.Message.String, "dm_channel_id": ch.ID})
	}
	return s.dmMessagePayload(ctx, e, ch)
}

func (s *dmService) dmMessagePayload(ctx context.Context, e dmDeliveryEvent, ch *models.DMChannel) ([]byte, error) {
	msg, err := s.dmRepo.GetMessageByID(ctx, e.Message.String)
	if errors.Is(err, pkg.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if msg.DMChannelID != ch.ID {
		return nil, fmt.Errorf("DM event scope mismatch")
	}
	messages := []models.DMMessage{*msg}
	if err = s.enrichMessages(ctx, messages); err != nil {
		return nil, err
	}
	msg = &messages[0]
	if e.Op == ws.OpDMMessageCreate || e.Op == ws.OpDMMessageUpdate {
		var snapshot models.DMMessage
		if err := json.Unmarshal(e.Payload, &snapshot); err != nil {
			return nil, err
		}
		msg.Content = snapshot.Content
		msg.Ciphertext = snapshot.Ciphertext
		msg.SenderDeviceID = snapshot.SenderDeviceID
		msg.E2EEMetadata = snapshot.E2EEMetadata
		msg.EncryptionVersion = snapshot.EncryptionVersion
		msg.EditedAt = snapshot.EditedAt
	}
	switch e.Op {
	case ws.OpDMReactionUpdate:
		return json.Marshal(map[string]any{"dm_message_id": msg.ID, "dm_channel_id": ch.ID, "reactions": msg.Reactions})
	case ws.OpDMMessagePin:
		if !msg.IsPinned {
			return nil, nil
		}
		return json.Marshal(map[string]any{"dm_channel_id": ch.ID, "message": msg})
	case ws.OpDMMessageUnpin:
		if msg.IsPinned {
			return nil, nil
		}
		return json.Marshal(map[string]any{"dm_channel_id": ch.ID, "message_id": msg.ID})
	}
	return json.Marshal(msg)
}

func (s *dmService) dmNotificationPayload(ctx context.Context, e dmDeliveryEvent, ch *models.DMChannel) ([]byte, error) {
	if e.Message.Valid {
		msg, err := s.dmRepo.GetMessageByID(ctx, e.Message.String)
		if errors.Is(err, pkg.ErrNotFound) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		if msg.DMChannelID != ch.ID {
			return nil, fmt.Errorf("DM notification source mismatch")
		}
	}
	return hydrateDeliveryNotification(ctx, s.deliveryDB, s.userRepo, e.Payload)
}

type DMEventPage struct {
	Events  []dmDeliveryEvent `json:"events"`
	Cursor  string            `json:"cursor"`
	HasMore bool              `json:"has_more"`
	Reset   bool              `json:"reset"`
}
type DMEventReplayService interface {
	GetDMEvents(context.Context, string, string, int64) (*DMEventPage, error)
}

func (s *dmService) GetDMEvents(ctx context.Context, user, channel string, after int64) (*DMEventPage, error) {
	ch, err := s.verifyChannelMembership(ctx, user, channel)
	if err != nil {
		return nil, err
	}
	if s.deliveryDB == nil {
		return nil, fmt.Errorf("%w: durable DM events unavailable", pkg.ErrNotFound)
	}
	page := &DMEventPage{Events: []dmDeliveryEvent{}, Cursor: strconv.FormatInt(after, 10)}
	var latest, floor int64
	if err = s.deliveryDB.QueryRowContext(ctx, `SELECT last_event_sequence,COALESCE((SELECT MIN(dm_sequence) FROM dm_delivery_outbox WHERE dm_channel_id=? AND created_at>=CURRENT_TIMESTAMP-INTERVAL '7 days'),last_event_sequence+1) FROM dm_channels WHERE id=?`, channel, channel).Scan(&latest, &floor); err != nil {
		return nil, err
	}
	if after < 0 || after > latest || after < floor-1 {
		page.Reset = true
		page.Cursor = strconv.FormatInt(latest, 10)
		return page, nil
	}
	events, err := s.loadDMEvents(ctx, channel, after)
	if err != nil {
		return nil, err
	}
	page.HasMore = len(events) > 100
	if page.HasMore {
		events = events[:100]
	}
	if err = s.hydrateDMReplay(ctx, page, events, ch, user); err != nil {
		return nil, err
	}
	return page, nil
}

func (s *dmService) loadDMEvents(ctx context.Context, channel string, after int64) ([]dmDeliveryEvent, error) {
	rows, err := s.deliveryDB.QueryContext(ctx, `SELECT event_id::text,dm_sequence,message_id,op,recipient_id,payload::text FROM dm_delivery_outbox e WHERE dm_channel_id=? AND dm_sequence>? AND ready AND NOT EXISTS(SELECT 1 FROM dm_delivery_outbox p WHERE p.dm_channel_id=e.dm_channel_id AND p.dm_sequence<=e.dm_sequence AND NOT p.ready) ORDER BY dm_sequence LIMIT 101`, channel, after)
	if err != nil {
		return nil, err
	}
	var events []dmDeliveryEvent
	for rows.Next() {
		e := dmDeliveryEvent{Channel: channel}
		var data string
		if err = rows.Scan(&e.ID, &e.Sequence, &e.Message, &e.Op, &e.Recipient, &data); err != nil {
			rows.Close()
			return nil, err
		}
		e.Payload = json.RawMessage(data)
		events = append(events, e)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	return events, nil
}

func (s *dmService) hydrateDMReplay(ctx context.Context, page *DMEventPage, events []dmDeliveryEvent, ch *models.DMChannel, user string) error {
	for _, e := range events {
		page.Cursor = strconv.FormatInt(e.Sequence, 10)
		if e.Recipient.Valid && e.Recipient.String != user {
			continue
		}
		data, err := s.dmDeliveryPayload(ctx, e, ch)
		if err != nil {
			return err
		}
		if data != nil {
			e.ID = "dm:" + e.ID
			e.Payload = data
			page.Events = append(page.Events, e)
		}
	}
	return nil
}
