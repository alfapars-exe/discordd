// Welcome bot — first-party DX proof for the Hichat bot gateway.
//
// It connects to the read-only bot gateway (GET /api/bot/gateway), listens for
// the member_join op, and posts a welcome message into a configured channel via
// the same REST message-create endpoint a human client uses. Authentication is
// the bot's "hb_" bearer token in the Authorization header — for both the WS
// dial and the REST POST.
package main

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"
	"os"

	"github.com/gorilla/websocket"
)

// event is the gateway wire envelope: {"op":"...","d":<data>,"seq":N,"server_id":"..."}.
// The server's ws.Event marshals the joining member into `d`, and the SERVER ID
// lives at the envelope top level (BroadcastToServer injects it) — it is NOT a
// field inside `d`. We capture both so a welcome can be scoped to the right
// server even though the member payload alone doesn't name one.
type event struct {
	Op       string          `json:"op"`
	Data     json.RawMessage `json:"d"`
	ServerID string          `json:"server_id"`
}

// memberJoin mirrors the server's models.MemberWithRoles payload sent as `d`
// for the member_join op. The joining user's id is the JSON field "id" (NOT
// "user_id"), and the human-facing name is "display_name" with "username" as a
// fallback. There is deliberately no "server_id" here — see event.ServerID.
type memberJoin struct {
	ID          string  `json:"id"`
	Username    string  `json:"username"`
	DisplayName *string `json:"display_name"`
}

// name returns the friendliest available label for the joining user.
func (m memberJoin) name() string {
	if m.DisplayName != nil && *m.DisplayName != "" {
		return *m.DisplayName
	}
	return m.Username
}

func main() {
	base := os.Getenv("HICHAT_BASE")     // e.g. http://localhost:8080
	token := os.Getenv("BOT_TOKEN")      // hb_...
	channel := os.Getenv("WELCOME_CHANNEL")
	server := os.Getenv("WELCOME_SERVER") // message route is server-scoped
	if base == "" || token == "" || channel == "" || server == "" {
		log.Fatal("set HICHAT_BASE, BOT_TOKEN, WELCOME_CHANNEL, WELCOME_SERVER")
	}

	wsURL := "ws" + base[len("http"):] + "/api/bot/gateway"
	hdr := http.Header{"Authorization": {"Bearer " + token}}
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, hdr)
	if err != nil {
		log.Fatalf("dial %s: %v", wsURL, err)
	}
	defer conn.Close()
	log.Printf("welcome-bot connected to %s", wsURL)

	for {
		var ev event
		if err := conn.ReadJSON(&ev); err != nil {
			log.Fatalf("read: %v", err)
		}
		if ev.Op != "member_join" {
			continue
		}

		// Only greet joins on the server we post into. The gateway may stream
		// member_join for any server the bot belongs to, but this bot writes to
		// a single configured WELCOME_CHANNEL on WELCOME_SERVER.
		if ev.ServerID != "" && ev.ServerID != server {
			continue
		}

		var mj memberJoin
		if err := json.Unmarshal(ev.Data, &mj); err != nil {
			log.Printf("skip member_join: bad payload: %v", err)
			continue
		}

		postMessage(base, token, server, channel, "Aramiza hos geldin, @"+mj.name()+"!")
	}
}

// postMessage posts to the server-scoped message-create endpoint with the bot
// token — the exact REST route and "content" body field a human client uses:
//
//	POST /api/servers/{serverId}/channels/{channelId}/messages
//	{"content": "..."}
func postMessage(base, token, serverID, channelID, text string) {
	body, _ := json.Marshal(map[string]string{"content": text})
	url := base + "/api/servers/" + serverID + "/channels/" + channelID + "/messages"
	req, _ := http.NewRequest("POST", url, bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		log.Printf("post welcome: %v", err)
		return
	}
	resp.Body.Close()
	log.Printf("welcome posted to channel %s (status %d)", channelID, resp.StatusCode)
}
