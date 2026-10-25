package repository

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/argeinfina/hichat/models"
)

func TestNotificationUnreadSummaryAuthoritativeBeyondPageAndReadIsolation(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	ctx := context.Background()
	dm := NewSQLiteDMRepo(wrapForRepo(db))
	channel := newDMChannel(t, ctx, dm, dmAlice, dmBob, models.DMStatusAccepted)
	repo := NewSQLiteNotificationRepo(wrapForRepo(db))
	summary := repo.(*sqliteNotificationRepo)
	assertCounts := func(owner string, inbox, badge int) {
		t.Helper()
		got, err := summary.CountUnreadSummary(ctx, owner)
		if err != nil || got.UnreadCount != inbox || got.BadgeUnreadCount != badge {
			t.Fatalf("summary owner=%s got=%+v err=%v want=(%d,%d)", owner, got, err, inbox, badge)
		}
	}
	assertCounts(dmBob, 0, 0)
	var firstDM, firstOrdinary string
	for i := 0; i < 60; i++ {
		message := newDMMessage(t, ctx, dm, channel.ID, dmAlice, fmt.Sprintf("private-body-%d", i))
		n := &models.Notification{UserID: dmBob, ActorID: &message.UserID, MessageID: &message.ID, DMChannelID: &channel.ID}
		if created, err := repo.CreateDMMessageIfAbsent(ctx, n); err != nil || !created {
			t.Fatalf("create canonical=(%v,%v)", created, err)
		}
		if i == 0 {
			firstDM = n.ID
		}
	}
	for i := 0; i < 55; i++ {
		n := &models.Notification{UserID: dmBob, Kind: models.NotificationKindMention, Payload: json.RawMessage(`{"source":"server"}`)}
		if err := repo.Create(ctx, n); err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			firstOrdinary = n.ID
		}
	}
	other := &models.Notification{UserID: dmAlice, Kind: models.NotificationKindSystem, Payload: json.RawMessage(`{}`)}
	if err := repo.Create(ctx, other); err != nil {
		t.Fatal(err)
	}
	assertCounts(dmBob, 115, 55)
	assertCounts(dmAlice, 1, 1)
	assertCounts("unknown-owner", 0, 0)
	page, err := repo.List(ctx, dmBob, "", true, 50)
	if err != nil || len(page) != 50 {
		t.Fatalf("first page len=%d err=%v", len(page), err)
	}
	assertCounts(dmBob, 115, 55)
	total := len(page)
	cursor := page[len(page)-1].ID
	for {
		page, err = repo.List(ctx, dmBob, cursor, true, 50)
		if err != nil {
			t.Fatal(err)
		}
		if len(page) == 0 {
			break
		}
		total += len(page)
		cursor = page[len(page)-1].ID
	}
	if total != 115 {
		t.Fatalf("fixture pagination=%d", total)
	}
	if marked, err := repo.MarkRead(ctx, dmAlice, firstOrdinary); err != nil || marked {
		t.Fatalf("cross-owner read changed counts=(%v,%v)", marked, err)
	}
	assertCounts(dmBob, 115, 55)
	if marked, err := repo.MarkRead(ctx, dmBob, firstDM); err != nil || !marked {
		t.Fatalf("canonical read=(%v,%v)", marked, err)
	}
	assertCounts(dmBob, 114, 55)
	if marked, err := repo.MarkRead(ctx, dmBob, firstOrdinary); err != nil || !marked {
		t.Fatalf("ordinary read=(%v,%v)", marked, err)
	}
	assertCounts(dmBob, 113, 54)
	if _, err := repo.MarkAllRead(ctx, dmBob); err != nil {
		t.Fatal(err)
	}
	assertCounts(dmBob, 0, 0)
	assertCounts(dmAlice, 1, 1)
}

func TestNotificationUnreadSummaryExcludesOnlyExactCanonicalDMSource(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	ctx := context.Background()
	repo := NewSQLiteNotificationRepo(wrapForRepo(db))
	summary := repo.(*sqliteNotificationRepo)
	actor, message, dm, server, channel := "sender", "message", "dm", "server", "channel"
	canonical := models.Notification{UserID: dmBob, Kind: models.NotificationKindSystem, ActorID: &actor, MessageID: &message, DMChannelID: &dm, Payload: json.RawMessage(`{"action":"incoming_message","source":"dm"}`)}
	variants := []struct {
		name   string
		change func(*models.Notification)
	}{
		{"mention kind", func(n *models.Notification) { n.Kind = models.NotificationKindMention }},
		{"missing actor", func(n *models.Notification) { n.ActorID = nil }},
		{"missing message", func(n *models.Notification) { n.MessageID = nil }},
		{"missing DM", func(n *models.Notification) { n.DMChannelID = nil }},
		{"server scoped", func(n *models.Notification) { n.ServerID = &server }},
		{"channel scoped", func(n *models.Notification) { n.ChannelID = &channel }},
		{"other system action", func(n *models.Notification) { n.Payload = json.RawMessage(`{"action":"server_event","source":"dm"}`) }},
		{"other source", func(n *models.Notification) {
			n.Payload = json.RawMessage(`{"action":"incoming_message","source":"group"}`)
		}},
		{"additional caller field", func(n *models.Notification) {
			n.Payload = json.RawMessage(`{"action":"incoming_message","source":"dm","preview":"notcanonical"}`)
		}},
		{"noncanonical serialization", func(n *models.Notification) {
			n.Payload = json.RawMessage(`{"source":"dm","action":"incoming_message"}`)
		}},
		{"unrelated empty payload", func(n *models.Notification) { n.Payload = json.RawMessage(`{}`) }},
	}
	for _, variant := range variants {
		n := canonical
		variant.change(&n)
		if err := repo.Create(ctx, &n); err != nil {
			t.Fatalf("%s: %v", variant.name, err)
		}
	}
	if err := repo.Create(ctx, &canonical); err != nil {
		t.Fatal(err)
	}
	got, err := summary.CountUnreadSummary(ctx, dmBob)
	if err != nil || got.UnreadCount != len(variants)+1 || got.BadgeUnreadCount != len(variants) {
		t.Fatalf("canonical-only summary=%+v err=%v", got, err)
	}
	if _, err := repo.MarkRead(ctx, dmBob, canonical.ID); err != nil {
		t.Fatal(err)
	}
	got, err = summary.CountUnreadSummary(ctx, dmBob)
	if err != nil || got.UnreadCount != len(variants) || got.BadgeUnreadCount != len(variants) {
		t.Fatalf("read exclusion=%+v err=%v", got, err)
	}
}
