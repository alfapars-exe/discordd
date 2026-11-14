package main

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/config"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
)

type onlineNoticeWiringHub struct{ *ws.Hub }

func (*onlineNoticeWiringHub) GetVisibleOnlineUserIDs() []string {
	return []string{"wire-online-actor"}
}

func TestOnlineFriendProductionWiringPersistsOnceAndHonorsRevocationAndShutdown(t *testing.T) {
	db, _ := newCensusDB(t)
	repos := initRepositories(db.Conn, repository.DataExportStorageOptions{UploadDir: t.TempDir(), ArchiveDir: t.TempDir()})
	hub := &onlineNoticeWiringHub{Hub: ws.NewHub()}
	t.Cleanup(hub.Shutdown)
	cfg := &config.Config{}
	cfg.Upload.Dir = t.TempDir()
	bundle, limiters, metrics := initServices(db.Conn, repos, hub, cfg, nil, nil)
	t.Cleanup(func() {
		limiters.Stop()
		metrics.Stop()
		stopServiceCacheWorkers(bundle)
		bundle.Voice.ShutdownVoiceStateFanout()
		bundle.OnlineFriendNotifier.Stop()
		bundle.LinkPreview.Stop()
	})
	for _, statement := range []string{
		`INSERT INTO users(id,username,password_hash,status) VALUES('wire-online-actor','wire_online_actor','x','online'),('wire-online-recipient','wire_online_recipient','x','online')`,
		`INSERT INTO user_preferences(user_id,data) VALUES('wire-online-actor','{}'),('wire-online-recipient','{"notifications":{"onlineFriendNotifications":true}}')`,
		`INSERT INTO friendships(id,user_id,friend_id,status) VALUES('wire-online-edge','wire-online-actor','wire-online-recipient','accepted')`,
	} {
		if _, err := db.Conn.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	count := func() int {
		t.Helper()
		var n int
		if err := db.Conn.QueryRow(`SELECT COUNT(*) FROM notifications WHERE user_id='wire-online-recipient' AND actor_id='wire-online-actor'`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	for i := 0; i < 2; i++ {
		if err := bundle.OnlineFriendNotifier.NotifyOnlinePresence("wire-online-actor"); err != nil {
			t.Fatal(err)
		}
	}
	if n := count(); n != 1 {
		t.Fatalf("notices=%d, want one committed notice", n)
	}
	bundle.OnlineFriendNotifier.ObserveOffline("wire-online-actor")
	if _, err := db.Conn.Exec(`UPDATE friendships SET status='blocked' WHERE id='wire-online-edge'`); err != nil {
		t.Fatal(err)
	}
	if err := bundle.OnlineFriendNotifier.NotifyOnlinePresence("wire-online-actor"); err != nil {
		t.Fatal(err)
	}
	if n := count(); n != 1 {
		t.Fatalf("revoked edge created notice: %d", n)
	}
	bundle.OnlineFriendNotifier.Stop()
	if err := bundle.OnlineFriendNotifier.NotifyOnlinePresence("wire-online-actor"); !errors.Is(err, context.Canceled) {
		t.Fatalf("stopped notifier error=%v", err)
	}
}
