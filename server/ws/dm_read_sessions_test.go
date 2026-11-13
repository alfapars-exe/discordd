package ws_test

import (
	"context"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
	"github.com/gorilla/websocket"
)

func TestDMUnreadCursorDeliveredToBothSessions(t *testing.T) {
	ctx := context.Background()
	migrations, err := fs.Sub(database.EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatal(err)
	}
	db, err := database.NewLegacy(filepath.Join(t.TempDir(), "dm.db"), migrations)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	for _, id := range []string{"reader", "sender"} {
		if _, err := db.Conn.Exec("INSERT INTO users(id,username,password_hash) VALUES(?,?,?)", id, id, "test"); err != nil {
			t.Fatal(err)
		}
	}
	repo := repository.NewSQLiteDMRepo(db.Conn)
	channel := &models.DMChannel{User1ID: "reader", User2ID: "sender", Status: models.DMStatusAccepted}
	if err := repo.CreateChannel(ctx, channel); err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, content := range []string{"first", "second"} {
		message := &models.DMMessage{DMChannelID: channel.ID, UserID: "sender", Content: &content}
		if err := repo.CreateMessage(ctx, message); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, message.ID)
	}
	hub := ws.NewHub()
	go hub.Run()
	t.Cleanup(hub.Shutdown)
	users := gameActivityE2EUsers{"reader": {ID: "reader", Username: "Reader", PrefStatus: models.UserStatusOnline}}
	tickets := gameActivityE2ETickets{users: map[string]string{"one": "reader", "two": "reader"}}
	handler := ws.NewHandler(hub, nil, tickets, nil, nil, users, nil, nil, nil, nil)
	server := httptest.NewServer(http.HandlerFunc(handler.HandleConnection))
	t.Cleanup(server.Close)
	endpoint := "ws" + strings.TrimPrefix(server.URL, "http")
	var sessions []*websocket.Conn
	for _, ticket := range []string{"one", "two"} {
		conn := dialGameActivityClient(t, endpoint, ticket)
		defer conn.Close()
		conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		var ready ws.Event
		if err := conn.ReadJSON(&ready); err != nil || ready.Op != ws.OpReady {
			t.Fatalf("session readiness: %v, %v", ready.Op, err)
		}
		sessions = append(sessions, conn)
	}
	service := services.NewDMService(nil, repo, nil, hub, nil, nil, nil, nil, nil, repository.NewDMMessageTxRunner(db.Conn))
	if _, err := service.MarkUnreadFrom(ctx, "reader", channel.ID, ids[1]); err != nil {
		t.Fatal(err)
	}
	for _, conn := range sessions {
		conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		for {
			var event ws.Event
			if err := conn.ReadJSON(&event); err != nil {
				t.Fatal(err)
			}
			if event.Op != ws.OpDMRead {
				continue
			}
			payload := event.Data.(map[string]any)
			if payload["dm_channel_id"] != channel.ID || payload["last_read_message_id"] != ids[0] || payload["unread_count"] != float64(1) {
				t.Fatalf("unexpected read event: %v", payload)
			}
			break
		}
	}
}
