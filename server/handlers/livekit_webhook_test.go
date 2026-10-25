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
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	appcrypto "github.com/argeinfina/hichat/pkg/crypto"
	"github.com/argeinfina/hichat/services"

	"github.com/livekit/protocol/auth"
	livekit "github.com/livekit/protocol/livekit"
	"google.golang.org/protobuf/encoding/protojson"
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

type recordingStreamNotifier struct {
	calls []streamNotificationCall
	err   error
}

type streamNotificationCall struct {
	issuerInstanceID string
	serverID         string
	channelID        string
	actorID          string
	roomName         string
	trackSID         string
	publicationTime  time.Time
}

func (n *recordingStreamNotifier) NotifyStreamStart(_ context.Context, issuerInstanceID, serverID, channelID, actorID, roomName, trackSID string, publicationTime time.Time) error {
	n.calls = append(n.calls, streamNotificationCall{issuerInstanceID, serverID, channelID, actorID, roomName, trackSID, publicationTime})
	return n.err
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

type webhookBindingRepo struct {
	instances []models.LiveKitInstance
	byServer  map[string]*models.LiveKitInstance
	lookups   int
}

func (r *webhookBindingRepo) ListAllInstances(context.Context) ([]models.LiveKitInstance, error) {
	return r.instances, nil
}

func (r *webhookBindingRepo) GetByServerID(_ context.Context, serverID string) (*models.LiveKitInstance, error) {
	r.lookups++
	return r.byServer[serverID], nil
}

func encryptedWebhookInstance(t *testing.T, id, apiKey, secret string, encryptionKey []byte) models.LiveKitInstance {
	t.Helper()
	encKey, err := appcrypto.Encrypt(apiKey, encryptionKey)
	if err != nil {
		t.Fatal(err)
	}
	encSecret, err := appcrypto.Encrypt(secret, encryptionKey)
	if err != nil {
		t.Fatal(err)
	}
	return models.LiveKitInstance{ID: id, APIKey: encKey, APISecret: encSecret}
}

func signedWebhookRequest(t *testing.T, event *livekit.WebhookEvent, apiKey, secret string) (*http.Request, *httptest.ResponseRecorder) {
	t.Helper()
	data, err := protojson.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(data)
	token, err := auth.NewAccessToken(apiKey, secret).
		SetSha256(base64.StdEncoding.EncodeToString(digest[:])).
		SetValidFor(time.Minute).
		ToJWT()
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("POST", "/api/livekit/webhook", bytes.NewReader(data))
	req.Header.Set("Authorization", token)
	return req, httptest.NewRecorder()
}

func TestHandleWebhookBindsVerifiedIssuerToRoomServer(t *testing.T) {
	encryptionKey := bytes.Repeat([]byte("k"), 32)
	instanceA := encryptedWebhookInstance(t, "instance-a", "key-a", "secret-a", encryptionKey)
	instanceB := encryptedWebhookInstance(t, "instance-b", "key-b", "secret-b", encryptionKey)
	for _, tc := range []struct {
		name           string
		event          *livekit.WebhookEvent
		issuerKey      string
		issuerSecret   string
		instances      []models.LiveKitInstance
		resolver       map[string]*models.LiveKitInstance
		wantStatus     int
		wantEnforce    int
		wantLookupCall int
	}{
		{
			name:           "mapped issuer accepted",
			issuerKey:      "key-a",
			issuerSecret:   "secret-a",
			instances:      []models.LiveKitInstance{instanceA, instanceB},
			resolver:       map[string]*models.LiveKitInstance{"server-a": &instanceA},
			wantStatus:     200,
			wantEnforce:    1,
			wantLookupCall: 1,
		},
		{
			name:           "valid but foreign instance rejected",
			issuerKey:      "key-b",
			issuerSecret:   "secret-b",
			instances:      []models.LiveKitInstance{instanceA, instanceB},
			resolver:       map[string]*models.LiveKitInstance{"server-a": &instanceA},
			wantStatus:     401,
			wantLookupCall: 1,
		},
		{
			name:           "foreign issuer track event rejected before any callback",
			event:          &livekit.WebhookEvent{Event: "track_published", Room: &livekit.Room{Name: "server-a:channel-a"}, Participant: &livekit.ParticipantInfo{Identity: "user-a"}, CreatedAt: time.Now().Unix()},
			issuerKey:      "key-b",
			issuerSecret:   "secret-b",
			instances:      []models.LiveKitInstance{instanceA, instanceB},
			resolver:       map[string]*models.LiveKitInstance{"server-a": &instanceA},
			wantStatus:     401,
			wantLookupCall: 1,
		},
		{
			name:           "duplicate API key rejected as ambiguous",
			issuerKey:      "key-a",
			issuerSecret:   "secret-a",
			instances:      []models.LiveKitInstance{instanceA, encryptedWebhookInstance(t, "instance-duplicate", "key-a", "secret-a", encryptionKey)},
			resolver:       map[string]*models.LiveKitInstance{"server-a": &instanceA},
			wantStatus:     401,
			wantLookupCall: 0,
		},
		{
			name:           "room callback fails closed without resolver",
			issuerKey:      "key-a",
			issuerSecret:   "secret-a",
			instances:      []models.LiveKitInstance{instanceA},
			wantStatus:     503,
			wantLookupCall: 0,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			loader := &webhookBindingRepo{instances: tc.instances, byServer: tc.resolver}
			enforcer := &recordingEnforcer{}
			var h *LiveKitWebhookHandler
			if tc.resolver == nil {
				h = NewLiveKitWebhookHandler(loader, encryptionKey, noopAppLog{}, enforcer)
			} else {
				h = NewLiveKitWebhookHandler(loader, encryptionKey, noopAppLog{}, enforcer, loader)
			}
			event := tc.event
			if event == nil {
				event = joinedEvent("server-a:channel-a", "user-a")
			}
			req, response := signedWebhookRequest(t, event, tc.issuerKey, tc.issuerSecret)
			h.HandleWebhook(response, req)
			if response.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d; body=%s", response.Code, tc.wantStatus, response.Body.String())
			}
			if len(enforcer.calls) != tc.wantEnforce {
				t.Fatalf("enforcer calls = %d, want %d", len(enforcer.calls), tc.wantEnforce)
			}
			if loader.lookups != tc.wantLookupCall {
				t.Fatalf("server mapping lookups = %d, want %d", loader.lookups, tc.wantLookupCall)
			}
		})
	}
}

