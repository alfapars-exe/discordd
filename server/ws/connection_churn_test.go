package ws_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/ws"
)

type churnServerList struct{}

func (churnServerList) GetUserServers(context.Context, string) ([]models.ServerListItem, error) {
	return []models.ServerListItem{{ID: "shared"}}, nil
}

func TestWebSocketConnectionChurnReleasesMembership(t *testing.T) {
	const waves, width = 16, 8
	users := gameActivityE2EUsers{}
	tickets := gameActivityE2ETickets{users: map[string]string{}}
	for n := 0; n < waves*width; n++ {
		id := fmt.Sprintf("reader-%d", n)
		users[id] = &models.User{ID: id, Username: id}
		tickets.users[id] = id
	}
	hub := ws.NewHub()
	go hub.Run()
	defer hub.Shutdown()
	handler := ws.NewHandler(hub, nil, tickets, nil, nil, users, churnServerList{}, nil, nil, nil)
	server := httptest.NewServer(http.HandlerFunc(handler.HandleConnection))
	defer server.Close()
	endpoint := "ws" + strings.TrimPrefix(server.URL, "http")

	for wave := 0; wave < waves; wave++ {
		func() {
			for j := 0; j < width; j++ {
				conn := dialGameActivityClient(t, endpoint, fmt.Sprintf("reader-%d", wave*width+j))
				defer conn.Close()
				conn.SetReadDeadline(time.Now().Add(5 * time.Second))
				var ready ws.Event
				if err := conn.ReadJSON(&ready); err != nil || ready.Op != ws.OpReady {
					t.Fatalf("wave %d ready: %s, %v", wave, ready.Op, err)
				}
			}
			if got := len(hub.GetOnlineUserIDsForServer("shared")); got != width {
				t.Fatalf("registered users: %d, want %d", got, width)
			}
		}()
		deadline := time.Now().Add(5 * time.Second)
		for len(hub.GetOnlineUserIDs()) != 0 && time.Now().Before(deadline) {
			time.Sleep(time.Millisecond)
		}
		if len(hub.GetOnlineUserIDs()) != 0 || len(hub.GetOnlineUserIDsForServer("shared")) != 0 {
			t.Fatalf("wave %d retained disconnected users", wave)
		}
	}
}
