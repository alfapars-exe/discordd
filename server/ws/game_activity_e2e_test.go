package ws_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
	"github.com/gorilla/websocket"
)

type gameActivityE2ETickets struct{ users map[string]string }

func (t gameActivityE2ETickets) Consume(ticket string) (string, int, error) {
	userID, ok := t.users[ticket]
	if !ok {
		return "", 0, fmt.Errorf("unknown test ticket")
	}
	return userID, 0, nil
}

type gameActivityE2EUsers map[string]*models.User

func (u gameActivityE2EUsers) GetByID(_ context.Context, id string) (*models.User, error) {
	user := u[id]
	if user == nil {
		return nil, pkg.ErrNotFound
	}
	return user, nil
}

type gameActivityE2EFriends struct {
	mu       sync.RWMutex
	accepted map[string]bool
}

func (f *gameActivityE2EFriends) GetByPair(_ context.Context, a, b string) (*models.Friendship, error) {
	f.mu.RLock()
	accepted := f.accepted[gameActivityPairKey(a, b)]
	f.mu.RUnlock()
	if !accepted {
		return nil, pkg.ErrNotFound
	}
	return &models.Friendship{UserID: a, FriendID: b, Status: models.FriendshipStatusAccepted}, nil
}

func (f *gameActivityE2EFriends) IsBlocked(context.Context, string, string) (bool, error) {
	return false, nil
}

func (f *gameActivityE2EFriends) ListFriends(_ context.Context, userID string) ([]models.FriendshipWithUser, error) {
	f.mu.RLock()
	defer f.mu.RUnlock()
	var friends []models.FriendshipWithUser
	for pair := range f.accepted {
		parts := strings.Split(pair, "\x00")
		if len(parts) == 2 && parts[0] == userID {
			friends = append(friends, models.FriendshipWithUser{UserID: parts[1], Status: models.FriendshipStatusAccepted})
		} else if len(parts) == 2 && parts[1] == userID {
			friends = append(friends, models.FriendshipWithUser{UserID: parts[0], Status: models.FriendshipStatusAccepted})
		}
	}
	return friends, nil
}

func gameActivityPairKey(a, b string) string {
	if a > b {
		a, b = b, a
	}
	return a + "\x00" + b
}

type gameActivityE2EServers struct{}

func (gameActivityE2EServers) IsMember(context.Context, string, string) (bool, error) {
	return false, nil
}
func (gameActivityE2EServers) GetMemberCount(context.Context, string) (int, error) { return 0, nil }
func (gameActivityE2EServers) GetUserServers(context.Context, string) ([]models.ServerListItem, error) {
	return nil, nil
}
func (gameActivityE2EServers) ListMemberIDs(context.Context, string) ([]string, error) {
	return nil, nil
}

type gameActivityE2EPrefs struct {
	mu    sync.RWMutex
	share bool
}

func (p *gameActivityE2EPrefs) Get(_ context.Context, userID string) (*models.UserPreferences, error) {
	if userID != "publisher" {
		return nil, pkg.ErrNotFound
	}
	p.mu.RLock()
	share := p.share
	p.mu.RUnlock()
	data, _ := json.Marshal(map[string]any{"privacy": map[string]bool{"shareGameActivity": share}})
	return &models.UserPreferences{UserID: userID, Data: data}, nil
}

func (p *gameActivityE2EPrefs) setShare(share bool) {
	p.mu.Lock()
	p.share = share
	p.mu.Unlock()
}

