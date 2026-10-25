package repository

import (
	"context"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
)

func TestHardDeleteUserRemovesServerEventForeignKeyDependentsWithoutForeignKeys(t *testing.T) {
	db, path := newTestDBWithPath(t)
	ctx := context.Background()
	users := NewSQLiteUserRepo(db.Conn)
	admin := &models.User{Username: "event-delete-admin", Status: "online"}
	victim := &models.User{Username: "event-delete-victim", Status: "online"}
	other := &models.User{Username: "event-delete-other", Status: "online"}
	for _, user := range []*models.User{admin, victim, other} {
		if err := users.Create(ctx, user); err != nil {
			t.Fatalf("create %s: %v", user.Username, err)
		}
	}
	servers := NewSQLiteServerRepo(db.Conn)
	server := &models.Server{Name: "Event cleanup fixture", OwnerID: admin.ID}
	if err := servers.Create(ctx, server); err != nil {
		t.Fatal(err)
	}
	for _, memberID := range []string{admin.ID, victim.ID, other.ID} {
		if err := servers.AddMember(ctx, server.ID, memberID); err != nil {
			t.Fatalf("add member %s: %v", memberID, err)
		}
	}
	events := NewSQLiteServerEventRepo(db.Conn)
	createEvent := func(creatorID, name string) *models.ServerEvent {
		t.Helper()
		event := &models.ServerEvent{
			ServerID: server.ID, CreatorID: creatorID, Name: name,
			StartsAt: time.Now().UTC().Add(24 * time.Hour).Format(time.RFC3339Nano),
		}
		if err := events.Create(ctx, event); err != nil {
			t.Fatalf("create %s: %v", name, err)
		}
		return event
	}
	victimEvent := createEvent(victim.ID, "Victim-authored event")
	otherEvent := createEvent(other.ID, "Other-authored event")
	if _, err := db.Conn.ExecContext(ctx, `INSERT INTO email_unsubscribe_tokens(token_hash,user_id,category,email_generation,issued_at,expires_at) VALUES
		('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',?,'social',0,1800000000,1802592000),
		('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',?,'social',0,1800000000,1802592000)`, victim.ID, other.ID); err != nil {
		t.Fatal("seed unsubscribe tokens:", err)
	}
	for _, event := range []*models.ServerEvent{victimEvent, otherEvent} {
		for _, attendeeID := range []string{victim.ID, other.ID} {
			if err := events.SetInterested(ctx, event.ID, attendeeID, true); err != nil {
				t.Fatalf("RSVP %s to %s: %v", attendeeID, event.ID, err)
			}
			if _, err := db.Conn.ExecContext(ctx, `INSERT INTO server_event_deliveries(event_id,user_id,starts_at)
				SELECT id,?,starts_at FROM server_events WHERE id=?`, attendeeID, event.ID); err != nil {
				t.Fatalf("seed delivery for %s to %s: %v", event.ID, attendeeID, err)
			}
		}
	}

	// This connection disables FK/triggers like remote libSQL/Turso. HardDelete
	// must therefore reproduce the schema's ON DELETE CASCADE behavior itself.
	if err := NewSQLiteUserRepo(entranceFKOffConn(t, path)).HardDeleteUser(ctx, victim.ID, admin.ID); err != nil {
		t.Fatalf("HardDeleteUser: %v", err)
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM users WHERE id=?`, victim.ID); got != 0 {
		t.Fatalf("victim user rows = %d, want 0", got)
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM email_unsubscribe_tokens WHERE user_id=?`, victim.ID); got != 0 {
		t.Errorf("victim unsubscribe tokens = %d, want 0", got)
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM email_unsubscribe_tokens WHERE user_id=?`, other.ID); got != 1 {
		t.Errorf("other user's unsubscribe tokens = %d, want 1", got)
	}
	for _, query := range []string{
		`SELECT COUNT(*) FROM server_events WHERE id=?`,
		`SELECT COUNT(*) FROM server_event_rsvps WHERE event_id=?`,
		`SELECT COUNT(*) FROM server_event_deliveries WHERE event_id=?`,
	} {
		if got := countRows(t, db, query, victimEvent.ID); got != 0 {
			t.Errorf("victim-authored event descendant survived (%s): %d", query, got)
		}
	}
	for _, item := range []struct {
		query string
		args  []any
		want  int
	}{
		{`SELECT COUNT(*) FROM server_events WHERE id=?`, []any{otherEvent.ID}, 1},
		{`SELECT COUNT(*) FROM server_event_rsvps WHERE event_id=? AND user_id=?`, []any{otherEvent.ID, victim.ID}, 0},
		{`SELECT COUNT(*) FROM server_event_deliveries WHERE event_id=? AND user_id=?`, []any{otherEvent.ID, victim.ID}, 0},
		{`SELECT COUNT(*) FROM server_event_rsvps WHERE event_id=? AND user_id=?`, []any{otherEvent.ID, other.ID}, 1},
		{`SELECT COUNT(*) FROM server_event_deliveries WHERE event_id=? AND user_id=?`, []any{otherEvent.ID, other.ID}, 1},
	} {
		if got := countRows(t, db, item.query, item.args...); got != item.want {
			t.Errorf("event data %s = %d, want %d", item.query, got, item.want)
		}
	}
}
