package services

import (
	"context"
	"testing"
)

func TestVoiceMediaKeyContractWrapAndRecreation(t *testing.T) {
	svc := newTokenTestVoiceService(t).(*voiceService)
	ctx := context.Background()
	initial, err := svc.GenerateToken(ctx, "u1", "alice", "Alice", "ch1")
	if err != nil {
		t.Fatal(err)
	}
	if initial.E2EEPassphrase == "" || initial.E2EEKeyContext == "" || initial.E2EEKeyEpoch != 0 || initial.E2EEKeyIndex != 0 {
		t.Fatal("initial key contract incomplete")
	}
	svc.mu.Lock()
	for range 256 {
		svc.rotateRoomPassphraseForChannel("ch1")
	}
	svc.mu.Unlock()
	rotated, err := svc.GenerateToken(ctx, "u2", "bob", "Bob", "ch1")
	if err != nil {
		t.Fatal(err)
	}
	if rotated.E2EEKeyEpoch != 256 || rotated.E2EEKeyIndex != 0 || rotated.E2EEPassphrase == initial.E2EEPassphrase || rotated.E2EEKeyContext != initial.E2EEKeyContext {
		t.Fatal("existing-room join missed full epoch or stable incarnation")
	}
	svc.mu.Lock()
	svc.cleanupRoomPassphraseIfEmpty("ch1")
	svc.mu.Unlock()
	recreated, err := svc.GenerateToken(ctx, "u3", "carol", "Carol", "ch1")
	if err != nil {
		t.Fatal(err)
	}
	if recreated.E2EEKeyEpoch != 0 || recreated.E2EEKeyIndex != 0 || recreated.E2EEKeyContext == initial.E2EEKeyContext || recreated.E2EEPassphrase == rotated.E2EEPassphrase {
		t.Fatal("recreated room did not reset with a fresh incarnation")
	}
}
