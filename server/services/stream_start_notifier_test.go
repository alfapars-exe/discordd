package services

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg/crypto"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
	livekit "github.com/livekit/protocol/livekit"
	"google.golang.org/protobuf/proto"
)

type streamNotifierRepoFake struct {
	recipients []string
	dueCalls   int
	deliveries []string
	deliverErr error
	results    []*models.Notification
	errors     []error
}

func (r *streamNotifierRepoFake) DueRecipients(_ context.Context, publicationID, _ string, _ string, _ int) ([]string, error) {
	r.dueCalls++
	if publicationID == "" {
		return nil, errors.New("missing publication ID")
	}
	return append([]string(nil), r.recipients...), nil
}

func (r *streamNotifierRepoFake) Deliver(_ context.Context, publicationID, roomName, trackSID, serverID, channelID, actorID, recipientID string, _ time.Time) (*models.Notification, error) {
	if publicationID == "" || roomName != serverID+":"+channelID || trackSID == "" || actorID == recipientID {
		return nil, io.ErrUnexpectedEOF
	}
	r.deliveries = append(r.deliveries, recipientID)
	index := len(r.deliveries) - 1
	if index < len(r.errors) && r.errors[index] != nil {
		return nil, r.errors[index]
	}
	if index < len(r.results) {
		return r.results[index], nil
	}
	return nil, r.deliverErr
}

var _ repository.StreamStartNotificationRepository = (*streamNotifierRepoFake)(nil)

type streamVerifierFake struct {
	results []bool
	errs    []error
	calls   int
	err     error
}

type streamVerifierTimeoutChecker struct{ active bool }

func (c streamVerifierTimeoutChecker) IsActive(context.Context, string, string) (bool, error) {
	return c.active, nil
}

type streamVerifierBanChecker struct{ banned bool }

func (c streamVerifierBanChecker) Exists(context.Context, string, string) (bool, error) {
	return c.banned, nil
}

func (v *streamVerifierFake) VerifyCurrentScreenShare(context.Context, string, string, string, string, string) (bool, error) {
	v.calls++
	if v.err != nil {
		return false, v.err
	}
	if index := v.calls - 1; index < len(v.errs) && v.errs[index] != nil {
		return false, v.errs[index]
	}
	if len(v.results) == 0 {
		return true, nil
	}
	index := v.calls - 1
	if index >= len(v.results) {
		index = len(v.results) - 1
	}
	return v.results[index], nil
}

func TestStreamStartNotifierRetriesFreshProviderVisibilityGap(t *testing.T) {
	publicationTime := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	repo := &streamNotifierRepoFake{recipients: []string{"friend"}, results: []*models.Notification{{ID: "notice", UserID: "friend"}}}
	verifier := &streamVerifierFake{
		errs:    []error{ErrScreenShareNotVisible, nil, nil},
		results: []bool{false, true, true},
	}
	hub := &testutil.MockBroadcaster{}
	notifier := &streamStartNotifier{repo: repo, verifier: verifier, hub: hub, clock: func() time.Time { return publicationTime.Add(5 * time.Second) }}
	if err := notifier.NotifyStreamStart(context.Background(), "lk-1", "server-1", "channel-1", "actor-1", "server-1:channel-1", "TR_track", publicationTime); !errors.Is(err, ErrScreenShareNotVisible) {
		t.Fatalf("first attempt error = %v, want ErrScreenShareNotVisible", err)
	}
	if repo.dueCalls != 0 || len(repo.deliveries) != 0 {
		t.Fatalf("invisible attempt reached delivery: due=%d deliveries=%v", repo.dueCalls, repo.deliveries)
	}
	if err := notifier.NotifyStreamStart(context.Background(), "lk-1", "server-1", "channel-1", "actor-1", "server-1:channel-1", "TR_track", publicationTime); err != nil {
		t.Fatalf("retry after provider publication appeared: %v", err)
	}
	if repo.dueCalls != 1 || len(repo.deliveries) != 1 || repo.deliveries[0] != "friend" {
		t.Fatalf("retry results: due=%d deliveries=%v; want one delivery", repo.dueCalls, repo.deliveries)
	}
}

