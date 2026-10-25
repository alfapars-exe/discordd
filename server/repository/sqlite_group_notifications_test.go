package repository

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"strings"
	"testing"
	"time"
)

func TestGroupIncomingNotificationsOpaqueAtomicReadMuteAndCleanup(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	ctx := context.Background()
	repo := NewSQLiteGroupDMRepo(wrapForRepo(db))
	const group = "notification-group"
	if err := repo.Create(ctx, &models.GroupDM{ID: group, OwnerID: dmAlice, Name: group, KeyEpoch: 1, CallRoomKey: group}, []string{dmAlice, dmBob, dmCarol}); err != nil {
		t.Fatal(err)
	}
	notifications := NewSQLiteNotificationRepo(wrapForRepo(db))
	summary := notifications.(*sqliteNotificationRepo)
	assertCount := func(user string, inbox, badge int) {
		t.Helper()
		n, err := summary.CountUnreadSummary(ctx, user)
		if err != nil || n.UnreadCount != inbox || n.BadgeUnreadCount != badge {
			t.Fatalf("counts %s=%+v err=%v", user, n, err)
		}
	}
	create := func(id string) *models.GroupDMMessage {
		t.Helper()
		cipher, device := "opaque-private-ciphertext", "sender-device"
		m := &models.GroupDMMessage{ID: id, GroupID: group, UserID: dmAlice, Ciphertext: &cipher, SenderDeviceID: &device, EncryptionVersion: 1, KeyEpoch: 1}
		if err := repo.CreateMessage(ctx, m); err != nil {
			t.Fatal(err)
		}
		return m
	}
	first := create("zz-first")
	second := create("aa-second")
	third := create("bb-third")
	assertCount(dmAlice, 0, 0)
	assertCount(dmBob, 3, 0)
	assertCount(dmCarol, 3, 0)
	list, err := notifications.List(ctx, dmBob, "", true, 50)
	if err != nil || len(list) != 3 {
		t.Fatalf("list=%+v %v", list, err)
	}
	for _, n := range list {
		if n.GroupDMChannelID == nil || *n.GroupDMChannelID != group || n.DMChannelID != nil || n.ServerID != nil || n.ChannelID != nil || n.ActorID == nil || *n.ActorID != dmAlice || string(n.Payload) != groupIncomingMessagePayload {
			t.Fatalf("invalid source %+v", n)
		}
		body, _ := json.Marshal(n)
		if strings.Contains(string(body), "opaque-private-ciphertext") || strings.Contains(string(body), "sender-device") || strings.Contains(string(body), "ciphertext") {
			t.Fatal("private content/device metadata leaked to inbox")
		}
	}
	if _, err := repo.SetMuted(ctx, group, dmBob, true, 1); err != nil {
		t.Fatal(err)
	}
	assertCount(dmBob, 3, 0) // Muting retains inbox; taskbar uses existing unmuted group read aggregate.
	if err := repo.MarkRead(ctx, group, dmBob, &first.ID, 1); err != nil {
		t.Fatal(err)
	}
	assertCount(dmBob, 2, 0)
	if err := repo.MarkRead(ctx, group, dmBob, &second.ID, 999); !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("stale epoch=%v", err)
	}
	assertCount(dmBob, 2, 0)
	if err := repo.DeleteMessage(ctx, group, third.ID, dmAlice); err != nil {
		t.Fatal(err)
	}
	assertCount(dmBob, 1, 0)
	if _, err := repo.RemoveMember(ctx, group, dmBob); err != nil {
		t.Fatal(err)
	}
	assertCount(dmBob, 0, 0)
	if list, err = notifications.List(ctx, dmBob, "", false, 50); err != nil || len(list) != 0 {
		t.Fatalf("removed member leaked rows %+v %v", list, err)
	}
	if _, err := repo.AddMember(ctx, group, dmBob); err != nil {
		t.Fatal(err)
	}
	assertCount(dmBob, 0, 0) // Rejoin cannot resurrect the old membership's private inbox.
	if err := repo.Delete(ctx, group); err != nil {
		t.Fatal(err)
	}
	assertCount(dmCarol, 0, 0)
}