func TestGameActivityWebSocketTwoViewersOptOutAndPhysicalDisconnect(t *testing.T) {
	hub := ws.NewHub()
	go hub.Run()
	t.Cleanup(hub.Shutdown)

	friends := &gameActivityE2EFriends{accepted: map[string]bool{gameActivityPairKey("publisher", "allowed"): true}}
	prefs := &gameActivityE2EPrefs{share: true}
	policy := services.NewGameActivityPrivacyPolicy(prefs, friends, gameActivityE2EServers{}, e2eVisiblePresence{hub: hub})
	activity := services.NewGameActivityService(policy, friends, gameActivityE2EServers{}, hub)
	activityCtx, cancelActivity := context.WithCancel(context.Background())
	t.Cleanup(func() { cancelActivity(); activity.Stop() })
	hub.OnGameActivityConnect(activity.Connect)
	hub.OnGameActivityUpdate(func(userID string, connectionID, sequence uint64, game *ws.GameActivityClientGame) {
		activity.Update(activityCtx, userID, connectionID, sequence, game)
	})
	hub.OnGameActivityDisconnect(func(userID string, connectionID uint64) {
		activity.Disconnect(activityCtx, userID, connectionID)
	})
	// ready precedes the asynchronous initial snapshot. Complete all four
	// initial snapshots before publishing, so they cannot enqueue duplicate A
	// after this test has moved on to expecting B.
	snapshotDone := make(chan string, 4)
	hub.OnGameActivitySnapshot(func(userID string) {
		activity.Snapshot(activityCtx, userID)
		snapshotDone <- userID
	})
	hub.OnGameActivityPresenceChange(func(userID string) { activity.PolicyChanged(activityCtx, userID) })

	users := gameActivityE2EUsers{}
	for id, name := range map[string]string{"publisher": "Publisher", "allowed": "Allowed", "denied": "Denied"} {
		users[id] = &models.User{ID: id, Username: name, TokenVersion: 0, PrefStatus: models.UserStatusOnline}
	}
	handler := ws.NewHandler(hub, nil, gameActivityE2ETickets{users: map[string]string{
		"publisher-1": "publisher", "publisher-2": "publisher", "allowed": "allowed", "denied": "denied",
	}}, nil, nil, users, nil, nil, nil, nil)
	httpServer := httptest.NewServer(http.HandlerFunc(handler.HandleConnection))
	t.Cleanup(httpServer.Close)
	endpoint := "ws" + strings.TrimPrefix(httpServer.URL, "http")

	publisher1 := dialGameActivityClient(t, endpoint, "publisher-1")
	defer publisher1.Close()
	epoch := readGameActivityReady(t, publisher1)
	publisher2 := dialGameActivityClient(t, endpoint, "publisher-2")
	if got := readGameActivityReady(t, publisher2); got != epoch {
		t.Fatalf("second publisher epoch = %q, want %q", got, epoch)
	}
	allowed := dialGameActivityClient(t, endpoint, "allowed")
	defer allowed.Close()
	if got := readGameActivityReady(t, allowed); got != epoch {
		t.Fatalf("allowed viewer epoch = %q, want %q", got, epoch)
	}
	denied := dialGameActivityClient(t, endpoint, "denied")
	defer denied.Close()
	if got := readGameActivityReady(t, denied); got != epoch {
		t.Fatalf("denied viewer epoch = %q, want %q", got, epoch)
	}

	snapshots := map[string]int{}
	for i := 0; i < 4; i++ {
		select {
		case user := <-snapshotDone:
			snapshots[user]++
		case <-time.After(5 * time.Second):
			t.Fatal("initial game activity snapshots did not finish")
		}
	}
	if snapshots["publisher"] != 2 || snapshots["allowed"] != 1 || snapshots["denied"] != 1 {
		t.Fatalf("unexpected initial snapshots: %v", snapshots)
	}
	deniedEvents := watchUnexpectedWebSocketEvent(t, denied)

	gameA := ws.GameActivityClientGame{ID: "11111111-1111-4111-8111-111111111111", Name: "Game A"}
	gameB := ws.GameActivityClientGame{ID: "22222222-2222-4222-8222-222222222222", Name: "Game B"}
	if err := publisher1.WriteJSON(ws.Event{Op: ws.OpGameActivityUpdate, Data: map[string]any{
		"user_id": "denied", "username": "forged", "game": gameA,
	}}); err != nil {
		t.Fatalf("write forged game activity: %v", err)
	}
	writeGameActivityUpdate(t, publisher1, gameA)
	assertGameActivity(t, publisher1, "publisher", "", gameA.ID, epoch)
	assertGameActivity(t, allowed, "publisher", "", gameA.ID, epoch)
	assertNoWebSocketEvent(t, deniedEvents)

	writeGameActivityUpdate(t, publisher2, gameB)
	assertGameActivity(t, publisher1, "publisher", "", gameB.ID, epoch)
	assertGameActivity(t, allowed, "publisher", "", gameB.ID, epoch)

	// Closing one of the publisher's physical connections must only remove
	// that source; the remaining connection becomes authoritative again.
	_ = publisher2.Close()
	assertGameActivity(t, publisher1, "publisher", "", gameA.ID, epoch)
	assertGameActivity(t, allowed, "publisher", "", gameA.ID, epoch)
	assertNoWebSocketEvent(t, deniedEvents)

	// Simulate a committed preference opt-out. The policy hook must clear
	// existing grants to the owner and the accepted friend immediately.
	prefs.setShare(false)
	activity.PolicyChanged(context.Background(), "publisher")
	assertGameActivity(t, publisher1, "publisher", "", "", epoch)
	assertGameActivity(t, allowed, "publisher", "", "", epoch)
	assertNoWebSocketEvent(t, deniedEvents)
}

type e2eVisiblePresence struct{ hub *ws.Hub }

func (p e2eVisiblePresence) IsVisibleOnline(_ context.Context, userID string) (bool, error) {
	return p.hub.IsVisibleOnline(userID)
}

