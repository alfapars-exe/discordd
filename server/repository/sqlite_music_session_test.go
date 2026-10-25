package repository

import (
	"context"
	"testing"

	"github.com/argeinfina/hichat/models"
)

func TestSQLiteMusicSessionRoundTripAndDelete(t *testing.T) {
	db := newTestDB(t)
	execSeed(t, db, []seedStmt{
		{q: `INSERT INTO users(id,username,password_hash) VALUES('music-owner','musicowner','hash')`},
		{q: `INSERT INTO servers(id,name,owner_id) VALUES('server-1','Music server','music-owner')`},
		{q: `INSERT INTO channels(id,name,type,server_id) VALUES('channel-1','Music','voice','server-1')`},
	})
	repo := NewSQLiteMusicSessionRepo(db.Conn)
	ctx := context.Background()
	session := models.MusicSession{ChannelID: "channel-1", ServerID: "server-1", RepeatMode: "all", Revision: 7, Queue: []models.MusicTrack{{QueueItemID: "item-1", VideoID: "video", Title: "Track"}}}
	if err := repo.Save(ctx, session); err != nil {
		t.Fatal(err)
	}
	rows, err := repo.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].Revision != 7 || rows[0].RepeatMode != "all" || len(rows[0].Queue) != 1 || rows[0].Queue[0].QueueItemID != "item-1" {
		t.Fatalf("round trip=%#v", rows)
	}
	if err := repo.Delete(ctx, "channel-1"); err != nil {
		t.Fatal(err)
	}
	rows, err = repo.List(ctx)
	if err != nil || len(rows) != 0 {
		t.Fatalf("after delete=%#v err=%v", rows, err)
	}
}