func TestGroupIncomingNotificationsFailureRollsBackSourceAndDeduplicatesDelivery(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	ctx := context.Background()
	repo := NewSQLiteGroupDMRepo(wrapForRepo(db))
	const group = "notification-rollback"
	if err := repo.Create(ctx, &models.GroupDM{ID: group, OwnerID: dmAlice, Name: group, KeyEpoch: 1, CallRoomKey: group}, []string{dmAlice, dmBob}); err != nil {
		t.Fatal(err)
	}
	// A temporarily unavailable inbox table fails the entire source transaction on both engines.
	if _, err := db.Conn.Exec(`ALTER TABLE notifications RENAME TO notifications_unavailable`); err != nil {
		t.Fatal(err)
	}
	cipher, device := "cipher", "device"
	m := &models.GroupDMMessage{ID: "atomic-source", GroupID: group, UserID: dmAlice, Ciphertext: &cipher, SenderDeviceID: &device, EncryptionVersion: 1, KeyEpoch: 1}
	if err := repo.CreateMessage(ctx, m); err == nil {
		t.Fatal("notification failure reported message success")
	}
	if _, err := repo.GetMessage(ctx, group, m.ID); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("source survived failure: %v", err)
	}
	if _, err := db.Conn.Exec(`ALTER TABLE notifications_unavailable RENAME TO notifications`); err != nil {
		t.Fatal(err)
	}
	if err := repo.CreateMessage(ctx, m); err != nil {
		t.Fatal(err)
	}
	impl := repo.(*sqliteGroupDMRepo)
	deliveries := 0
	if err := impl.DeliverCommittedGroupNotifications(ctx, group, m.ID, func(n *models.Notification) {
		deliveries++
		if n.UserID != dmBob {
			t.Errorf("wrong recipient %s", n.UserID)
		}
	}); err != nil {
		t.Fatal(err)
	}
	if deliveries != 1 {
		t.Fatalf("deliveries=%d", deliveries)
	}
	if _, err := repo.RemoveMember(ctx, group, dmBob); err != nil {
		t.Fatal(err)
	}
	if err := impl.DeliverCommittedGroupNotifications(ctx, group, m.ID, func(*models.Notification) { t.Error("delivered after acknowledged removal") }); err != nil {
		t.Fatal(err)
	}
}