func TestHandleWebhookDispatchesOnlyVerifiedScreenSharePublication(t *testing.T) {
	encryptionKey := bytes.Repeat([]byte("k"), 32)
	instance := encryptedWebhookInstance(t, "instance-a", "key-a", "secret-a", encryptionKey)
	for _, tc := range []struct {
		name       string
		track      *livekit.TrackInfo
		identity   string
		wantCalls  int
		wantStatus int
	}{
		{name: "native _ss screen video", track: &livekit.TrackInfo{Sid: "TR_screen", Type: livekit.TrackType_VIDEO, Source: livekit.TrackSource_SCREEN_SHARE}, identity: "user-a_ss", wantCalls: 1, wantStatus: http.StatusOK},
		{name: "camera video ignored", track: &livekit.TrackInfo{Sid: "TR_camera", Type: livekit.TrackType_VIDEO, Source: livekit.TrackSource_CAMERA}, identity: "user-a_ss", wantStatus: http.StatusOK},
		{name: "screen audio ignored", track: &livekit.TrackInfo{Sid: "TR_audio", Type: livekit.TrackType_AUDIO, Source: livekit.TrackSource_SCREEN_SHARE_AUDIO}, identity: "user-a_ss", wantStatus: http.StatusOK},
		{name: "web main identity accepted", track: &livekit.TrackInfo{Sid: "TR_screen", Type: livekit.TrackType_VIDEO, Source: livekit.TrackSource_SCREEN_SHARE}, identity: "user-a", wantCalls: 1, wantStatus: http.StatusOK},
		{name: "empty track sid ignored", track: &livekit.TrackInfo{Type: livekit.TrackType_VIDEO, Source: livekit.TrackSource_SCREEN_SHARE}, identity: "user-a_ss", wantStatus: http.StatusOK},
	} {
		t.Run(tc.name, func(t *testing.T) {
			loader := &webhookBindingRepo{instances: []models.LiveKitInstance{instance}, byServer: map[string]*models.LiveKitInstance{"server-a": &instance}}
			h := NewLiveKitWebhookHandler(loader, encryptionKey, noopAppLog{}, &recordingEnforcer{}, loader)
			notifier := &recordingStreamNotifier{}
			h.SetStreamStartNotifier(notifier)
			event := &livekit.WebhookEvent{
				Event:       "track_published",
				Room:        &livekit.Room{Name: "server-a:channel-a"},
				Participant: &livekit.ParticipantInfo{Identity: tc.identity},
				Track:       tc.track,
				CreatedAt:   time.Now().Unix(),
			}
			req, response := signedWebhookRequest(t, event, "key-a", "secret-a")
			h.HandleWebhook(response, req)
			if response.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d; body=%s", response.Code, tc.wantStatus, response.Body.String())
			}
			if len(notifier.calls) != tc.wantCalls {
				t.Fatalf("notification calls = %d, want %d", len(notifier.calls), tc.wantCalls)
			}
			if tc.wantCalls == 1 {
				call := notifier.calls[0]
				if call.issuerInstanceID != "instance-a" || call.serverID != "server-a" || call.channelID != "channel-a" || call.actorID != "user-a" || call.roomName != "server-a:channel-a" || call.trackSID != "TR_screen" || call.publicationTime.Unix() != event.GetCreatedAt() {
					t.Fatalf("notification arguments = %+v", call)
				}
			}
		})
	}
}