func TestStreamStartNotifierAcksExpiredOrFuturePublicationWithoutRetry(t *testing.T) {
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name string
		at   time.Time
	}{
		{name: "expired", at: now.Add(-streamStartPublicationMaxAge - time.Second)},
		{name: "future beyond allowed skew", at: now.Add(streamStartPublicationFutureSkew + time.Second)},
		{name: "missing timestamp", at: time.Time{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repo := &streamNotifierRepoFake{recipients: []string{"friend"}}
			verifier := &streamVerifierFake{}
			notifier := &streamStartNotifier{repo: repo, verifier: verifier, hub: &testutil.MockBroadcaster{}, clock: func() time.Time { return now }}
			err := notifier.NotifyStreamStart(context.Background(), "lk-1", "server-1", "channel-1", "actor-1", "server-1:channel-1", "TR_track", tc.at)
			if err != nil {
				t.Fatalf("expired/invalid callback error = %v, want ACK", err)
			}
			if verifier.calls != 0 || repo.dueCalls != 0 || len(repo.deliveries) != 0 {
				t.Fatalf("callback did work after age rejection: verifies=%d due=%d deliveries=%v", verifier.calls, repo.dueCalls, repo.deliveries)
			}
		})
	}
}

func TestStreamStartNotifierAuthorizationDenialDoesNotRequestRetry(t *testing.T) {
	repo := &streamNotifierRepoFake{recipients: []string{"friend"}}
	verifier := &streamVerifierFake{results: []bool{false}}
	notifier := &streamStartNotifier{repo: repo, verifier: verifier, hub: &testutil.MockBroadcaster{}, clock: time.Now}
	if err := notifier.NotifyStreamStart(context.Background(), "lk-1", "server-1", "channel-1", "actor-1", "server-1:channel-1", "TR_track", time.Now()); err != nil {
		t.Fatalf("authorization-denied callback error = %v, want ACK", err)
	}
	if repo.dueCalls != 0 || len(repo.deliveries) != 0 {
		t.Fatalf("authorization-denied callback reached delivery: due=%d deliveries=%v", repo.dueCalls, repo.deliveries)
	}
}

func TestStreamStartNotifierRevalidatesBeforeEachRecipient(t *testing.T) {
	repo := &streamNotifierRepoFake{recipients: []string{"recipient-1", "recipient-2"}}
	verifier := &streamVerifierFake{results: []bool{true, true, false}}
	notifier := NewStreamStartNotifier(repo, verifier, &testutil.MockBroadcaster{})
	err := notifier.NotifyStreamStart(context.Background(), "lk-1", "server-1", "channel-1", "actor-1", "server-1:channel-1", "TR_track", time.Now())
	if err != nil {
		t.Fatalf("NotifyStreamStart() error = %v", err)
	}
	if repo.dueCalls != 1 || verifier.calls != 3 {
		t.Fatalf("calls: due=%d verify=%d, want 1 and 3", repo.dueCalls, verifier.calls)
	}
	if len(repo.deliveries) != 1 || repo.deliveries[0] != "recipient-1" {
		t.Fatalf("deliveries = %v, want only first recipient before provider track stopped", repo.deliveries)
	}
}