func TestGroupIncomingNotificationsDeliverySerializesMemberRemoval(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	ctx := context.Background()
	repo := NewSQLiteGroupDMRepo(wrapForRepo(db))
	const group = "notification-lock"
	if err := repo.Create(ctx, &models.GroupDM{ID: group, OwnerID: dmAlice, Name: group, KeyEpoch: 1, CallRoomKey: group}, []string{dmAlice, dmBob}); err != nil {
		t.Fatal(err)
	}
	cipher, device := "cipher", "device"
	m := &models.GroupDMMessage{ID: "lock-source", GroupID: group, UserID: dmAlice, Ciphertext: &cipher, SenderDeviceID: &device, EncryptionVersion: 1, KeyEpoch: 1}
	if err := repo.CreateMessage(ctx, m); err != nil {
		t.Fatal(err)
	}
	entered, release := make(chan struct{}), make(chan struct{})
	delivered, removed := make(chan error, 1), make(chan error, 1)
	go func() {
		delivered <- repo.(*sqliteGroupDMRepo).DeliverCommittedGroupNotifications(ctx, group, m.ID, func(*models.Notification) { close(entered); <-release })
	}()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("delivery did not acquire source lock")
	}
	go func() { _, err := repo.RemoveMember(ctx, group, dmBob); removed <- err }()
	select {
	case err := <-removed:
		close(release)
		t.Fatalf("revocation acknowledged before held delivery finished: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	close(release)
	select {
	case err := <-delivered:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("delivery not released")
	}
	select {
	case err := <-removed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("removal not released")
	}
	if err := repo.(*sqliteGroupDMRepo).DeliverCommittedGroupNotifications(ctx, group, m.ID, func(*models.Notification) { t.Error("post-revocation metadata delivery") }); err != nil {
		t.Fatal(err)
	}
}

func TestGroupIncomingNotificationsBeyondPageAndInvalidSourceIsolation(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	ctx := context.Background()
	repo := NewSQLiteGroupDMRepo(wrapForRepo(db))
	const group = "notification-many"
	if err := repo.Create(ctx, &models.GroupDM{ID: group, OwnerID: dmAlice, Name: group, KeyEpoch: 1, CallRoomKey: group}, []string{dmAlice, dmBob}); err != nil {
		t.Fatal(err)
	}
	nrepo := NewSQLiteNotificationRepo(wrapForRepo(db))
	summary := nrepo.(*sqliteNotificationRepo)
	if _, err := db.Conn.Exec(`INSERT INTO notifications(id,user_id,kind,actor_id,message_id,group_dm_channel_id,payload) VALUES('orphan-group',?,'system',?,'missing-source','missing-group',?)`, dmBob, dmAlice, groupIncomingMessagePayload); err != nil {
		t.Fatal(err)
	}
	if list, err := nrepo.List(ctx, dmBob, "", false, 50); err != nil || len(list) != 0 {
		t.Fatalf("orphan leak=%+v %v", list, err)
	}
	if read, err := nrepo.MarkRead(ctx, dmBob, "orphan-group"); err != nil || read {
		t.Fatalf("orphan ack=%v %v", read, err)
	}
	if count, err := nrepo.MarkAllRead(ctx, dmBob); err != nil || count != 0 {
		t.Fatalf("orphan bulk ack=%d %v", count, err)
	}
	var cutoff string
	for i := 0; i < 55; i++ {
		cipher, device := "cipher", "device"
		m := &models.GroupDMMessage{ID: fmt.Sprintf("notification-source-%02d", i), GroupID: group, UserID: dmAlice, Ciphertext: &cipher, SenderDeviceID: &device, EncryptionVersion: 1, KeyEpoch: 1}
		if err := repo.CreateMessage(ctx, m); err != nil {
			t.Fatal(err)
		}
		if i == 2 {
			cutoff = m.ID
		}
	}
	ordinary := &models.Notification{UserID: dmBob, Kind: models.NotificationKindSystem, Payload: json.RawMessage(`{"title":"ordinary event"}`)}
	if err := nrepo.Create(ctx, ordinary); err != nil {
		t.Fatal(err)
	}
	counts, err := summary.CountUnreadSummary(ctx, dmBob)
	if err != nil || counts.UnreadCount != 56 || counts.BadgeUnreadCount != 1 {
		t.Fatalf("full counts=%+v %v", counts, err)
	}
	if page, err := nrepo.List(ctx, dmBob, "", true, 50); err != nil || len(page) != 50 {
		t.Fatalf("page=%d %v", len(page), err)
	}
	if err := repo.MarkRead(ctx, group, dmBob, &cutoff, 1); err != nil {
		t.Fatal(err)
	}
	counts, err = summary.CountUnreadSummary(ctx, dmBob)
	if err != nil || counts.UnreadCount != 53 || counts.BadgeUnreadCount != 1 {
		t.Fatalf("source cutoff affected unrelated feed=%+v %v", counts, err)
	}
	// Sending advances one's own existing group read watermark. Matching inbox
	// sources must be acknowledged in the same transaction, not counted again.
	cipher, device := "cipher", "device"
	if err := repo.CreateMessage(ctx, &models.GroupDMMessage{ID: "reader-own-send", GroupID: group, UserID: dmBob, Ciphertext: &cipher, SenderDeviceID: &device, EncryptionVersion: 1, KeyEpoch: 1}); err != nil {
		t.Fatal(err)
	}
	counts, err = summary.CountUnreadSummary(ctx, dmBob)
	if err != nil || counts.UnreadCount != 1 || counts.BadgeUnreadCount != 1 {
		t.Fatalf("sender read watermark/inbox divergence=%+v %v", counts, err)
	}
}