func TestHandleWebhookRetriesWhenStreamNotificationProcessingFails(t *testing.T) {
	encryptionKey := bytes.Repeat([]byte("k"), 32)
	instance := encryptedWebhookInstance(t, "instance-a", "key-a", "secret-a", encryptionKey)
	loader := &webhookBindingRepo{instances: []models.LiveKitInstance{instance}, byServer: map[string]*models.LiveKitInstance{"server-a": &instance}}
	h := NewLiveKitWebhookHandler(loader, encryptionKey, noopAppLog{}, &recordingEnforcer{}, loader)
	notifier := &recordingStreamNotifier{err: services.ErrScreenShareNotVisible}
	h.SetStreamStartNotifier(notifier)
	event := &livekit.WebhookEvent{
		Event:       "track_published",
		Room:        &livekit.Room{Name: "server-a:channel-a"},
		Participant: &livekit.ParticipantInfo{Identity: "user-a_ss"},
		Track:       &livekit.TrackInfo{Sid: "TR_screen", Type: livekit.TrackType_VIDEO, Source: livekit.TrackSource_SCREEN_SHARE},
		CreatedAt:   time.Now().Unix(),
	}
	req, response := signedWebhookRequest(t, event, "key-a", "secret-a")
	h.HandleWebhook(response, req)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d; body=%s", response.Code, http.StatusServiceUnavailable, response.Body.String())
	}
	if len(notifier.calls) != 1 {
		t.Fatalf("notification calls = %d, want 1", len(notifier.calls))
	}
}

func TestHandleWebhookSkipsExpiredOrFutureStreamStartBeforeNotifier(t *testing.T) {
	encryptionKey := bytes.Repeat([]byte("k"), 32)
	instance := encryptedWebhookInstance(t, "instance-a", "key-a", "secret-a", encryptionKey)
	for _, tc := range []struct {
		name      string
		createdAt int64
	}{
		{name: "expired", createdAt: time.Now().Add(-3 * time.Minute).Unix()},
		{name: "invalid future", createdAt: time.Now().Add(time.Minute).Unix()},
	} {
		t.Run(tc.name, func(t *testing.T) {
			loader := &webhookBindingRepo{instances: []models.LiveKitInstance{instance}, byServer: map[string]*models.LiveKitInstance{"server-a": &instance}}
			h := NewLiveKitWebhookHandler(loader, encryptionKey, noopAppLog{}, &recordingEnforcer{}, loader)
			notifier := &recordingStreamNotifier{}
			h.SetStreamStartNotifier(notifier)
			event := &livekit.WebhookEvent{
				Event:       "track_published",
				Room:        &livekit.Room{Name: "server-a:channel-a"},
				Participant: &livekit.ParticipantInfo{Identity: "user-a_ss"},
				Track:       &livekit.TrackInfo{Sid: "TR_screen", Type: livekit.TrackType_VIDEO, Source: livekit.TrackSource_SCREEN_SHARE},
				CreatedAt:   tc.createdAt,
			}
			req, response := signedWebhookRequest(t, event, "key-a", "secret-a")
			h.HandleWebhook(response, req)
			if response.Code != http.StatusOK || len(notifier.calls) != 0 {
				t.Fatalf("expired callback status=%d notifications=%d, want ACK and no notification", response.Code, len(notifier.calls))
			}
		})
	}
}
