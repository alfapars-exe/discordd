package services

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io/fs"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
)

type integrationCategorySender struct {
	to, subject, body string
	sends             int
}

func (s *integrationCategorySender) SendCategoryEmail(_ context.Context, to, subject, body string) error {
	s.sends++
	s.to, s.subject, s.body = to, subject, body
	return nil
}

func TestEmailDeliveryAndUnsubscribeSQLiteIntegration(t *testing.T) {
	migrations, err := fs.Sub(database.EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatalf("migration sub-FS: %v", err)
	}
	db, err := database.NewLegacy(filepath.Join(t.TempDir(), "email_delivery_integration.db"), migrations)
	if err != nil {
		t.Fatalf("open SQLite test database: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	ctx := context.Background()
	if _, err = db.Conn.ExecContext(ctx, `INSERT INTO users(id,username,password_hash,email,email_verified_at) VALUES(?,?,?,?,?)`, "integration-user", "integration-user", "x", "integration@example.test", 1); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if _, err = db.Conn.ExecContext(ctx, `INSERT INTO user_preferences(user_id,data) VALUES(?,?)`, "integration-user", `{"email_preferences":{"social":true,"communication":true},"theme":"dark"}`); err != nil {
		t.Fatalf("seed preferences: %v", err)
	}

	queue := repository.NewSQLiteEmailDeliveryRepo(db.Conn)
	unsub := repository.NewSQLiteEmailUnsubscribeRepo(db.Conn)
	sender := &integrationCategorySender{}
	service := NewEmailDeliveryService(queue, sender, WithEmailUnsubscribe(unsub, "https://app.example.test"))
	const originalBody = `<p>Friend request update</p>`
	queued, err := service.Enqueue(ctx, "integration-user", models.EmailCategorySocial, "social-event-1", "Friend update", originalBody)
	if err != nil || !queued {
		t.Fatalf("enqueue social email = %v, %v", queued, err)
	}
	now := time.Now().UTC().Add(time.Minute).Truncate(time.Second)
	delivered, err := service.DeliverBatch(ctx, now)
	if err != nil || delivered != 1 || sender.sends != 1 {
		t.Fatalf("delivery batch = delivered %d, sends %d, err %v", delivered, sender.sends, err)
	}
	if sender.to != "integration@example.test" || sender.subject != "Friend update" || !strings.HasPrefix(sender.body, originalBody) {
		t.Fatalf("unexpected sent message: to=%q subject=%q body=%q", sender.to, sender.subject, sender.body)
	}
	if got, err := db.Conn.QueryContext(ctx, `SELECT body_html,status FROM email_delivery_jobs WHERE user_id=? AND dedupe_key=?`, "integration-user", "social-event-1"); err != nil {
		t.Fatal(err)
	} else {
		defer got.Close()
		if !got.Next() {
			t.Fatal("delivered job missing")
		}
		var storedBody, status string
		if err = got.Scan(&storedBody, &status); err != nil {
			t.Fatal(err)
		}
		if storedBody != originalBody || status != "delivered" {
			t.Fatalf("queued job mutated: body=%q status=%q", storedBody, status)
		}
	}
	const marker = `href="`
	linkStart := strings.Index(sender.body, marker)
	if linkStart < 0 {
		t.Fatalf("unsubscribe link missing from email: %q", sender.body)
	}
	linkStart += len(marker)
	linkEnd := strings.IndexByte(sender.body[linkStart:], '"')
	if linkEnd < 0 {
		t.Fatalf("unterminated unsubscribe link in email: %q", sender.body)
	}
	link, err := url.Parse(sender.body[linkStart : linkStart+linkEnd])
	if err != nil {
		t.Fatalf("parse unsubscribe link: %v", err)
	}
	token := link.Query().Get("token")
	if token == "" || link.Path != "/api/email/unsubscribe" {
		t.Fatalf("invalid unsubscribe link: %q", link)
	}
	state, err := unsub.Inspect(ctx, token, now.Add(time.Second))
	if err != nil || state.Category != models.EmailCategorySocial || state.Consumed {
		t.Fatalf("inspect issued token = %#v, %v", state, err)
	}
	if err = unsub.Consume(ctx, token, now.Add(2*time.Second)); err != nil {
		t.Fatalf("consume issued token: %v", err)
	}
	if state, err = unsub.Inspect(ctx, token, now.Add(3*time.Second)); err != nil || !state.Consumed {
		t.Fatalf("inspect consumed token = %#v, %v", state, err)
	}

	if queued, err = service.Enqueue(ctx, "integration-user", models.EmailCategorySocial, "social-event-2", "Another update", originalBody); err != nil || queued {
		t.Fatalf("social enqueue after unsubscribe = %v, %v; want rejected", queued, err)
	}
	if queued, err = service.Enqueue(ctx, "integration-user", models.EmailCategoryCommunication, "security-event-1", "Security notice", originalBody); err != nil || !queued {
		t.Fatalf("unrelated communication category should remain enabled: %v, %v", queued, err)
	}
	var storedHash string
	if err = db.Conn.QueryRowContext(ctx, `SELECT token_hash FROM email_unsubscribe_tokens WHERE user_id=? AND category=?`, "integration-user", models.EmailCategorySocial).Scan(&storedHash); err != nil {
		t.Fatalf("read stored token hash: %v", err)
	}
	// The repository hashes the decoded 32-byte base64url proof, not its text.
	decoded, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil {
		t.Fatalf("decode unsubscribe token: %v", err)
	}
	hash := sha256.Sum256(decoded)
	if storedHash == token || storedHash != hex.EncodeToString(hash[:]) {
		t.Fatalf("stored token hash does not match proof hash (or raw token stored): %q", storedHash)
	}
	const claimToken = "lease-claim-token-secret"
	jobJSON, err := json.Marshal(models.EmailDeliveryJob{ID: "job", ClaimToken: claimToken})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(jobJSON), "claim_token") || strings.Contains(string(jobJSON), claimToken) {
		t.Fatalf("claim token serialized: %s", jobJSON)
	}
}

func TestUnreadConversationDigestSQLiteIntegration(t *testing.T) {
	migrations, err := fs.Sub(database.EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatal(err)
	}
	db, err := database.NewLegacy(filepath.Join(t.TempDir(), "digest.db"), migrations)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	ctx := context.Background()
	if _, err = db.Conn.ExecContext(ctx, `
		INSERT INTO users(id,username,password_hash,email,email_verified_at) VALUES('sender','private-name','x','sender@example.test',1),('owner','owner','x','owner@example.test',1);
		INSERT INTO dm_channels(id,user1_id,user2_id,status) VALUES('conversation','sender','owner','accepted');
		INSERT INTO dm_messages(id,dm_channel_id,user_id,content,created_at) VALUES('first','conversation','sender','secret-one','2026-10-24 01:00:00'),('second','conversation','sender','secret-two','2026-10-24 01:01:00');
		INSERT INTO dm_reads(user_id,dm_channel_id,last_read_message_id,unread_count) VALUES('owner','conversation',NULL,2);
	`); err != nil {
		t.Fatal(err)
	}
	queue := repository.NewSQLiteEmailDeliveryRepo(db.Conn)
	sender := &integrationCategorySender{}
	service := NewEmailDeliveryService(queue, sender, WithEmailUnsubscribe(repository.NewSQLiteEmailUnsubscribeRepo(db.Conn), "https://app.example.test"))
	now := time.Now().UTC()
	for _, id := range []string{"first", "second"} {
		queued, err := service.EnqueueWithOptions(ctx, "owner", models.EmailCategoryCommunication, "unread-dm:"+id, "Generic", "<p>Generic notice</p>", EmailEnqueueOptions{DMMessageID: id, ExpiresAt: now.Add(time.Hour)})
		if err != nil || !queued {
			t.Fatalf("enqueue=%v,%v", queued, err)
		}
	}
	done, err := service.DeliverBatch(ctx, now.Add(time.Minute))
	if err != nil || done != 1 || sender.sends != 1 {
		t.Fatalf("done=%d sends=%d err=%v", done, sender.sends, err)
	}
	if !strings.Contains(sender.body, "2 unread messages") || !strings.Contains(sender.body, "/api/email/unsubscribe?token=") {
		t.Fatalf("missing digest/footer: %s", sender.body)
	}
	for _, secret := range []string{"secret-one", "secret-two", "private-name", "first", "second"} {
		if strings.Contains(sender.body, secret) {
			t.Fatalf("digest leaked %s", secret)
		}
	}
	var delivered, cancelled int
	if err := db.Conn.QueryRowContext(ctx, `SELECT COUNT(*) FROM email_delivery_jobs WHERE status='delivered'`).Scan(&delivered); err != nil {
		t.Fatal(err)
	}
	if err := db.Conn.QueryRowContext(ctx, `SELECT COUNT(*) FROM email_delivery_jobs WHERE status='cancelled'`).Scan(&cancelled); err != nil {
		t.Fatal(err)
	}
	if delivered != 1 || cancelled != 1 {
		t.Fatalf("delivery rows=%d cancelled=%d", delivered, cancelled)
	}
}
