package ws

import "testing"

// TestDeliver_BotFilter proves a bot client receives an allowed op and is
// silently skipped for a withheld op, while a human client receives both.
// This guards the SINGLE delivery chokepoint (hub.deliver) — the hub fans out
// pre-marshaled bytes, so this is the only place the bot allow-list applies.
func TestDeliver_BotFilter(t *testing.T) {
	h := NewHub()

	bot := &Client{userID: "bot_x", send: make(chan []byte, 4), isBot: true}
	human := &Client{userID: "u1", send: make(chan []byte, 4)}

	// Allowed op → bot receives it.
	h.deliver(bot, OpMessageCreate, []byte(`{"op":"message_create"}`))
	// Withheld op (voice) → bot is silently skipped.
	h.deliver(bot, OpVoiceStateUpdate, []byte(`{"op":"voice_state_update"}`))
	// Human receives the withheld op (the filter only applies to bots).
	h.deliver(human, OpVoiceStateUpdate, []byte(`{"op":"voice_state_update"}`))

	if len(bot.send) != 1 {
		t.Fatalf("bot should receive exactly the one allowed op, got %d", len(bot.send))
	}
	if len(human.send) != 1 {
		t.Fatalf("human should receive the withheld op, got %d", len(human.send))
	}
}

// TestBotReadableOps_WithholdsSensitive locks the security-critical allow-list:
// sensitive event families (voice, DM, E2EE/device, audit, presence, friend)
// must never be bot-readable, and the core message/member ops must be.
func TestBotReadableOps_WithholdsSensitive(t *testing.T) {
	withheld := []string{
		OpVoiceStateUpdate,
		OpDMMessageCreate,
		OpDeviceKeyChange,
		OpAuditEvent,
		OpPresenceUpdate,
		OpFriendRequestCreate,
	}
	for _, op := range withheld {
		if BotReadableOps[op] {
			t.Errorf("op %q must NOT be bot-readable (sensitive family)", op)
		}
	}

	allowed := []string{OpMessageCreate, OpMemberJoin, OpReactionUpdate}
	for _, op := range allowed {
		if !BotReadableOps[op] {
			t.Errorf("op %q must be bot-readable", op)
		}
	}
}