func dialGameActivityClient(t *testing.T, endpoint, ticket string) *websocket.Conn {
	t.Helper()
	conn, response, err := websocket.DefaultDialer.Dial(endpoint+"?ticket="+ticket, nil)
	if err != nil {
		if response != nil {
			t.Fatalf("dial %s: %v (HTTP %d)", ticket, err, response.StatusCode)
		}
		t.Fatalf("dial %s: %v", ticket, err)
	}
	return conn
}

func readGameActivityReady(t *testing.T, conn *websocket.Conn) string {
	t.Helper()
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	var event ws.Event
	if err := conn.ReadJSON(&event); err != nil {
		t.Fatalf("read ready: %v", err)
	}
	if event.Op != ws.OpReady {
		t.Fatalf("first websocket event = %q, want ready", event.Op)
	}
	data, ok := event.Data.(map[string]any)
	if !ok {
		t.Fatalf("ready data type = %T", event.Data)
	}
	epoch, _ := data["game_activity_epoch"].(string)
	if epoch == "" {
		t.Fatal("ready omitted game_activity_epoch")
	}
	return epoch
}

func writeGameActivityUpdate(t *testing.T, conn *websocket.Conn, game ws.GameActivityClientGame) {
	t.Helper()
	if err := conn.WriteJSON(ws.Event{Op: ws.OpGameActivityUpdate, Data: ws.GameActivityClientUpdate{Game: &game}}); err != nil {
		t.Fatalf("write game activity: %v", err)
	}
}

func assertGameActivity(t *testing.T, conn *websocket.Conn, targetID, serverID, gameID, epoch string) {
	t.Helper()
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		var event ws.Event
		if err := conn.ReadJSON(&event); err != nil {
			t.Fatalf("read game activity: %v", err)
		}
		if event.Op != ws.OpGameActivityUpdate {
			continue
		}
		payload, ok := event.Data.(map[string]any)
		if !ok {
			t.Fatalf("activity payload type = %T", event.Data)
		}
		gotServerID, _ := payload["server_id"].(string)
		if payload["user_id"] != targetID || gotServerID != serverID {
			continue
		}
		if gotEpoch, _ := payload["epoch"].(string); gotEpoch != epoch {
			t.Fatalf("activity epoch = %q, want %q", gotEpoch, epoch)
		}
		game, _ := payload["game"].(map[string]any)
		if gameID == "" {
			if payload["game"] != nil {
				t.Fatalf("game = %#v, want null tombstone", payload["game"])
			}
			return
		}
		if game["id"] != gameID {
			t.Fatalf("game id = %v, want %s", game["id"], gameID)
		}
		return
	}
}

// A Gorilla read timeout permanently poisons later reads. Keep one live
// reader across all negative assertions, and close/join it during cleanup.
func watchUnexpectedWebSocketEvent(t *testing.T, conn *websocket.Conn) <-chan error {
	t.Helper()
	if err := conn.SetReadDeadline(time.Time{}); err != nil {
		t.Fatal(err)
	}
	events := make(chan error, 1)
	done := make(chan struct{})
	go func() { defer close(done); _, _, err := conn.ReadMessage(); events <- err }()
	t.Cleanup(func() { conn.Close(); <-done })
	return events
}

func assertNoWebSocketEvent(t *testing.T, events <-chan error) {
	t.Helper()
	select {
	case err := <-events:
		t.Fatalf("expected healthy websocket without event, got read result %v", err)
	case <-time.After(200 * time.Millisecond):
	}
}

func TestLegacyTicketReadyWaitsForHubRegistration(t *testing.T) {
	hub := ws.NewHub()
	users := gameActivityE2EUsers{"viewer": {ID: "viewer", Username: "Viewer", PrefStatus: models.UserStatusOnline}}
	handler := ws.NewHandler(hub, nil, gameActivityE2ETickets{users: map[string]string{"ticket": "viewer"}}, nil, nil, users, nil, nil, nil, nil)
	server := httptest.NewServer(http.HandlerFunc(handler.HandleConnection))
	defer server.Close()
	conn := dialGameActivityClient(t, "ws"+strings.TrimPrefix(server.URL, "http"), "ticket")
	defer conn.Close()
	ready := make(chan error, 1)
	go func() {
		var event ws.Event
		err := conn.ReadJSON(&event)
		if err == nil && event.Op != ws.OpReady {
			err = fmt.Errorf("first event = %q", event.Op)
		}
		ready <- err
	}()
	select {
	case err := <-ready:
		go hub.Run()
		defer hub.Shutdown()
		t.Fatalf("socket returned before hub registration: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	go hub.Run()
	defer hub.Shutdown()
	select {
	case err := <-ready:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("missing ready after registration")
	}
}