func TestStreamStartNotifierSkipsStalePublicationAndRejectsBadIdentifiers(t *testing.T) {
	repo := &streamNotifierRepoFake{recipients: []string{"recipient"}}
	notifier := NewStreamStartNotifier(repo, &streamVerifierFake{results: []bool{false}}, &testutil.MockBroadcaster{})
	if err := notifier.NotifyStreamStart(context.Background(), "lk-1", "server-1", "channel-1", "actor", "server-1:channel-1", "TR_track", time.Now()); err != nil {
		t.Fatalf("stale publication error = %v", err)
	}
	if repo.dueCalls != 0 || len(repo.deliveries) != 0 {
		t.Fatalf("stale publication reached repository: due=%d deliveries=%v", repo.dueCalls, repo.deliveries)
	}
	if err := notifier.NotifyStreamStart(context.Background(), "lk-1", "server-1", "channel-1", "actor", "other:room", "TR_track", time.Now()); err == nil {
		t.Fatal("mismatched room identifiers were accepted")
	}
}

func TestStreamStartNotifierBroadcastsOnlyCommittedNotifications(t *testing.T) {
	committed := &models.Notification{ID: "n1", UserID: "recipient-1", Kind: models.NotificationKindSystem, Payload: json.RawMessage(`{"action":"stream_start"}`)}
	repo := &streamNotifierRepoFake{
		recipients: []string{"recipient-1", "recipient-2", "recipient-3"},
		results:    []*models.Notification{committed, nil, nil},
		errors:     []error{nil, nil, errors.New("database error")},
	}
	var broadcastUsers []string
	var broadcastEvents []interface{}
	hub := &testutil.MockBroadcaster{BroadcastToUserFn: func(userID string, event ws.Event) {
		broadcastUsers = append(broadcastUsers, userID)
		broadcastEvents = append(broadcastEvents, event)
	}}
	notifier := NewStreamStartNotifier(repo, &streamVerifierFake{}, hub)
	err := notifier.NotifyStreamStart(context.Background(), "lk-1", "server-1", "channel-1", "actor-1", "server-1:channel-1", "TR_track", time.Now())
	if err == nil {
		t.Fatal("delivery error was swallowed")
	}
	if len(broadcastUsers) != 1 || broadcastUsers[0] != "recipient-1" || len(broadcastEvents) != 1 {
		t.Fatalf("broadcasts: users=%v events=%d; want one committed notice only", broadcastUsers, len(broadcastEvents))
	}
	event, ok := broadcastEvents[0].(ws.Event)
	if !ok || event.Op != ws.OpNotificationCreate || event.Data != committed {
		t.Fatalf("broadcast event = %#v, want notification create for committed row", broadcastEvents[0])
	}
}

