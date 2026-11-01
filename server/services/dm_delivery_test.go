package services

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

type dmEventCapture struct {
	mu     sync.Mutex
	events []ws.Event
}

func (c *dmEventCapture) add(_ string, event ws.Event) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.events = append(c.events, event)
}
func (c *dmEventCapture) read() []ws.Event {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]ws.Event(nil), c.events...)
}

func dmOutboxFixture(t *testing.T) (*dmService, *sql.DB, *models.DMChannel, *dmEventCapture) {
	t.Helper()
	if os.Getenv("HICHAT_TEST_POSTGRES_DSN") == "" {
		t.Skip("requires isolated local PostgreSQL")
	}
	db := newDMSendTestDB(t)
	for _, id := range []string{"alice", "bob", "carol"} {
		if _, err := db.Conn.Exec(`INSERT INTO users(id,username,password_hash) VALUES(?,?,'x')`, id, id); err != nil {
			t.Fatal(err)
		}
	}
	repo := repository.NewSQLiteDMRepo(db.Conn)
	ch := &models.DMChannel{User1ID: "alice", User2ID: "bob", Status: models.DMStatusAccepted}
	if err := repo.CreateChannel(context.Background(), ch); err != nil {
		t.Fatal(err)
	}
	captured := &dmEventCapture{}
	hub := &testutil.MockBroadcaster{BroadcastToUserFn: captured.add}
	service := NewDMService(repo, repository.NewSQLiteUserRepo(db.Conn), hub, nil, nil, nil, repository.NewSQLiteDMReadRepo(db.Conn), repository.NewSQLiteNotificationRepo(db.Conn), repository.NewDMMessageTxRunner(db.Conn))
	ConfigureDMDelivery(service, db.Conn)
	return service.(*dmService), db.Conn, ch, captured
}

func sendDMOutboxFixture(t *testing.T, s *dmService, ch string) *models.DMMessage {
	t.Helper()
	m, err := s.SendMessage(context.Background(), "alice", ch, &models.CreateDMMessageRequest{Content: "local fixture", ClientMessageID: "outbox-request-00001"})
	if err != nil {
		t.Fatal(err)
	}
	return m
}
func drainDMOutbox(t *testing.T, s *dmService, db *sql.DB) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		s.dmDeliveryTick(context.Background())
		var n int
		if err := db.QueryRow(`SELECT COUNT(*) FROM dm_delivery_outbox WHERE published_at IS NULL`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n == 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("DM outbox did not drain")
}

func TestDMOutboxCommitRecoveryReplayAndAuthorization(t *testing.T) {
	s, db, ch, events := dmOutboxFixture(t)
	m := sendDMOutboxFixture(t, s, ch.ID)
	s.dmDeliveryTick(context.Background())
	if len(events.read()) != 0 {
		t.Fatal("published before attachment completion fence")
	}
	stop, err := StartDMDelivery(context.Background(), s)
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	deadline := time.Now().Add(4 * time.Second)
	for len(events.read()) < 4 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	stop()
	first := events.read()
	var original string
	for _, e := range first {
		if e.Op == ws.OpDMMessageCreate {
			original = e.EventID
			if e.DMSequence <= 0 || !strings.HasPrefix(original, "dm:") {
				t.Fatal("missing durable identity")
			}
		}
	}
	if original == "" {
		t.Fatal("committed create was lost across recovery")
	}
	if _, err := db.Exec(`UPDATE dm_delivery_outbox SET published_at=NULL,lease_until=CURRENT_TIMESTAMP+INTERVAL '1 day' WHERE message_id=? AND op='dm_message_create'`, m.ID); err != nil {
		t.Fatal(err)
	}
	restart, err := StartDMDelivery(context.Background(), s)
	if err != nil {
		t.Fatal(err)
	}
	deadline = time.Now().Add(4 * time.Second)
	for len(events.read()) < len(first)+2 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	restart()
	replayed := events.read()
	if len(replayed) < len(first)+2 {
		t.Fatal("lease did not recover")
	}
	if replayed[len(first)].EventID != original {
		t.Fatal("replayed event changed identity")
	}
	for _, user := range []string{"alice", "bob"} {
		page, err := s.GetDMEvents(context.Background(), user, ch.ID, 0)
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, e := range page.Events {
			found = found || e.ID == original
		}
		if !found {
			t.Fatal("REST catch-up lost websocket identity")
		}
	}
	if _, err := s.GetDMEvents(context.Background(), "carol", ch.ID, 0); !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("outsider replay=%v", err)
	}
}

