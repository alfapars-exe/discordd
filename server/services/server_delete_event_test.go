package services

import (
	"context"
	"testing"

	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
)

type deleteEventRecorder struct {
	ws.EventPublisher
	record func(string, ws.Event)
}

func (h *deleteEventRecorder) BroadcastToServer(id string, event ws.Event) { h.record(id, event) }

func TestServerDeleteEventFollowsCommit(t *testing.T) {
	for _, caller := range []string{"owner", "admin"} {
		t.Run(caller, func(t *testing.T) {
			db := newBotTestDB(t)
			for _, stmt := range []string{
				"INSERT INTO users(id,username,password_hash) VALUES('owner','owner','fixture')",
				"INSERT INTO servers(id,name,owner_id) VALUES('srv','Test','owner')",
				"CREATE TABLE server_delete_guard(id TEXT REFERENCES servers(id))",
				"INSERT INTO server_delete_guard VALUES('srv')",
			} {
				if _, err := db.Conn.Exec(stmt); err != nil {
					t.Fatal(err)
				}
			}
			ctx := context.Background()
			repo := repository.NewSQLiteServerRepo(db.Conn)
			events := 0
			hub := &deleteEventRecorder{record: func(id string, event ws.Event) {
				events++
				var remaining int
				if err := db.Conn.QueryRow("SELECT COUNT(*) FROM servers WHERE id=?", id).Scan(&remaining); err != nil || remaining != 0 || event.Op != ws.OpServerDelete {
					t.Errorf("broadcast before commit or wrong event: remaining=%d op=%s err=%v", remaining, event.Op, err)
				}
			}}
			remove := func() error {
				return (&serverService{db: db.Conn, serverRepo: repo, hub: hub}).DeleteServer(ctx, "srv", "owner")
			}
			if caller == "admin" {
				remove = func() error {
					return (&adminServerService{db: db.Conn, serverRepo: repo, hub: hub}).DeleteServer(ctx, "admin", "srv", "")
				}
			}
			if err := remove(); err == nil || events != 0 {
				t.Fatalf("failed deletion emitted %d events, err=%v", events, err)
			}
			if _, err := db.Conn.Exec("DELETE FROM server_delete_guard"); err != nil {
				t.Fatal(err)
			}
			if err := remove(); err != nil || events != 1 {
				t.Fatalf("successful deletion emitted %d events, err=%v", events, err)
			}
		})
	}
}
