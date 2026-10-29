package ws

import (
	"fmt"
	"testing"
)

func TestTargetFanoutDedupesUsersAndKeepsDeviceAndBotFilters(t *testing.T) {
	h := NewHub()
	one := &Client{send: make(chan []byte, 4), done: make(chan struct{})}
	two := &Client{send: make(chan []byte, 4), done: make(chan struct{})}
	bot := &Client{send: make(chan []byte, 4), done: make(chan struct{}), isBot: true}
	other := &Client{send: make(chan []byte, 4), done: make(chan struct{})}
	h.clients["target"] = map[*Client]bool{one: true, two: true, bot: true}
	h.clients["other"] = map[*Client]bool{other: true}
	h.BroadcastToUsers([]string{"target", "target", "offline"}, Event{Op: OpVoiceStateUpdate})
	if len(one.send) != 1 || len(two.send) != 1 || len(bot.send) != 0 || len(other.send) != 0 {
		t.Fatal("target/device/bot contract violated")
	}
}
func BenchmarkTargetFanout(b *testing.B) {
	for _, size := range []int{10, 1000, 100000} {
		b.Run(fmt.Sprint(size), func(b *testing.B) {
			h := NewHub()
			for i := 0; i < size; i++ {
				h.clients[fmt.Sprint(i)] = map[*Client]bool{}
			}
			client := &Client{send: make(chan []byte, 1), done: make(chan struct{})}
			h.clients["target"] = map[*Client]bool{client: true}
			event := Event{Op: OpMessageCreate, Data: map[string]string{"id": "message"}}
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				h.BroadcastToUsers([]string{"target"}, event)
				<-client.send
			}
		})
	}
}