type unavailableDMReader struct {
	repository.DMRepository
	fail bool
}

func (r *unavailableDMReader) GetMessageByID(ctx context.Context, id string) (*models.DMMessage, error) {
	if r.fail {
		return nil, errors.New("fixture temporary read failure")
	}
	return r.DMRepository.GetMessageByID(ctx, id)
}

func TestDMOutboxRetryOrderingDeletionAndRetention(t *testing.T) {
	s, db, ch, events := dmOutboxFixture(t)
	m := sendDMOutboxFixture(t, s, ch.ID)
	s.BroadcastCreate(m)
	reader := &unavailableDMReader{DMRepository: s.dmRepo, fail: true}
	s.dmRepo = reader
	s.dmDeliveryTick(context.Background())
	if len(events.read()) != 0 {
		t.Fatal("failed head was bypassed")
	}
	var attempts int
	var lastError sql.NullString
	if err := db.QueryRow(`SELECT attempts,last_error FROM dm_delivery_outbox WHERE op='dm_message_create'`).Scan(&attempts, &lastError); err != nil {
		t.Fatal(err)
	}
	if attempts != 1 || !lastError.Valid {
		t.Fatal("transient failure was not durably scheduled")
	}
	reader.fail = false
	if _, err := db.Exec(`UPDATE dm_delivery_outbox SET available_at=CURRENT_TIMESTAMP`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.EditMessage(context.Background(), "alice", m.ID, &models.UpdateDMMessageRequest{Content: "edited fixture"}); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteMessage(context.Background(), "alice", m.ID); err != nil {
		t.Fatal(err)
	}
	drainDMOutbox(t, s, db)
	for _, e := range events.read() {
		if e.Op == ws.OpDMMessageCreate || e.Op == ws.OpDMMessageUpdate {
			t.Fatal("deleted content resurrected")
		}
	}
	page, err := s.GetDMEvents(context.Background(), "bob", ch.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, e := range page.Events {
		if e.Op == ws.OpDMMessageDelete {
			var body map[string]string
			if err := json.Unmarshal(e.Payload, &body); err != nil {
				t.Fatal(err)
			}
			found = body["id"] == m.ID
		}
	}
	if !found {
		t.Fatal("deletion missing from catch-up")
	}
	if _, err := db.Exec(`UPDATE dm_delivery_outbox SET created_at=CURRENT_TIMESTAMP-INTERVAL '8 days'`); err != nil {
		t.Fatal(err)
	}
	s.cleanDMDelivery(context.Background())
	page, err = s.GetDMEvents(context.Background(), "bob", ch.ID, 0)
	if err != nil || !page.Reset {
		t.Fatalf("expired cursor reset=%v err=%v", page, err)
	}
}

func TestDMOutboxTransactionRollbackAndChannelCascade(t *testing.T) {
	s, db, ch, _ := dmOutboxFixture(t)
	if _, err := db.Exec(`CREATE FUNCTION reject_dm_outbox_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture rollback'; END $$; CREATE TRIGGER reject_dm_outbox_fixture BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION reject_dm_outbox_fixture()`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SendMessage(context.Background(), "alice", ch.ID, &models.CreateDMMessageRequest{Content: "must roll back", ClientMessageID: "outbox-request-00001"}); err == nil {
		t.Fatal("expected failed transaction")
	}
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM dm_delivery_outbox`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("rolled-back event count=%d err=%v", n, err)
	}
	if _, err := db.Exec(`DROP TRIGGER reject_dm_outbox_fixture ON notifications`); err != nil {
		t.Fatal(err)
	}
	sendDMOutboxFixture(t, s, ch.ID)
	if err := s.dmRepo.DeleteChannel(context.Background(), ch.ID); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM dm_delivery_outbox`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("deleted channel retained events=%d err=%v", n, err)
	}
}

func TestDMOutboxRetainsInitialEnvelopeBeforeQueuedEditAndErasesDeletedSnapshots(t *testing.T) {
	s, db, ch, captured := dmOutboxFixture(t)
	ctx := context.Background()
	initial, device := "initial-prekey-envelope", "local-device"
	m, err := s.SendMessage(ctx, "alice", ch.ID, &models.CreateDMMessageRequest{EncryptionVersion: 1, Ciphertext: &initial, SenderDeviceID: &device, ClientMessageID: "outbox-envelope-0001"})
	if err != nil {
		t.Fatal(err)
	}
	edited := "next-ratchet-envelope"
	if _, err := s.EditMessage(ctx, "alice", m.ID, &models.UpdateDMMessageRequest{EncryptionVersion: 1, Ciphertext: &edited, SenderDeviceID: &device}); err != nil {
		t.Fatal(err)
	}
	s.BroadcastCreate(m)
	drainDMOutbox(t, s, db)
	for _, event := range captured.read() {
		if event.Op != ws.OpDMMessageCreate && event.Op != ws.OpDMMessageUpdate {
			continue
		}
		raw, ok := event.Data.(json.RawMessage)
		if !ok {
			t.Fatal("wire payload missing")
		}
		var body models.DMMessage
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Fatal(err)
		}
		want := initial
		if event.Op == ws.OpDMMessageUpdate {
			want = edited
		}
		if body.Ciphertext == nil || *body.Ciphertext != want {
			t.Fatal("queued ciphertext changed before dispatch")
		}
	}
	if err := s.DeleteMessage(ctx, "alice", m.ID); err != nil {
		t.Fatal(err)
	}
	var retained int
	if err := db.QueryRow(`SELECT COUNT(*) FROM dm_delivery_outbox WHERE message_id=? AND payload<>'{}'::jsonb`, m.ID).Scan(&retained); err != nil || retained != 0 {
		t.Fatalf("deleted content snapshots=%d err=%v", retained, err)
	}
}

func TestDMOutboxCompletionFailureRetriesWithoutAnotherMessage(t *testing.T) {
	s, db, ch, events := dmOutboxFixture(t)
	m := sendDMOutboxFixture(t, s, ch.ID)
	ctx := context.Background()
	if _, err := db.Exec(`CREATE FUNCTION reject_dm_ready_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture completion failure'; END $$; CREATE TRIGGER reject_dm_ready_fixture BEFORE UPDATE OF ready ON dm_delivery_outbox FOR EACH ROW WHEN (NOT OLD.ready AND NEW.ready) EXECUTE FUNCTION reject_dm_ready_fixture()`); err != nil {
		t.Fatal(err)
	}
	if err := s.FinalizeDMCreate(ctx, m); !errors.Is(err, pkg.ErrInternal) {
		t.Fatalf("completion error=%v", err)
	}
	s.dmDeliveryTick(ctx)
	if len(events.read()) != 0 {
		t.Fatal("failed completion published events")
	}
	if _, err := db.Exec(`DROP TRIGGER reject_dm_ready_fixture ON dm_delivery_outbox`); err != nil {
		t.Fatal(err)
	}
	retry := sendDMOutboxFixture(t, s, ch.ID)
	if retry.ID != m.ID || !retry.SendReplayed {
		t.Fatal("completion retry created another message")
	}
	if err := s.FinalizeDMCreate(ctx, retry); err != nil {
		t.Fatal(err)
	}
	drainDMOutbox(t, s, db)
}

func TestDMOutboxStartupRecoveryFailsClosed(t *testing.T) {
	s, db, _, _ := dmOutboxFixture(t)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	stop, err := StartDMDelivery(context.Background(), s)
	defer stop()
	if err == nil {
		t.Fatal("worker accepted failed startup recovery")
	}
}