func TestVerifyCurrentScreenShareUsesLiveKitParticipantAndExactTrack(t *testing.T) {
	key := []byte("01234567890123456789012345678901")
	apiKey, err := crypto.Encrypt("test-key", key)
	if err != nil {
		t.Fatal(err)
	}
	apiSecret, err := crypto.Encrypt("test-secret", key)
	if err != nil {
		t.Fatal(err)
	}
	var identities []string
	missingIdentity := ""
	mainHasTrack := true
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, readErr := io.ReadAll(r.Body)
		if readErr != nil {
			t.Errorf("read Twirp request: %v", readErr)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		request := new(livekit.RoomParticipantIdentity)
		if unmarshalErr := proto.Unmarshal(body, request); unmarshalErr != nil {
			t.Errorf("decode Twirp request: %v (content-type %q)", unmarshalErr, r.Header.Get("Content-Type"))
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		identities = append(identities, request.GetIdentity())
		if request.GetIdentity() == missingIdentity {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"code":"not_found","msg":"participant not found"}`))
			return
		}
		participant := &livekit.ParticipantInfo{Identity: request.GetIdentity()}
		if strings.HasSuffix(request.GetIdentity(), "_ss") || request.GetIdentity() == "actor-1" && mainHasTrack {
			participant.Tracks = []*livekit.TrackInfo{{Sid: "TR_expected", Type: livekit.TrackType_VIDEO, Source: livekit.TrackSource_SCREEN_SHARE}}
		}
		response, marshalErr := proto.Marshal(participant)
		if marshalErr != nil {
			t.Errorf("encode Twirp response: %v", marshalErr)
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/protobuf")
		_, _ = w.Write(response)
	}))
	defer server.Close()

	livekitGetter := &mockConfigurableLiveKitGetter{GetByServerIDFn: func(_ context.Context, serverID string) (*models.LiveKitInstance, error) {
		if serverID != "server-1" {
			t.Fatalf("GetByServerID(%q), want server-1", serverID)
		}
		return &models.LiveKitInstance{ID: "lk-current", URL: server.URL, APIKey: apiKey, APISecret: apiSecret}, nil
	}}
	channels := &testutil.MockChannelRepo{GetByIDFn: func(_ context.Context, channelID string) (*models.Channel, error) {
		return &models.Channel{ID: channelID, ServerID: "server-1", Type: models.ChannelTypeVoice}, nil
	}}
	permissions := &testutil.MockChannelPermResolver{ResolveChannelPermissionsFn: func(context.Context, string, string) (models.Permission, error) {
		// Voice channel visibility does not require the text ReadMessages bit.
		return models.PermViewChannel | models.PermConnectVoice | models.PermStream, nil
	}}
	servers := &testutil.MockServerRepo{IsMemberFn: func(context.Context, string, string) (bool, error) { return true, nil }}
	service := NewVoiceService(channels, livekitGetter, permissions, nil, nil, servers, key, streamVerifierTimeoutChecker{}, streamVerifierBanChecker{}, nil).(*voiceService)
	service.states["actor-1"] = &models.VoiceState{UserID: "actor-1", ServerID: "server-1", ChannelID: "channel-1"}

	valid, err := service.VerifyCurrentScreenShare(context.Background(), "lk-current", "server-1", "channel-1", "actor-1", "TR_expected")
	if err != nil || !valid {
		t.Fatalf("VerifyCurrentScreenShare() = (%v, %v), want (true, nil)", valid, err)
	}
	if len(identities) != 1 || identities[0] != "actor-1" {
		t.Fatalf("queried identities = %v, want only web/main identity", identities)
	}
	// Web screen sharing is published on the main participant; the verifier
	// succeeds without needing a separate _ss participant lookup.
	mainHasTrack = false
	identities = nil
	valid, err = service.VerifyCurrentScreenShare(context.Background(), "lk-current", "server-1", "channel-1", "actor-1", "TR_expected")
	if err != nil || !valid {
		t.Fatalf("native _ss fallback result = (%v, %v), want (true, nil)", valid, err)
	}
	if len(identities) != 2 || identities[0] != "actor-1" || identities[1] != "actor-1_ss" {
		t.Fatalf("native fallback queried identities = %v, want main and _ss", identities)
	}
	for _, identity := range []string{"actor-1", "actor-1_ss"} {
		missingIdentity = identity
		valid, err = service.VerifyCurrentScreenShare(context.Background(), "lk-current", "server-1", "channel-1", "actor-1", "TR_expected")
		if valid || !errors.Is(err, ErrScreenShareNotVisible) {
			t.Fatalf("invisible participant %q result = (%v, %v), want retryable sentinel", identity, valid, err)
		}
	}
	missingIdentity = "actor-1_ss"
	publicationTime := time.Now().UTC()
	repo := &streamNotifierRepoFake{recipients: []string{"friend"}, results: []*models.Notification{{ID: "notice", UserID: "friend"}}}
	notifier := &streamStartNotifier{repo: repo, verifier: service, hub: &testutil.MockBroadcaster{}, clock: time.Now}
	if err := notifier.NotifyStreamStart(context.Background(), "lk-current", "server-1", "channel-1", "actor-1", "server-1:channel-1", "TR_expected", publicationTime); !errors.Is(err, ErrScreenShareNotVisible) {
		t.Fatalf("provider-not-found notifier result = %v, want retryable sentinel", err)
	}
	if repo.dueCalls != 0 || len(repo.deliveries) != 0 {
		t.Fatalf("not-visible attempt reached delivery: due=%d deliveries=%v", repo.dueCalls, repo.deliveries)
	}
	missingIdentity = ""
	if err := notifier.NotifyStreamStart(context.Background(), "lk-current", "server-1", "channel-1", "actor-1", "server-1:channel-1", "TR_expected", publicationTime); err != nil {
		t.Fatalf("same event retry after provider track became visible: %v", err)
	}
	if repo.dueCalls != 1 || len(repo.deliveries) != 1 || repo.deliveries[0] != "friend" {
		t.Fatalf("replayed event deliveries: due=%d recipients=%v; want exactly one", repo.dueCalls, repo.deliveries)
	}
	valid, err = service.VerifyCurrentScreenShare(context.Background(), "lk-current", "server-1", "channel-1", "actor-1", "TR_other")
	if valid || !errors.Is(err, ErrScreenShareNotVisible) {
		t.Fatalf("wrong track SID result = (%v, %v), want retryable sentinel", valid, err)
	}
	rolePermissions := models.Permission(models.PermViewChannel | models.PermConnectVoice | models.PermStream)
	roles := &testutil.MockRoleRepo{GetByUserIDAndServerFn: func(context.Context, string, string) ([]models.Role, error) {
		return []models.Role{{ID: "role-1", ServerID: "server-1", Permissions: rolePermissions}}, nil
	}}
	permissionRepo := &testutil.MockChannelPermRepo{GetByChannelAndRolesFn: func(context.Context, string, []string) ([]models.ChannelPermissionOverride, error) {
		return nil, nil
	}}
	cachedPermissions := NewChannelPermissionService(permissionRepo, roles, channels, nil)
	if _, err := cachedPermissions.ResolveChannelPermissions(context.Background(), "actor-1", "channel-1"); err != nil {
		t.Fatalf("warm permission cache: %v", err)
	}
	rolePermissions = models.PermViewChannel | models.PermConnectVoice // Stream was revoked elsewhere after cache fill.
	service.permResolver = cachedPermissions
	lookupsBeforeRevokedCheck := len(identities)
	valid, err = service.VerifyCurrentScreenShare(context.Background(), "lk-current", "server-1", "channel-1", "actor-1", "TR_expected")
	if err != nil || valid {
		t.Fatalf("revoked stream permission result = (%v, %v), want (false, nil)", valid, err)
	}
	if len(identities) != lookupsBeforeRevokedCheck {
		t.Fatalf("provider was queried after fresh permission revocation: identities=%v", identities)
	}
	service.permResolver = permissions
	service.timeoutChecker = streamVerifierTimeoutChecker{active: true}
	valid, err = service.VerifyCurrentScreenShare(context.Background(), "lk-current", "server-1", "channel-1", "actor-1", "TR_expected")
	if err != nil || valid {
		t.Fatalf("timed-out actor result = (%v, %v), want (false, nil)", valid, err)
	}
	service.timeoutChecker = streamVerifierTimeoutChecker{}
	service.banChecker = streamVerifierBanChecker{banned: true}
	valid, err = service.VerifyCurrentScreenShare(context.Background(), "lk-current", "server-1", "channel-1", "actor-1", "TR_expected")
	if err != nil || valid {
		t.Fatalf("banned actor result = (%v, %v), want (false, nil)", valid, err)
	}
	service.banChecker = streamVerifierBanChecker{}
	valid, err = service.VerifyCurrentScreenShare(context.Background(), "lk-old", "server-1", "channel-1", "actor-1", "TR_expected")
	if err != nil || valid {
		t.Fatalf("migrated instance result = (%v, %v), want (false, nil)", valid, err)
	}
	valid, err = service.VerifyCurrentScreenShare(context.Background(), "lk-current", "server-1", "channel-1", "actor-1", "")
	if err == nil || valid {
		t.Fatalf("empty SID result = (%v, %v), want fail-closed error", valid, err)
	}
}
