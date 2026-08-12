// Package handlers — LiveKitWebhookHandler.logEvent tests, focused on the
// A-29a moderation backstop wired into the participant_joined branch.
// HandleWebhook's HMAC verification (webhook.ReceiveWebhookEvent) is
// LiveKit SDK plumbing, not app logic under test here, so these tests call
// logEvent directly with hand-built livekit.WebhookEvent values instead of
// simulating a signed HTTP request. The timeout/ban decision itself (active
// vs not, checker error fail-open) lives in services.voiceService's
// EnforceModerationOnJoin and is covered there
// (services/voice_service_test.go); these tests only pin that logEvent
// resolves room/identity correctly and calls the enforcer at the right
// times.
package handlers

import (
	"context"
	"testing"

	"github.com/argeinfina/hichat/models"

	livekit "github.com/livekit/protocol/livekit"
)

// noopAppLog satisfies services.AppLogService. logEvent always calls Log
// unconditionally, so a non-nil stub is required even when a test doesn't
// care about the log content.
type noopAppLog struct{}

func (noopAppLog) Log(context.Context, models.LogLevel, models.LogCategory, *string, *string, string, map[string]string) {
}
func (noopAppLog) List(context.Context, models.AppLogFilter) ([]models.AppLog, int, error) {
	return nil, 0, nil
}
func (noopAppLog) Clear(context.Context) error { return nil }
func (noopAppLog) Start()                      {}
func (noopAppLog) Stop()                       {}

// enforceCall records one EnforceModerationOnJoin invocation.
type enforceCall struct {
	serverID, channelID, userID string
}

// recordingEnforcer is a VoiceModerationEnforcer that records every call for
// assertions instead of touching a real VoiceService/LiveKit.
type recordingEnforcer struct {
	calls []enforceCall
}

func (r *recordingEnforcer) EnforceModerationOnJoin(_ context.Context, serverID, channelID, userID string) {
	r.calls = append(r.calls, enforceCall{serverID, channelID, userID})
}

func joinedEvent(roomName, identity string) *livekit.WebhookEvent {
	return &livekit.WebhookEvent{
		Event:       "participant_joined",
		Room:        &livekit.Room{Name: roomName},
		Participant: &livekit.ParticipantInfo{Identity: identity},
	}
}

// TestLogEvent_ParticipantJoined_CallsEnforcer pins the happy path: a
// well-formed "{serverID}:{channelID}" room name resolves into the
// enforcer call voice_token.go's room-naming convention promises.
func TestLogEvent_ParticipantJoined_CallsEnforcer(t *testing.T) {
	enforcer := &recordingEnforcer{}
	h := NewLiveKitWebhookHandler(nil, nil, noopAppLog{}, enforcer)

	h.logEvent(context.Background(), joinedEvent("srv1:ch1", "u1"))

	if len(enforcer.calls) != 1 {
		t.Fatalf("expected exactly 1 EnforceModerationOnJoin call, got %d: %+v", len(enforcer.calls), enforcer.calls)
	}
	got := enforcer.calls[0]
	if got.serverID != "srv1" || got.channelID != "ch1" || got.userID != "u1" {
		t.Errorf("EnforceModerationOnJoin called with %+v, want {srv1 ch1 u1}", got)
	}
}

// TestLogEvent_ParticipantJoined_ScreenShareIdentityStripsSuffix pins that a
// screen-share sub-participant identity ("{userID}_ss", see voice_token.go
// GenerateScreenShareToken) is checked under the real user id, not the
// suffixed LiveKit identity.
func TestLogEvent_ParticipantJoined_ScreenShareIdentityStripsSuffix(t *testing.T) {
	enforcer := &recordingEnforcer{}
	h := NewLiveKitWebhookHandler(nil, nil, noopAppLog{}, enforcer)

	h.logEvent(context.Background(), joinedEvent("srv1:ch1", "u1_ss"))

	if len(enforcer.calls) != 1 || enforcer.calls[0].userID != "u1" {
		t.Fatalf("expected EnforceModerationOnJoin(..., userID=u1), got %+v", enforcer.calls)
	}
}

// TestLogEvent_ParticipantLeft_DoesNotCallEnforcer pins that the backstop
// only fires on participant_joined — participant_left has nothing to evict.
func TestLogEvent_ParticipantLeft_DoesNotCallEnforcer(t *testing.T) {
	enforcer := &recordingEnforcer{}
	h := NewLiveKitWebhookHandler(nil, nil, noopAppLog{}, enforcer)

	h.logEvent(context.Background(), &livekit.WebhookEvent{
		Event:       "participant_left",
		Room:        &livekit.Room{Name: "srv1:ch1"},
		Participant: &livekit.ParticipantInfo{Identity: "u1"},
	})

	if len(enforcer.calls) != 0 {
		t.Errorf("expected 0 EnforceModerationOnJoin calls on participant_left, got %d", len(enforcer.calls))
	}
}

// TestLogEvent_ParticipantJoined_MalformedRoomName_SkipsEnforcer pins the
// defensive parse guard: a room name without the "{serverID}:{channelID}"
// separator (should never happen — every room this server issues a token
// for uses that format) skips the enforcer instead of calling it with a
// wrong/empty serverID or channelID.
func TestLogEvent_ParticipantJoined_MalformedRoomName_SkipsEnforcer(t *testing.T) {
	enforcer := &recordingEnforcer{}
	h := NewLiveKitWebhookHandler(nil, nil, noopAppLog{}, enforcer)

	h.logEvent(context.Background(), joinedEvent("not-a-room-name", "u1"))

	if len(enforcer.calls) != 0 {
		t.Errorf("expected 0 EnforceModerationOnJoin calls for an unparseable room name, got %d", len(enforcer.calls))
	}
}

// TestLogEvent_ParticipantJoined_NilEnforcer_NoPanic pins that an unwired
// voiceEnforcer (nil) degrades to a no-op instead of a nil-pointer panic —
// the backstop is optional wiring, not a hard dependency of the webhook.
func TestLogEvent_ParticipantJoined_NilEnforcer_NoPanic(t *testing.T) {
	h := NewLiveKitWebhookHandler(nil, nil, noopAppLog{}, nil)
	h.logEvent(context.Background(), joinedEvent("srv1:ch1", "u1"))
}
