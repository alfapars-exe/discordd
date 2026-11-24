package services

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"log/slog"
	"reflect"
	"slices"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/crypto"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"

	"github.com/livekit/protocol/auth"
	livekit "github.com/livekit/protocol/livekit"
)

// ─── MoveUser on the snapshot path (voiceAccess != nil) ───
//
// Production (PostgreSQL) wires a repository.VoiceAccessReader; every other
// MoveUser test in this package runs without one and so pins the portable
// path. These pin the snapshot path: one access read for the moved user
// issued together with the mover's permission reads, and the target room's
// credentials embedded in voice_force_move.

// moveSnapshotAccess is a VoiceAccessReader fake that answers like the
// repository's single-statement reads (repository/voice_access.go): the
// token read joins the server's LiveKit instance, so a server without one
// is pkg.ErrNotFound there but not in the plain admission read.
type moveSnapshotAccess struct {
	mu          sync.Mutex
	instance    *models.LiveKitInstance // nil: no LiveKit instance linked to the server
	used        int64
	servers     map[string]string // channelID -> serverID; default "srv1"
	textChannel map[string]bool
	missing     map[string]bool
	timedOut    map[string]bool
	nonMember   map[string]bool
	perms       func(userID, channelID string) models.Permission // default PermAll
	onTokenRead func()                                           // runs inside the token read, outside mu
	delay       time.Duration

	tokenReads     []string // "user/channel"
	admissionReads []string
}

func (a *moveSnapshotAccess) admissionLocked(userID, channelID string) (*models.VoiceAdmission, error) {
	if a.missing[channelID] {
		return nil, pkg.ErrNotFound
	}
	admission := &models.VoiceAdmission{
		Channel:  models.Channel{ID: channelID, ServerID: "srv1", Type: models.ChannelTypeVoice},
		Member:   !a.nonMember[userID],
		TimedOut: a.timedOut[userID],
	}
	if serverID, ok := a.servers[channelID]; ok {
		admission.Channel.ServerID = serverID
	}
	if a.textChannel[channelID] {
		admission.Channel.Type = models.ChannelTypeText
	}
	// A non-member has no roles, so the query's permission bits are zero.
	if admission.Member {
		admission.Permissions = models.PermAll
		if a.perms != nil {
			admission.Permissions = a.perms(userID, channelID)
		}
	}
	return admission, nil
}

func (a *moveSnapshotAccess) VoiceAdmission(_ context.Context, userID, channelID string) (*models.VoiceAdmission, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.admissionReads = append(a.admissionReads, userID+"/"+channelID)
	return a.admissionLocked(userID, channelID)
}

func (a *moveSnapshotAccess) VoiceTokenAccess(_ context.Context, userID, channelID string, _ time.Time) (*models.VoiceAdmission, *models.LiveKitInstance, int64, error) {
	a.mu.Lock()
	a.tokenReads = append(a.tokenReads, userID+"/"+channelID)
	hook, delay := a.onTokenRead, a.delay
	a.mu.Unlock()
	if hook != nil {
		hook()
	}
	time.Sleep(delay)

	a.mu.Lock()
	defer a.mu.Unlock()
	admission, err := a.admissionLocked(userID, channelID)
	if err != nil {
		return nil, nil, 0, err
	}
	if a.instance == nil {
		return nil, nil, 0, pkg.ErrNotFound
	}
	instance := *a.instance
	return admission, &instance, a.used, nil
}

func (a *moveSnapshotAccess) VoiceVisibleUsers(_ context.Context, _, _ string, online []string) ([]string, error) {
	return online, nil
}

func (a *moveSnapshotAccess) VoiceVisibleUsersByChannel(_ context.Context, _ string, channelIDs, online []string) (map[string][]string, error) {
	visible := make(map[string][]string, len(channelIDs))
	for _, id := range channelIDs {
		visible[id] = online
	}
	return visible, nil
}

func (a *moveSnapshotAccess) set(change func(*moveSnapshotAccess)) {
	a.mu.Lock()
	defer a.mu.Unlock()
	change(a)
}

// reads returns and clears the reads recorded so far.
func (a *moveSnapshotAccess) reads() (tokens, admissions []string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	tokens, admissions = a.tokenReads, a.admissionReads
	a.tokenReads, a.admissionReads = nil, nil
	return tokens, admissions
}

type moveSnapshotUserEvent struct {
	userID string
	event  ws.Event
}

type moveSnapshotFixture struct {
	svc    *voiceService
	access *moveSnapshotAccess
	events chan moveSnapshotUserEvent // BroadcastToUser deliveries

	mu             sync.Mutex
	moverPerms     func(userID, channelID string) (models.Permission, error) // default PermAll
	onResolve      func(userID, channelID string)                            // runs inside the resolve, outside mu
	resolves       []string                                                  // "user/channel" asked of the cached resolver
	channelLookups []string                                                  // channelGetter.GetByID ids
}

func (f *moveSnapshotFixture) set(change func(*moveSnapshotFixture)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	change(f)
}

func (f *moveSnapshotFixture) resolved() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	resolves := slices.Clone(f.resolves)
	f.resolves = nil
	sort.Strings(resolves)
	return resolves
}

// forceMove returns the next voice_force_move sent to userID.
func (f *moveSnapshotFixture) forceMove(t *testing.T, userID string) ws.VoiceForceMoveData {
	t.Helper()
	timeout := time.After(2 * time.Second)
	for {
		select {
		case delivered := <-f.events:
			if delivered.event.Op != ws.OpVoiceForceMove {
				continue
			}
			if delivered.userID != userID {
				t.Fatalf("voice_force_move sent to %q, want %q", delivered.userID, userID)
			}
			data, ok := delivered.event.Data.(ws.VoiceForceMoveData)
			if !ok {
				t.Fatalf("voice_force_move payload is %T", delivered.event.Data)
			}
			return data
		case <-timeout:
			t.Fatal("no voice_force_move event")
		}
	}
}

// forceMoves returns every voice_force_move delivered so far, in order.
// MoveUser sends on its own goroutine, so once it has returned nothing more
// is on the way.
func (f *moveSnapshotFixture) forceMoves(t *testing.T) []ws.VoiceForceMoveData {
	t.Helper()
	var moves []ws.VoiceForceMoveData
	for {
		select {
		case delivered := <-f.events:
			if delivered.event.Op != ws.OpVoiceForceMove {
				continue
			}
			data, ok := delivered.event.Data.(ws.VoiceForceMoveData)
			if !ok {
				t.Fatalf("voice_force_move payload is %T", delivered.event.Data)
			}
			moves = append(moves, data)
		default:
			return moves
		}
	}
}

func (f *moveSnapshotFixture) join(t *testing.T, userID, channelID string) {
	t.Helper()
	if err := f.svc.JoinChannel(userID, userID, strings.ToUpper(userID), "", channelID, false, false); err != nil {
		t.Fatalf("join %s into %s: %v", userID, channelID, err)
	}
	f.access.reads()
	f.resolved()
}

// replaceAccess swaps the service's access reader for one that wraps the
// fixture's, after joins have already run on the fixture. A join's voice
// state broadcast starts the fanout worker, which reads s.voiceAccess on its
// own goroutine (voice_state_fanout.go); nothing orders that read against a
// later write of the field. The worker is therefore stopped first — the stop
// waits for it — and what is broadcast afterwards is dropped, which these
// tests do not look at: they observe BroadcastToUser only. Production never
// reassigns the field.
func (f *moveSnapshotFixture) replaceAccess(reader repository.VoiceAccessReader) {
	f.svc.ShutdownVoiceStateFanout()
	f.svc.voiceAccess = reader
}

// newMoveSnapshotFixture builds a voice service wired like production's
// snapshot mode. The LiveKit getter always errors (mockLiveKitGetter), so
// the asynchronous source-room eviction exits before any network call and —
// the point of these tests — the only place valid LiveKit credentials exist
// is the access snapshot.
func newMoveSnapshotFixture(t *testing.T) *moveSnapshotFixture {
	t.Helper()
	encAPIKey, err := crypto.Encrypt(tokenTestAPIKey, tokenTestEncryptionKey)
	if err != nil {
		t.Fatalf("setup: encrypt api key: %v", err)
	}
	encAPISecret, err := crypto.Encrypt(tokenTestAPISecret, tokenTestEncryptionKey)
	if err != nil {
		t.Fatalf("setup: encrypt api secret: %v", err)
	}
	f := &moveSnapshotFixture{
		access: &moveSnapshotAccess{instance: &models.LiveKitInstance{
			ID: "lk1", URL: "wss://fake.example", APIKey: encAPIKey, APISecret: encAPISecret,
		}},
		events: make(chan moveSnapshotUserEvent, 16),
	}
	hub := &testutil.MockBroadcaster{
		BroadcastToServerFn: func(string, ws.Event) {},
		BroadcastToUserFn: func(userID string, event ws.Event) {
			f.events <- moveSnapshotUserEvent{userID, event}
		},
	}
	f.svc = NewVoiceService(
		&testutil.MockChannelRepo{
			GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
				f.set(func(f *moveSnapshotFixture) { f.channelLookups = append(f.channelLookups, id) })
				return &models.Channel{ID: id, ServerID: "srv1", Type: models.ChannelTypeVoice}, nil
			},
		},
		&mockLiveKitGetter{},
		&testutil.MockChannelPermResolver{
			ResolveChannelPermissionsFn: func(_ context.Context, userID, channelID string) (models.Permission, error) {
				f.mu.Lock()
				f.resolves = append(f.resolves, userID+"/"+channelID)
				perms, hook := f.moverPerms, f.onResolve
				f.mu.Unlock()
				if hook != nil {
					hook(userID, channelID)
				}
				if perms != nil {
					return perms(userID, channelID)
				}
				return models.PermAll, nil
			},
		},
		&voiceTestBroadcaster{hub},
		nil, // onlineChecker
		&testutil.MockServerRepo{
			IsMemberFn: func(context.Context, string, string) (bool, error) { return true, nil },
		},
		tokenTestEncryptionKey,
		nil, // timeoutChecker — the snapshot carries the timeout flag
		nil, // banChecker
		nil, // auditLogger
		VoiceRuntimeDependencies{Fanout: voiceFixtureFanout(hub), VoiceAccess: f.access},
	).(*voiceService)
	t.Cleanup(f.svc.ShutdownVoiceStateFanout)
	// Credentials are minted from the move's own access snapshot only while it
	// is fresh, which is wall-clock time. A stalled test run must not turn
	// "one access read" into "read again", so the bound is out of reach here;
	// the tests that pin it move it themselves (coldMoverCache, freshAgain).
	maxSnapshotAge := voiceMoveCredentialsMaxSnapshotAge
	voiceMoveCredentialsMaxSnapshotAge = time.Hour
	t.Cleanup(func() { voiceMoveCredentialsMaxSnapshotAge = maxSnapshotAge })
	// The same goes for the repeated read's own deadline: a stalled run must
	// not turn a re-read that answered into one that timed out. The test that
	// pins the deadline sets it itself.
	refreshTimeout := voiceMoveRefreshTimeout
	voiceMoveRefreshTimeout = time.Hour
	t.Cleanup(func() { voiceMoveRefreshTimeout = refreshTimeout })
	return f
}

// coldMoverCache arranges the next moderator move the way a cold permission
// cache makes it in production: by the time the mover's permission reads are
// back, the access snapshot read alongside them is past its bound. Nothing
// waits for wall-clock time to pass — the bound itself runs out while those
// reads are in flight (below zero: every snapshot is stale from then on,
// until freshAgain), which no stalled test run can undo. The write is ordered
// before moveCredentials' reads of the bound by MoveUser waiting for the
// permission reads.
func (f *moveSnapshotFixture) coldMoverCache() {
	var expire sync.Once
	f.set(func(f *moveSnapshotFixture) {
		f.onResolve = func(string, string) {
			expire.Do(func() { voiceMoveCredentialsMaxSnapshotAge = -1 })
		}
	})
}

// freshAgain puts the bound back out of reach. Called from inside the access
// read MoveUser repeats (onAccessRead, read 2), it makes that read's snapshot
// a fresh one whatever the test run's timing.
func freshAgain() { voiceMoveCredentialsMaxSnapshotAge = time.Hour }

// onAccessRead runs hook inside every token read from now on, before the
// read answers, with the read's number: 1 is the next move's own access
// read, 2 the one moveCredentials repeats. Both run on MoveUser's goroutine.
func (f *moveSnapshotFixture) onAccessRead(hook func(read int)) {
	read := 0
	f.access.set(func(a *moveSnapshotAccess) {
		a.onTokenRead = func() {
			read++
			hook(read)
		}
	})
}

// mint calls moveCredentials for "victim" and checks that the source it
// reports agrees with whether it returned credentials.
func (f *moveSnapshotFixture) mint(t *testing.T, reads *voiceMoveReads, placement voiceMovePlacement) (*models.VoiceTokenResponse, string) {
	t.Helper()
	voice, source := f.svc.moveCredentials(context.Background(), reads, placement, "victim")
	switch source {
	case voiceMoveCredentialsSnapshot, voiceMoveCredentialsRefreshed:
		if voice == nil {
			t.Fatalf("no credentials reported as %q", source)
		}
	case voiceMoveCredentialsNone:
		if voice != nil {
			t.Fatal("credentials reported as not embedded")
		}
	default:
		t.Fatalf("unknown credentials source %q", source)
	}
	return voice, source
}

// moveReadsAt is MoveUser's database phase as startMoveReads leaves it for
// an access read that answered at readAt.
func moveReadsAt(admission *models.VoiceAdmission, instance *models.LiveKitInstance, used int64, readAt time.Time) *voiceMoveReads {
	return &voiceMoveReads{voiceMoveSnapshot: voiceMoveSnapshot{admission: admission, instance: instance, used: used, readAt: readAt}}
}

// decodeVoiceClaims verifies tokenString against the test API secret and
// returns its claims (identity, name, video grant).
func decodeVoiceClaims(t *testing.T, tokenString string) *auth.ClaimGrants {
	t.Helper()
	verifier, err := auth.ParseAPIToken(tokenString)
	if err != nil {
		t.Fatalf("ParseAPIToken: %v", err)
	}
	_, claims, err := verifier.Verify(tokenTestAPISecret)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if claims.Video == nil {
		t.Fatal("expected a video grant in the token")
	}
	return claims
}

func jsonKeys(t *testing.T, value any) []string {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatal(err)
	}
	keys := make([]string, 0, len(fields))
	for key := range fields {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// TestMoveUser_Snapshot_OneAccessReadAndEmbeddedCredentials pins the two
// halves of the latency fix for a moderator move: the moved user costs
// exactly one access read (no channel lookup, no separate permission read),
// and the event carries credentials the client can connect with directly —
// the same ones a token request would return.
func TestMoveUser_Snapshot_OneAccessReadAndEmbeddedCredentials(t *testing.T) {
	f := newMoveSnapshotFixture(t)
	f.join(t, "victim", "ch1")

	if err := f.svc.MoveUser(context.Background(), "admin", "victim", "ch2"); err != nil {
		t.Fatalf("MoveUser: %v", err)
	}

	tokens, admissions := f.access.reads()
	if !reflect.DeepEqual(tokens, []string{"victim/ch2"}) || len(admissions) != 0 {
		t.Fatalf("access reads for the move: token=%v admission=%v, want exactly one token read for victim/ch2", tokens, admissions)
	}
	if got := f.resolved(); !reflect.DeepEqual(got, []string{"admin/ch1", "admin/ch2"}) {
		t.Fatalf("resolver reads: %v, want only the mover's source and target channel", got)
	}

	data := f.forceMove(t, "victim")
	if data.ChannelID != "ch2" || data.ServerID != "srv1" {
		t.Fatalf("event routing: channel=%q server=%q", data.ChannelID, data.ServerID)
	}
	if data.Voice == nil {
		t.Fatal("event carries no credentials")
	}
	if data.Voice.ChannelID != "ch2" || data.Voice.URL != "wss://fake.example" {
		t.Fatalf("credentials routing: channel=%q url=%q", data.Voice.ChannelID, data.Voice.URL)
	}
	claims := decodeVoiceClaims(t, data.Voice.Token)
	if claims.Identity != "victim" || claims.Name != "VICTIM" {
		t.Fatalf("token identity=%q name=%q, want the moved user's", claims.Identity, claims.Name)
	}
	if !claims.Video.RoomJoin || claims.Video.Room != "srv1:ch2" {
		t.Fatalf("token room: join=%v room=%q", claims.Video.RoomJoin, claims.Video.Room)
	}

	// A token request for the same room returns the same key material and
	// the same grant — the embedded object is not a second, weaker flavour.
	requested, err := f.svc.GenerateToken(context.Background(), "victim", "victim", "VICTIM", "srv1", "ch2")
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if data.Voice.E2EEPassphrase == "" || data.Voice.E2EEPassphrase != requested.E2EEPassphrase ||
		data.Voice.E2EEKeyIndex != requested.E2EEKeyIndex || data.Voice.E2EEKeyEpoch != requested.E2EEKeyEpoch ||
		data.Voice.E2EEKeyContext == "" || data.Voice.E2EEKeyContext != requested.E2EEKeyContext {
		t.Fatalf("embedded media key differs from a token request: %+v vs %+v", data.Voice, requested)
	}
	if !reflect.DeepEqual(claims.Video, decodeVoiceClaims(t, requested.Token).Video) {
		t.Fatal("embedded grant differs from a token request's grant")
	}

	// Wire contract: d.server_id, and d.voice with exactly the token
	// response's JSON shape.
	if got := jsonKeys(t, data); !reflect.DeepEqual(got, []string{"channel_id", "server_id", "voice"}) {
		t.Fatalf("event fields: %v", got)
	}
	if got, want := jsonKeys(t, data.Voice), jsonKeys(t, requested); !reflect.DeepEqual(got, want) {
		t.Fatalf("voice fields %v, token response fields %v", got, want)
	}

	// The portable target-channel lookup is gone; only the asynchronous
	// source-room eviction may still ask the channel repository (for ch1).
	f.set(func(f *moveSnapshotFixture) {
		if slices.Contains(f.channelLookups, "ch2") {
			t.Errorf("target channel was looked up separately: %v", f.channelLookups)
		}
	})
}

// TestMoveUser_Snapshot_ReadsIssuedTogether pins that the mover's two
// permission reads and the moved user's access read are in flight at the
// same time, not one after another: each blocks until all three started.
func TestMoveUser_Snapshot_ReadsIssuedTogether(t *testing.T) {
	f := newMoveSnapshotFixture(t)
	f.join(t, "victim", "ch1")

	started := make(chan string, 3)
	release := make(chan struct{})
	f.set(func(f *moveSnapshotFixture) {
		f.onResolve = func(userID, channelID string) {
			started <- userID + "/" + channelID
			<-release
		}
	})
	f.access.set(func(a *moveSnapshotAccess) {
		a.onTokenRead = func() {
			started <- "access"
			<-release
		}
	})

	moved := make(chan error, 1)
	go func() { moved <- f.svc.MoveUser(context.Background(), "admin", "victim", "ch2") }()

	var inFlight []string
	for len(inFlight) < 3 {
		select {
		case read := <-started:
			inFlight = append(inFlight, read)
		case <-time.After(2 * time.Second):
			close(release)
			t.Fatalf("only %v in flight together; the reads ran serially", inFlight)
		}
	}
	close(release)
	if err := <-moved; err != nil {
		t.Fatalf("MoveUser: %v", err)
	}
	sort.Strings(inFlight)
	if !reflect.DeepEqual(inFlight, []string{"access", "admin/ch1", "admin/ch2"}) {
		t.Fatalf("reads in flight: %v", inFlight)
	}
}

// TestMoveUser_Snapshot_StaleSourceReadIsNotTrusted pins the authorization
// side of issuing the source-channel read early: it is started for the
// channel the target was in when the move began, but the check must be made
// against the channel the target is in when MoveUser reads the state
// authoritatively. Here the target switches to ch3 while the access read is
// in flight, and the mover has MoveMembers in ch1 but not in ch3.
func TestMoveUser_Snapshot_StaleSourceReadIsNotTrusted(t *testing.T) {
	f := newMoveSnapshotFixture(t)
	f.join(t, "victim", "ch1")
	f.set(func(f *moveSnapshotFixture) {
		f.moverPerms = func(_, channelID string) (models.Permission, error) {
			if channelID == "ch3" {
				return models.PermConnectVoice, nil
			}
			return models.PermMoveMembers | models.PermConnectVoice, nil
		}
	})
	f.access.set(func(a *moveSnapshotAccess) {
		a.onTokenRead = func() {
			a.set(func(a *moveSnapshotAccess) { a.onTokenRead = nil })
			if err := f.svc.JoinChannel("victim", "victim", "VICTIM", "", "ch3", false, false); err != nil {
				t.Errorf("switch during the access read: %v", err)
			}
		}
	})

	err := f.svc.MoveUser(context.Background(), "admin", "victim", "ch2")
	if !errors.Is(err, pkg.ErrForbidden) || !strings.Contains(err.Error(), "source channel") {
		t.Fatalf("expected a source-channel permission rejection, got %v", err)
	}
	if got := f.resolved(); !slices.Contains(got, "admin/ch3") {
		t.Fatalf("mover was never checked against the actual source channel: %v", got)
	}
	if state := f.svc.GetUserVoiceState("victim"); state == nil || state.ChannelID != "ch3" {
		t.Fatalf("rejected move changed the session: %+v", state)
	}
}

// TestMoveUser_Snapshot_PlacementAuthorisesTokenWithoutConsumingGrant: a
// moved user without ConnectVoice in the target still gets credentials (the
// placement authorises them, like the one-time force-move grant), and the
// grant itself is left for a client that asks over HTTP instead — once.
func TestMoveUser_Snapshot_PlacementAuthorisesTokenWithoutConsumingGrant(t *testing.T) {
	f := newMoveSnapshotFixture(t)
	f.access.set(func(a *moveSnapshotAccess) {
		a.perms = func(userID, channelID string) models.Permission {
			if userID == "victim" && channelID == "ch2" {
				return models.PermSpeak // no ConnectVoice in the destination
			}
			return models.PermAll
		}
	})
	f.join(t, "victim", "ch1")

	ctx := context.Background()
	if err := f.svc.MoveUser(ctx, "admin", "victim", "ch2"); err != nil {
		t.Fatalf("MoveUser: %v", err)
	}
	data := f.forceMove(t, "victim")
	if data.Voice == nil {
		t.Fatal("placed user received no credentials")
	}
	claims := decodeVoiceClaims(t, data.Voice.Token)
	if claims.Identity != "victim" || claims.Video.Room != "srv1:ch2" {
		t.Fatalf("token identity=%q room=%q", claims.Identity, claims.Video.Room)
	}

	if !f.svc.hasForceMoveGrant("victim", "ch2") {
		t.Fatal("server-side mint consumed the force-move grant")
	}
	if _, err := f.svc.GenerateToken(ctx, "victim", "victim", "VICTIM", "srv1", "ch2"); err != nil {
		t.Fatalf("fallback token request through the grant: %v", err)
	}
	if _, err := f.svc.GenerateToken(ctx, "victim", "victim", "VICTIM", "srv1", "ch2"); !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("grant was usable twice: %v", err)
	}
}

// TestMoveUser_Snapshot_TimedOutUserGetsNoCredentials: the move itself still
// applies (as before), but a timed-out user is not handed a token — the
// client's own token request then meets GenerateToken's timeout gate.
func TestMoveUser_Snapshot_TimedOutUserGetsNoCredentials(t *testing.T) {
	f := newMoveSnapshotFixture(t)
	f.join(t, "victim", "ch1")
	f.access.set(func(a *moveSnapshotAccess) { a.timedOut = map[string]bool{"victim": true} })

	if err := f.svc.MoveUser(context.Background(), "admin", "victim", "ch2"); err != nil {
		t.Fatalf("MoveUser: %v", err)
	}
	data := f.forceMove(t, "victim")
	if data.Voice != nil {
		t.Fatal("timed-out user received credentials")
	}
	if data.ChannelID != "ch2" || data.ServerID != "srv1" {
		t.Fatalf("event routing: channel=%q server=%q", data.ChannelID, data.ServerID)
	}
	if got := jsonKeys(t, data); !reflect.DeepEqual(got, []string{"channel_id", "server_id"}) {
		t.Fatalf("event fields without credentials: %v", got)
	}
	if _, err := f.svc.GenerateToken(context.Background(), "victim", "victim", "VICTIM", "srv1", "ch2"); !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("token request for a timed-out user: %v", err)
	}
}

// TestMoveUser_Snapshot_ServerMutedTokenCannotPublish: the sanction survives
// the move and is folded into the embedded grant exactly as GenerateToken
// folds it — no publish sources at all, microphone included.
func TestMoveUser_Snapshot_ServerMutedTokenCannotPublish(t *testing.T) {
	f := newMoveSnapshotFixture(t)
	f.join(t, "victim", "ch1")
	f.svc.mu.Lock()
	f.svc.states["victim"].IsServerMuted = true
	f.svc.mu.Unlock()

	if err := f.svc.MoveUser(context.Background(), "admin", "victim", "ch2"); err != nil {
		t.Fatalf("MoveUser: %v", err)
	}
	data := f.forceMove(t, "victim")
	if data.Voice == nil {
		t.Fatal("server-muted user received no credentials")
	}
	grant := decodeVoiceClaims(t, data.Voice.Token).Video
	if grant.CanPublish == nil || *grant.CanPublish {
		t.Fatalf("server-muted embedded token can publish: %v", grant.CanPublish)
	}
	if slices.Contains(grant.GetCanPublishSources(), livekit.TrackSource_MICROPHONE) {
		t.Fatalf("server-muted embedded token lists the microphone: %v", grant.GetCanPublishSources())
	}
	if grant.CanSubscribe == nil || !*grant.CanSubscribe {
		t.Fatal("server mute must not stop the user from listening")
	}

	requested, err := f.svc.GenerateToken(context.Background(), "victim", "victim", "VICTIM", "srv1", "ch2")
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if !reflect.DeepEqual(grant, decodeVoiceClaims(t, requested.Token).Video) {
		t.Fatal("embedded grant differs from a token request's grant for a server-muted user")
	}
}

// TestMoveUser_Snapshot_SelfMoveUsesSnapshotPermissions: a self-move needs
// only ConnectVoice in the target, and that now comes from the access read —
// no resolver call at all.
func TestMoveUser_Snapshot_SelfMoveUsesSnapshotPermissions(t *testing.T) {
	f := newMoveSnapshotFixture(t)
	f.access.set(func(a *moveSnapshotAccess) {
		a.perms = func(_, channelID string) models.Permission {
			if channelID == "locked" {
				return models.PermSpeak
			}
			return models.PermConnectVoice | models.PermSpeak
		}
	})
	f.join(t, "user", "ch1")

	err := f.svc.MoveUser(context.Background(), "user", "user", "locked")
	if !errors.Is(err, pkg.ErrForbidden) || !strings.Contains(err.Error(), "connect voice permission required in target channel") {
		t.Fatalf("self-move without ConnectVoice: %v", err)
	}
	if state := f.svc.GetUserVoiceState("user"); state == nil || state.ChannelID != "ch1" {
		t.Fatalf("rejected self-move changed the session: %+v", state)
	}
	f.access.reads()

	if err := f.svc.MoveUser(context.Background(), "user", "user", "ch2"); err != nil {
		t.Fatalf("self-move: %v", err)
	}
	if tokens, admissions := f.access.reads(); !reflect.DeepEqual(tokens, []string{"user/ch2"}) || len(admissions) != 0 {
		t.Fatalf("access reads for a self-move: token=%v admission=%v", tokens, admissions)
	}
	if got := f.resolved(); len(got) != 0 {
		t.Fatalf("self-move still asked the resolver: %v", got)
	}
	data := f.forceMove(t, "user")
	if data.Voice == nil || decodeVoiceClaims(t, data.Voice.Token).Video.Room != "srv1:ch2" {
		t.Fatalf("self-move credentials: %+v", data.Voice)
	}
	if f.svc.hasForceMoveGrant("user", "ch2") {
		t.Fatal("self-move left a force-move grant")
	}
}

// TestMoveUser_Snapshot_AutoSwitchThresholdLeavesInstanceChoiceToTokenRequest:
// inside the switch threshold GenerateToken may migrate the server to another
// LiveKit instance. The move must neither do that nor hand out a token for
// an instance GenerateToken is about to leave.
func TestMoveUser_Snapshot_AutoSwitchThresholdLeavesInstanceChoiceToTokenRequest(t *testing.T) {
	f := newMoveSnapshotFixture(t)
	instanceSwitching := make(chan string, 4)
	f.svc.livekitGetter = &mockConfigurableLiveKitGetter{
		GetNextAutoSwitchInstanceFn: func(context.Context, string, int, int) (*models.LiveKitInstance, error) {
			instanceSwitching <- "next"
			return nil, nil
		},
		MigrateOneServerFn: func(context.Context, string, string) error {
			instanceSwitching <- "migrate"
			return nil
		},
	}
	f.access.set(func(a *moveSnapshotAccess) {
		a.instance.IsPlatformManaged = true
		a.instance.AutoSwitchEnabled = true
		a.instance.MonthlyQuotaMinutes = 100
		a.instance.SwitchThresholdMinutes = 10
		a.used = 89 * 60 // one minute short of the threshold
	})
	f.join(t, "victim", "ch1")

	if err := f.svc.MoveUser(context.Background(), "admin", "victim", "ch2"); err != nil {
		t.Fatalf("MoveUser: %v", err)
	}
	if data := f.forceMove(t, "victim"); data.Voice == nil {
		t.Fatal("no credentials although the instance is outside its switch threshold")
	}

	f.access.set(func(a *moveSnapshotAccess) { a.used = 90 * 60 })
	if err := f.svc.MoveUser(context.Background(), "admin", "victim", "ch1"); err != nil {
		t.Fatalf("MoveUser: %v", err)
	}
	if data := f.forceMove(t, "victim"); data.Voice != nil {
		t.Fatal("credentials embedded for an instance inside its switch threshold")
	}
	select {
	case call := <-instanceSwitching:
		t.Fatalf("the move touched instance selection (%s)", call)
	default:
	}
}

// TestMoveUser_Snapshot_ErrorMapping pins that the access read's answers map
// onto the errors MoveUser has always returned, and that the two situations
// in which the move applies but no token can be issued still move the user.
func TestMoveUser_Snapshot_ErrorMapping(t *testing.T) {
	ctx := context.Background()

	t.Run("missing channel", func(t *testing.T) {
		f := newMoveSnapshotFixture(t)
		f.join(t, "victim", "ch1")
		f.access.set(func(a *moveSnapshotAccess) { a.missing = map[string]bool{"gone": true} })
		err := f.svc.MoveUser(ctx, "admin", "victim", "gone")
		if !errors.Is(err, pkg.ErrNotFound) || !strings.Contains(err.Error(), "target channel not found") {
			t.Fatalf("got %v", err)
		}
	})

	// A read that FAILED is not a missing channel. Its cause reaches the
	// caller (whose log line is the only place it is ever seen) instead of
	// being reported as a channel that does not exist.
	for _, mover := range []string{"admin", "victim"} {
		t.Run("access read fails, moved by "+mover, func(t *testing.T) {
			f := newMoveSnapshotFixture(t)
			f.join(t, "victim", "ch1")
			access := &failingTokenAccess{moveSnapshotAccess: f.access}
			f.replaceAccess(access)
			unavailable := errors.New("connection reset by peer")
			access.fail(unavailable)

			err := f.svc.MoveUser(ctx, mover, "victim", "ch2")
			if !errors.Is(err, unavailable) || errors.Is(err, pkg.ErrNotFound) || strings.Contains(err.Error(), "target channel not found") {
				t.Fatalf("failed access read reported as %v", err)
			}
			if state := f.svc.GetUserVoiceState("victim"); state == nil || state.ChannelID != "ch1" {
				t.Fatalf("failed move changed the session: %+v", state)
			}
		})
	}

	t.Run("fallback admission read fails", func(t *testing.T) {
		f := newMoveSnapshotFixture(t)
		f.join(t, "victim", "ch1")
		// No LiveKit instance: the token read answers "not found" and the
		// plain admission read decides — and that one fails.
		f.access.set(func(a *moveSnapshotAccess) { a.instance = nil })
		unavailable := errors.New("pool wait timed out")
		f.replaceAccess(&failingAdmissionAccess{moveSnapshotAccess: f.access, err: unavailable})

		err := f.svc.MoveUser(ctx, "admin", "victim", "ch2")
		if !errors.Is(err, unavailable) || errors.Is(err, pkg.ErrNotFound) {
			t.Fatalf("failed admission read reported as %v", err)
		}
		if state := f.svc.GetUserVoiceState("victim"); state == nil || state.ChannelID != "ch1" {
			t.Fatalf("failed move changed the session: %+v", state)
		}
	})

	t.Run("not a voice channel", func(t *testing.T) {
		f := newMoveSnapshotFixture(t)
		f.join(t, "victim", "ch1")
		f.access.set(func(a *moveSnapshotAccess) { a.textChannel = map[string]bool{"text": true} })
		err := f.svc.MoveUser(ctx, "admin", "victim", "text")
		if !errors.Is(err, pkg.ErrBadRequest) || !strings.Contains(err.Error(), "target is not a voice channel") {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("target not in voice", func(t *testing.T) {
		f := newMoveSnapshotFixture(t)
		err := f.svc.MoveUser(ctx, "admin", "victim", "ch2")
		if !errors.Is(err, pkg.ErrBadRequest) || !strings.Contains(err.Error(), "target user is not in a voice channel") {
			t.Fatalf("got %v", err)
		}
		if got := f.resolved(); len(got) != 0 {
			t.Fatalf("permission reads for a user who is not in voice: %v", got)
		}
	})

	t.Run("already in that channel", func(t *testing.T) {
		f := newMoveSnapshotFixture(t)
		f.join(t, "victim", "ch1")
		err := f.svc.MoveUser(ctx, "admin", "victim", "ch1")
		if !errors.Is(err, pkg.ErrBadRequest) || !strings.Contains(err.Error(), "user is already in that channel") {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("cross-server target", func(t *testing.T) {
		f := newMoveSnapshotFixture(t)
		f.join(t, "victim", "ch1")
		f.access.set(func(a *moveSnapshotAccess) { a.servers = map[string]string{"elsewhere": "srv2"} })
		err := f.svc.MoveUser(ctx, "admin", "victim", "elsewhere")
		if !errors.Is(err, pkg.ErrBadRequest) || !strings.Contains(err.Error(), "different server") {
			t.Fatalf("got %v", err)
		}
		if state := f.svc.GetUserVoiceState("victim"); state == nil || state.ChannelID != "ch1" || state.ServerID != "srv1" {
			t.Fatalf("rejected cross-server move changed the session: %+v", state)
		}
	})

	for _, tc := range []struct {
		name, channel, message string
		missing                models.Permission
	}{
		{"mover lacks MoveMembers in source", "ch1", "move members permission required in source channel", models.PermMoveMembers},
		{"mover lacks MoveMembers in target", "ch2", "move members permission required in target channel", models.PermMoveMembers},
		{"mover lacks ConnectVoice in target", "ch2", "connect voice permission required in target channel", models.PermConnectVoice},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newMoveSnapshotFixture(t)
			f.join(t, "victim", "ch1")
			f.set(func(f *moveSnapshotFixture) {
				f.moverPerms = func(_, channelID string) (models.Permission, error) {
					perms := models.PermMoveMembers | models.PermConnectVoice
					if channelID == tc.channel {
						perms &^= tc.missing
					}
					return perms, nil
				}
			})
			err := f.svc.MoveUser(ctx, "admin", "victim", "ch2")
			if !errors.Is(err, pkg.ErrForbidden) || !strings.Contains(err.Error(), tc.message) {
				t.Fatalf("got %v", err)
			}
			if state := f.svc.GetUserVoiceState("victim"); state == nil || state.ChannelID != "ch1" {
				t.Fatalf("rejected move changed the session: %+v", state)
			}
		})
	}

	t.Run("mover permission read fails", func(t *testing.T) {
		f := newMoveSnapshotFixture(t)
		f.join(t, "victim", "ch1")
		unavailable := errors.New("resolver unavailable")
		f.set(func(f *moveSnapshotFixture) {
			f.moverPerms = func(_, channelID string) (models.Permission, error) {
				if channelID == "ch2" {
					return 0, unavailable
				}
				return models.PermAll, nil
			}
		})
		err := f.svc.MoveUser(ctx, "admin", "victim", "ch2")
		if !errors.Is(err, unavailable) || !strings.Contains(err.Error(), "failed to resolve target channel permissions") {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("server without a LiveKit instance still moves", func(t *testing.T) {
		f := newMoveSnapshotFixture(t)
		f.join(t, "victim", "ch1")
		f.access.set(func(a *moveSnapshotAccess) { a.instance = nil })
		if err := f.svc.MoveUser(ctx, "admin", "victim", "ch2"); err != nil {
			t.Fatalf("MoveUser: %v", err)
		}
		if data := f.forceMove(t, "victim"); data.Voice != nil || data.ChannelID != "ch2" || data.ServerID != "srv1" {
			t.Fatalf("event: %+v", data)
		}
		if state := f.svc.GetUserVoiceState("victim"); state == nil || state.ChannelID != "ch2" {
			t.Fatalf("session after the move: %+v", state)
		}
	})

	t.Run("moved user no longer a member", func(t *testing.T) {
		f := newMoveSnapshotFixture(t)
		f.join(t, "victim", "ch1")
		f.access.set(func(a *moveSnapshotAccess) { a.nonMember = map[string]bool{"victim": true} })
		if err := f.svc.MoveUser(ctx, "admin", "victim", "ch2"); err != nil {
			t.Fatalf("MoveUser: %v", err)
		}
		if data := f.forceMove(t, "victim"); data.Voice != nil {
			t.Fatal("non-member received credentials")
		}
		if !f.svc.hasForceMoveGrant("victim", "ch2") {
			t.Fatal("placement grant missing for a user without ConnectVoice")
		}
	})

	t.Run("credentials cannot be signed", func(t *testing.T) {
		f := newMoveSnapshotFixture(t)
		f.join(t, "victim", "ch1")
		f.svc.encryptionKey = []byte("fedcba9876543210fedcba9876543210")
		if err := f.svc.MoveUser(ctx, "admin", "victim", "ch2"); err != nil {
			t.Fatalf("a failed mint failed the move: %v", err)
		}
		if data := f.forceMove(t, "victim"); data.Voice != nil || data.ServerID != "srv1" {
			t.Fatalf("event: %+v", data)
		}
		if state := f.svc.GetUserVoiceState("victim"); state == nil || state.ChannelID != "ch2" {
			t.Fatalf("session after the move: %+v", state)
		}
	})
}

// failingAdmissionAccess makes the plain admission read fail with a
// (transient) error; the token read is the embedded fake's.
type failingAdmissionAccess struct {
	*moveSnapshotAccess
	err error
}

func (a *failingAdmissionAccess) VoiceAdmission(context.Context, string, string) (*models.VoiceAdmission, error) {
	return nil, a.err
}

// TestMoveUser_Snapshot_SourceRekeyGoesOutBeforeTheCredentialMint: the source
// room's key is rotated under the lock, but its remaining members keep
// encrypting with the key the moved user holds until they are told. That
// broadcast must not sit behind the credential mint, which takes s.mu again
// (three times) and can wait there behind another holder — nor, when the
// mover's permission cache was cold, behind the database round trip that
// repeats the access read. The moved user is not among its recipients, so the
// order is invisible to every client.
func TestMoveUser_Snapshot_SourceRekeyGoesOutBeforeTheCredentialMint(t *testing.T) {
	for _, tc := range []struct {
		name string
		cold bool // the access snapshot has aged: the mint starts with a re-read
	}{
		{"credentials from the move's own snapshot", false},
		{"credentials from a repeated access read", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newMoveSnapshotFixture(t)

			type sent struct {
				op         string
				recipients []string
				// Whether the target room's key existed when the event went
				// out. It is created by the credential mint (nobody has asked
				// for ch2's key before), so false means the mint had not run
				// yet.
				targetKeyMinted bool
			}
			var mu sync.Mutex
			var order []sent
			record := func(event ws.Event, recipients ...string) {
				if event.Op != ws.OpVoicePassphraseRotated && event.Op != ws.OpVoiceForceMove {
					return
				}
				f.svc.mu.RLock()
				_, minted := f.svc.roomPassphrases["srv1:ch2"]
				f.svc.mu.RUnlock()
				mu.Lock()
				defer mu.Unlock()
				order = append(order, sent{event.Op, recipients, minted})
			}
			// Set before anything has run on the fixture.
			hub := f.svc.hub.(*voiceTestBroadcaster).MockBroadcaster
			hub.BroadcastToUsersFn = func(userIDs []string, event ws.Event) { record(event, userIDs...) }
			hub.BroadcastToUserFn = func(userID string, event ws.Event) {
				record(event, userID)
				f.events <- moveSnapshotUserEvent{userID, event}
			}

			f.join(t, "victim", "ch1")
			f.join(t, "other", "ch1")
			// The source room has a key in use, so the move rotates it.
			if _, err := f.svc.GenerateToken(context.Background(), "other", "other", "OTHER", "srv1", "ch1"); err != nil {
				t.Fatalf("GenerateToken: %v", err)
			}

			// What had been sent when the repeated access read was issued.
			var sentBeforeReread []string
			reread := false
			if tc.cold {
				f.coldMoverCache()
				f.onAccessRead(func(read int) {
					if read != 2 {
						return
					}
					mu.Lock()
					defer mu.Unlock()
					reread = true
					for _, event := range order {
						sentBeforeReread = append(sentBeforeReread, event.op)
					}
					freshAgain()
				})
			}

			if err := f.svc.MoveUser(context.Background(), "admin", "victim", "ch2"); err != nil {
				t.Fatalf("MoveUser: %v", err)
			}
			if data := f.forceMove(t, "victim"); data.Voice == nil {
				t.Fatal("event carries no credentials; the mint this test orders against did not run")
			}

			mu.Lock()
			defer mu.Unlock()
			if len(order) != 2 || order[0].op != ws.OpVoicePassphraseRotated || order[1].op != ws.OpVoiceForceMove {
				t.Fatalf("events after the move: %+v, want the source re-key first, then voice_force_move", order)
			}
			if !reflect.DeepEqual(order[0].recipients, []string{"other"}) {
				t.Fatalf("re-key recipients: %v, want only the member who stayed", order[0].recipients)
			}
			if order[0].targetKeyMinted {
				t.Fatal("source re-key was broadcast after the credential mint")
			}
			if !order[1].targetKeyMinted {
				t.Fatal("voice_force_move went out before the mint; this test no longer orders against it")
			}
			if reread != tc.cold {
				t.Fatalf("access read repeated: %v, want %v", reread, tc.cold)
			}
			if tc.cold && !reflect.DeepEqual(sentBeforeReread, []string{ws.OpVoicePassphraseRotated}) {
				t.Fatalf("sent before the access read was repeated: %v, want the source re-key already out", sentBeforeReread)
			}
		})
	}
}

// TestMoveCredentials_RequireTheLivePlacement pins the last gate of the
// embedded mint: the token is issued on the strength of the placement this
// move made, so a session that was ended or moved again in the meantime
// yields no credentials — and ConnectVoice is never waived without it.
func TestMoveCredentials_RequireTheLivePlacement(t *testing.T) {
	f := newMoveSnapshotFixture(t)
	f.join(t, "victim", "ch2")
	admission, instance, used, err := f.access.VoiceTokenAccess(context.Background(), "victim", "ch2", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	reads := moveReadsAt(admission, instance, used, time.Now())
	f.svc.mu.RLock()
	state := f.svc.states["victim"]
	placement := voiceMovePlacement{state: state, generation: state.ChannelGeneration, username: "victim"}
	f.svc.mu.RUnlock()

	if voice, _ := f.mint(t, reads, placement); voice == nil {
		t.Fatal("live placement with ConnectVoice yielded no credentials")
	}
	if voice, _ := f.mint(t, nil, placement); voice != nil {
		t.Fatal("credentials without an access snapshot")
	}

	denied := *admission
	denied.Permissions = models.PermSpeak
	withoutConnect := moveReadsAt(&denied, instance, used, time.Now())
	if voice, _ := f.mint(t, withoutConnect, placement); voice != nil {
		t.Fatal("ConnectVoice waived without a placement grant")
	}
	granted := placement
	granted.granted = true
	if voice, _ := f.mint(t, withoutConnect, granted); voice == nil {
		t.Fatal("placement grant did not authorise the token")
	}

	superseded := placement
	superseded.generation++
	if voice, _ := f.mint(t, reads, superseded); voice != nil {
		t.Fatal("credentials for a placement that is no longer current")
	}
	if err := f.svc.LeaveChannel("victim"); err != nil {
		t.Fatal(err)
	}
	if voice, _ := f.mint(t, reads, placement); voice != nil {
		t.Fatal("credentials for a session that has ended")
	}
}

// moveContextKey marks the context a test hands to MoveUser.
type moveContextKey struct{}

// inFlightAccess records the mark of the context each token read was issued
// with, and lets a read fail in flight: an error set while the fake answers
// (from the read's own hook, see onAccessRead), or the end of the read's
// context by then, replaces the answer — a statement that lost its connection
// or was cancelled after it had been sent. Unlike failingTokenAccess, which
// decides before the fake runs, the failing read still runs its hook.
type inFlightAccess struct {
	*moveSnapshotAccess
	flightMu sync.Mutex
	err      error
	marks    []any
}

func (a *inFlightAccess) fail(err error) {
	a.flightMu.Lock()
	defer a.flightMu.Unlock()
	a.err = err
}

func (a *inFlightAccess) VoiceTokenAccess(ctx context.Context, userID, channelID string, now time.Time) (*models.VoiceAdmission, *models.LiveKitInstance, int64, error) {
	admission, instance, used, err := a.moveSnapshotAccess.VoiceTokenAccess(ctx, userID, channelID, now)
	a.flightMu.Lock()
	a.marks = append(a.marks, ctx.Value(moveContextKey{}))
	failed := a.err
	a.flightMu.Unlock()
	if failed == nil {
		failed = ctx.Err()
	}
	if failed != nil {
		return nil, nil, 0, failed
	}
	return admission, instance, used, err
}

func (a *inFlightAccess) recorded() []any {
	a.flightMu.Lock()
	defer a.flightMu.Unlock()
	return slices.Clone(a.marks)
}

// TestMoveUser_Snapshot_ColdPermissionCacheRepeatsTheAccessRead: the access
// read is the first thing a move issues, and a moderator whose permission
// cache has expired keeps the move waiting on several round trips after it
// answered. That is the common move, and it must not lose its embedded
// credentials to the snapshot's age: the access read is repeated — once,
// after the move has been applied and the lock released, with MoveUser's own
// context — and the credentials are minted from that second answer.
func TestMoveUser_Snapshot_ColdPermissionCacheRepeatsTheAccessRead(t *testing.T) {
	t.Run("moderator move", func(t *testing.T) {
		f := newMoveSnapshotFixture(t)
		f.join(t, "victim", "ch1")
		access := &inFlightAccess{moveSnapshotAccess: f.access}
		f.replaceAccess(access)

		f.coldMoverCache()
		channelAtReread := "(lock held)"
		f.onAccessRead(func(read int) {
			if read != 2 {
				return
			}
			// The repeat is a database round trip: s.mu must be free while it
			// is in flight, and the move already applied.
			unlocked := make(chan string, 1)
			go func() {
				f.svc.mu.Lock()
				defer f.svc.mu.Unlock()
				channel := "(no session)"
				if state := f.svc.states["victim"]; state != nil {
					channel = state.ChannelID
				}
				unlocked <- channel
			}()
			select {
			case channelAtReread = <-unlocked:
			case <-time.After(2 * time.Second):
			}
			// The second answer differs from the first in ways the
			// credentials show: another instance URL, and no PermStream.
			f.access.set(func(a *moveSnapshotAccess) {
				a.instance.URL = "wss://second.example"
				a.perms = func(string, string) models.Permission { return models.PermConnectVoice | models.PermSpeak }
			})
			freshAgain()
		})

		ctx := context.WithValue(context.Background(), moveContextKey{}, "move")
		if err := f.svc.MoveUser(ctx, "admin", "victim", "ch2"); err != nil {
			t.Fatalf("MoveUser: %v", err)
		}

		tokens, admissions := f.access.reads()
		if !reflect.DeepEqual(tokens, []string{"victim/ch2", "victim/ch2"}) || len(admissions) != 0 {
			t.Fatalf("access reads for the move: token=%v admission=%v, want the move's read and exactly one repeat of it", tokens, admissions)
		}
		if marks := access.recorded(); !reflect.DeepEqual(marks, []any{"move", "move"}) {
			t.Fatalf("contexts of the access reads: %v, want MoveUser's for both", marks)
		}
		if got := f.resolved(); !reflect.DeepEqual(got, []string{"admin/ch1", "admin/ch2"}) {
			t.Fatalf("resolver reads: %v, want only the mover's source and target channel", got)
		}
		if channelAtReread != "ch2" {
			t.Fatalf("victim's channel with s.mu taken during the repeated read: %q, want the move applied and the lock free", channelAtReread)
		}

		data := f.forceMove(t, "victim")
		if data.ChannelID != "ch2" || data.ServerID != "srv1" {
			t.Fatalf("event routing: channel=%q server=%q", data.ChannelID, data.ServerID)
		}
		if data.Voice == nil {
			t.Fatal("cold-cache move carries no credentials")
		}
		if data.Voice.ChannelID != "ch2" || data.Voice.URL != "wss://second.example" {
			t.Fatalf("credentials routing: channel=%q url=%q, want the repeated read's instance", data.Voice.ChannelID, data.Voice.URL)
		}
		claims := decodeVoiceClaims(t, data.Voice.Token)
		if claims.Identity != "victim" || !claims.Video.RoomJoin || claims.Video.Room != "srv1:ch2" {
			t.Fatalf("token identity=%q join=%v room=%q", claims.Identity, claims.Video.RoomJoin, claims.Video.Room)
		}
		sources := claims.Video.GetCanPublishSources()
		if !slices.Contains(sources, livekit.TrackSource_MICROPHONE) || slices.Contains(sources, livekit.TrackSource_SCREEN_SHARE) {
			t.Fatalf("publish sources %v, want the repeated read's permissions (speak, no stream)", sources)
		}

		// Still the same object a token request returns.
		requested, err := f.svc.GenerateToken(ctx, "victim", "victim", "VICTIM", "srv1", "ch2")
		if err != nil {
			t.Fatalf("GenerateToken: %v", err)
		}
		if data.Voice.E2EEPassphrase == "" || data.Voice.E2EEPassphrase != requested.E2EEPassphrase ||
			data.Voice.E2EEKeyEpoch != requested.E2EEKeyEpoch || data.Voice.E2EEKeyContext != requested.E2EEKeyContext {
			t.Fatalf("embedded media key differs from a token request: %+v vs %+v", data.Voice, requested)
		}
		if !reflect.DeepEqual(claims.Video, decodeVoiceClaims(t, requested.Token).Video) {
			t.Fatal("embedded grant differs from a token request's grant")
		}
	})

	// The placement still authorises a user without ConnectVoice, and the
	// one-time grant is still left for a client that asks over HTTP.
	t.Run("moved user placed without ConnectVoice", func(t *testing.T) {
		f := newMoveSnapshotFixture(t)
		f.access.set(func(a *moveSnapshotAccess) {
			a.perms = func(userID, channelID string) models.Permission {
				if userID == "victim" && channelID == "ch2" {
					return models.PermSpeak
				}
				return models.PermAll
			}
		})
		f.join(t, "victim", "ch1")
		f.coldMoverCache()
		f.onAccessRead(func(read int) {
			if read == 2 {
				freshAgain()
			}
		})

		if err := f.svc.MoveUser(context.Background(), "admin", "victim", "ch2"); err != nil {
			t.Fatalf("MoveUser: %v", err)
		}
		if tokens, _ := f.access.reads(); len(tokens) != 2 {
			t.Fatalf("access reads: %v, want the move's read and one repeat", tokens)
		}
		if data := f.forceMove(t, "victim"); data.Voice == nil {
			t.Fatal("placed user received no credentials")
		}
		if !f.svc.hasForceMoveGrant("victim", "ch2") {
			t.Fatal("the repeated read's mint took the force-move grant")
		}
	})

	// A self-move issues no permission reads; its snapshot can only age
	// behind the lock. It is read again all the same.
	t.Run("self-move", func(t *testing.T) {
		f := newMoveSnapshotFixture(t)
		f.join(t, "user", "ch1")
		voiceMoveCredentialsMaxSnapshotAge = -1 // the fixture restores it
		f.onAccessRead(func(read int) {
			if read == 2 {
				freshAgain()
			}
		})

		if err := f.svc.MoveUser(context.Background(), "user", "user", "ch2"); err != nil {
			t.Fatalf("self-move: %v", err)
		}
		if tokens, admissions := f.access.reads(); !reflect.DeepEqual(tokens, []string{"user/ch2", "user/ch2"}) || len(admissions) != 0 {
			t.Fatalf("access reads for a self-move: token=%v admission=%v", tokens, admissions)
		}
		if got := f.resolved(); len(got) != 0 {
			t.Fatalf("self-move asked the resolver: %v", got)
		}
		data := f.forceMove(t, "user")
		if data.Voice == nil || decodeVoiceClaims(t, data.Voice.Token).Video.Room != "srv1:ch2" {
			t.Fatalf("self-move credentials: %+v", data.Voice)
		}
	})
}

// TestMoveUser_Snapshot_SanctionDuringTheMoveGetsNoCredentials: a sanction
// committed while the move waits on the mover's permission reads is one the
// client's own token request (issued after the move) would have met. The
// snapshot read before it has aged past the bound by then and is not minted
// from; the read that replaces it sees the sanction, so the event goes out
// without credentials and the client asks GenerateToken as it did before.
// The rules are GenerateToken's, applied to the repeated answer: timeout,
// membership, ConnectVoice (this move placed the user WITH it, so there is
// no grant to fall back on) and the instance's auto-switch threshold.
func TestMoveUser_Snapshot_SanctionDuringTheMoveGetsNoCredentials(t *testing.T) {
	cases := []struct {
		name     string
		sanction func(*moveSnapshotAccess)
		// Whether the token request the client falls back to is refused too.
		// Inside the switch threshold it is not: GenerateToken picks the
		// instance there.
		tokenRefused bool
	}{
		{"timed out during the move", func(a *moveSnapshotAccess) { a.timedOut = map[string]bool{"victim": true} }, true},
		{"removed from the server during the move", func(a *moveSnapshotAccess) { a.nonMember = map[string]bool{"victim": true} }, true},
		{"ConnectVoice revoked during the move", func(a *moveSnapshotAccess) {
			a.perms = func(string, string) models.Permission { return models.PermSpeak }
		}, true},
		{"instance reached its switch threshold during the move", func(a *moveSnapshotAccess) {
			a.instance.IsPlatformManaged = true
			a.instance.AutoSwitchEnabled = true
			a.instance.MonthlyQuotaMinutes = 100
			a.instance.SwitchThresholdMinutes = 10
			a.used = 90 * 60
		}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newMoveSnapshotFixture(t)
			f.join(t, "victim", "ch1")

			// The move's own access read answers first (not timed out, a
			// member, ConnectVoice, an instance with room to spare). The
			// mover's permission reads miss the cache and outlast the bound,
			// and the sanction is committed before the access read is
			// repeated — without its DisconnectUser having reached the voice
			// service. The repeated snapshot is as fresh as one can be, so
			// what keeps the credentials out is what it says, not its age.
			f.coldMoverCache()
			f.onAccessRead(func(read int) {
				if read == 2 {
					f.access.set(tc.sanction)
					freshAgain()
				}
			})

			ctx := context.Background()
			if err := f.svc.MoveUser(ctx, "admin", "victim", "ch2"); err != nil {
				t.Fatalf("MoveUser: %v", err)
			}
			if state := f.svc.GetUserVoiceState("victim"); state == nil || state.ChannelID != "ch2" {
				t.Fatalf("session after the move: %+v", state)
			}
			if tokens, admissions := f.access.reads(); !reflect.DeepEqual(tokens, []string{"victim/ch2", "victim/ch2"}) || len(admissions) != 0 {
				t.Fatalf("access reads for the move: token=%v admission=%v, want the move's read and one repeat", tokens, admissions)
			}
			data := f.forceMove(t, "victim")
			if data.Voice != nil {
				t.Fatal("credentials minted from a snapshot older than the sanction")
			}
			if data.ChannelID != "ch2" || data.ServerID != "srv1" {
				t.Fatalf("event routing: channel=%q server=%q", data.ChannelID, data.ServerID)
			}
			if !tc.tokenRefused {
				return
			}
			// The token request the client falls back to is refused.
			if _, err := f.svc.GenerateToken(ctx, "victim", "victim", "VICTIM", "srv1", "ch2"); !errors.Is(err, pkg.ErrForbidden) {
				t.Fatalf("token request after the sanction: %v", err)
			}
		})
	}
}

// TestMoveUser_Snapshot_FailedAccessRereadLeavesCredentialsOut: the repeated
// access read is an optimisation of a move that has already been applied.
// Whatever it answers instead of a snapshot — a transport error, the
// context's end, or "not found" (the LiveKit instance was unlinked, the
// channel deleted) — the move stands, MoveUser reports success, and the
// event goes out without credentials. Unlike the move's own access read it
// has no fallback read: nothing else is asked of the database.
func TestMoveUser_Snapshot_FailedAccessRereadLeavesCredentialsOut(t *testing.T) {
	unavailable := errors.New("connection reset by peer")
	cases := []struct {
		name string
		// fail makes the token read it is called from — the repeated one —
		// fail. cancel ends the move's context.
		fail func(access *inFlightAccess, cancel context.CancelFunc)
		// A failed read is worth a line; a missing row is an ordinary answer.
		warned bool
	}{
		{"read fails", func(access *inFlightAccess, _ context.CancelFunc) { access.fail(unavailable) }, true},
		{"context ended", func(_ *inFlightAccess, cancel context.CancelFunc) { cancel() }, true},
		{"LiveKit instance unlinked", func(access *inFlightAccess, _ context.CancelFunc) {
			access.set(func(a *moveSnapshotAccess) { a.instance = nil })
		}, false},
		{"channel deleted", func(access *inFlightAccess, _ context.CancelFunc) {
			access.set(func(a *moveSnapshotAccess) { a.missing = map[string]bool{"ch2": true} })
		}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newMoveSnapshotFixture(t)
			f.join(t, "victim", "ch1")
			access := &inFlightAccess{moveSnapshotAccess: f.access}
			f.replaceAccess(access)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()

			// The move's own access read answers; the mover's permission
			// reads outlast the bound; the repeated read fails. The bound is
			// back out of reach by then, so a snapshot of any age would be
			// minted from — what keeps the credentials out is the failure.
			f.coldMoverCache()
			f.onAccessRead(func(read int) {
				if read == 2 {
					tc.fail(access, cancel)
					freshAgain()
				}
			})
			capture := captureVoiceLogs(t)

			if err := f.svc.MoveUser(ctx, "admin", "victim", "ch2"); err != nil {
				t.Fatalf("a failed re-read failed the move: %v", err)
			}
			if state := f.svc.GetUserVoiceState("victim"); state == nil || state.ChannelID != "ch2" {
				t.Fatalf("session after the move: %+v", state)
			}
			if tokens, admissions := f.access.reads(); !reflect.DeepEqual(tokens, []string{"victim/ch2", "victim/ch2"}) || len(admissions) != 0 {
				t.Fatalf("access reads for the move: token=%v admission=%v, want the move's read, one repeat and no fallback read", tokens, admissions)
			}
			data := f.forceMove(t, "victim")
			if data.Voice != nil {
				t.Fatal("credentials embedded although the access read could not be repeated")
			}
			if data.ChannelID != "ch2" || data.ServerID != "srv1" {
				t.Fatalf("event routing: channel=%q server=%q", data.ChannelID, data.ServerID)
			}
			if got := jsonKeys(t, data); !reflect.DeepEqual(got, []string{"channel_id", "server_id"}) {
				t.Fatalf("event fields without credentials: %v", got)
			}

			warnings := capture.take("voice move credentials not embedded")
			if !tc.warned {
				if len(warnings) != 0 {
					t.Fatalf("a missing row was logged as a failure: %v", warnings)
				}
				return
			}
			if len(warnings) != 1 {
				t.Fatalf("failed re-read logged %d times", len(warnings))
			}
			warning := warnings[0]
			if warning["level"].String() != slog.LevelWarn.String() || warning["channel_id"].String() != "ch2" || warning["err"].String() == "" {
				t.Fatalf("failed re-read line: %v", warning)
			}
			if len(warning) != 3 {
				t.Fatalf("failed re-read line carries more than level, channel and cause: %v", warning)
			}
		})
	}
}

// stalledRefreshAccess answers the move's own access read and stalls the one
// moveCredentials repeats until that read's context ends, the way a
// statement sent to a database that has stopped answering does. guard only
// keeps a regression from holding the test for the whole move budget.
type stalledRefreshAccess struct {
	*moveSnapshotAccess
	guard time.Duration

	stallMu   sync.Mutex
	read      int
	budgets   []time.Duration // time each read's context had left; -1 without a deadline
	stalled   time.Duration   // how long the repeated read was held
	stalledBy error           // what ended it
}

func (a *stalledRefreshAccess) VoiceTokenAccess(ctx context.Context, userID, channelID string, now time.Time) (*models.VoiceAdmission, *models.LiveKitInstance, int64, error) {
	budget := time.Duration(-1)
	if deadline, ok := ctx.Deadline(); ok {
		budget = time.Until(deadline)
	}
	a.stallMu.Lock()
	a.read++
	read := a.read
	a.budgets = append(a.budgets, budget)
	a.stallMu.Unlock()
	if read != 2 {
		return a.moveSnapshotAccess.VoiceTokenAccess(ctx, userID, channelID, now)
	}
	// Recorded like any other read, answered only by the end of its context.
	a.set(func(inner *moveSnapshotAccess) {
		inner.tokenReads = append(inner.tokenReads, userID+"/"+channelID)
	})
	start := time.Now()
	err := errors.New("the repeated read was left without a deadline of its own")
	select {
	case <-ctx.Done():
		err = ctx.Err()
	case <-time.After(a.guard):
	}
	a.stallMu.Lock()
	a.stalled, a.stalledBy = time.Since(start), err
	a.stallMu.Unlock()
	return nil, nil, 0, err
}

// TestMoveUser_Snapshot_StalledRereadIsCutOffByItsOwnDeadline: when the
// access read is repeated the move is already applied and broadcast, and
// voice_force_move waits for that read alone. A database that has stopped
// answering must not hold the event for the rest of the move's budget: the
// read gets voiceMoveRefreshTimeout, and running out of it is one more way
// to send the event without credentials.
func TestMoveUser_Snapshot_StalledRereadIsCutOffByItsOwnDeadline(t *testing.T) {
	// The move's budget stands in for the 5 s a WebSocket callback gets; the
	// guard is where a re-read bound only by that budget is given up on.
	const moveBudget, guard = time.Minute, 5 * time.Second
	if voiceMoveRefreshTimeout != 750*time.Millisecond {
		t.Fatalf("refresh timeout is %v; it is sized against the client's own token request (about 0.7 s)", voiceMoveRefreshTimeout)
	}
	f := newMoveSnapshotFixture(t)
	voiceMoveRefreshTimeout = 50 * time.Millisecond // the fixture restores it
	f.join(t, "victim", "ch1")
	access := &stalledRefreshAccess{moveSnapshotAccess: f.access, guard: guard}
	f.replaceAccess(access)
	ctx, cancel := context.WithTimeout(context.Background(), moveBudget)
	defer cancel()

	// Cold permission cache: the snapshot is past its bound once the mover's
	// permission reads are back, so the access read is repeated — and stalls.
	f.coldMoverCache()
	capture := captureVoiceLogs(t)

	start := time.Now()
	err := f.svc.MoveUser(ctx, "admin", "victim", "ch2")
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("a stalled re-read failed the move: %v", err)
	}
	if ctx.Err() != nil {
		t.Fatalf("the move's own context ended: %v", ctx.Err())
	}
	if state := f.svc.GetUserVoiceState("victim"); state == nil || state.ChannelID != "ch2" {
		t.Fatalf("session after the move: %+v", state)
	}
	if tokens, admissions := f.access.reads(); !reflect.DeepEqual(tokens, []string{"victim/ch2", "victim/ch2"}) || len(admissions) != 0 {
		t.Fatalf("access reads for the move: token=%v admission=%v, want the move's read, one repeat and no fallback read", tokens, admissions)
	}

	access.stallMu.Lock()
	budgets, stalled, stalledBy := slices.Clone(access.budgets), access.stalled, access.stalledBy
	access.stallMu.Unlock()
	if !errors.Is(stalledBy, context.DeadlineExceeded) {
		t.Fatalf("the repeated read ended with %v after %v, want its own deadline", stalledBy, stalled)
	}
	if len(budgets) != 2 {
		t.Fatalf("%d access reads, want 2", len(budgets))
	}
	// The move's own read keeps the move's budget; only the repeat is cut.
	if budgets[0] < moveBudget/2 {
		t.Fatalf("the move's own access read was given %v of a %v budget", budgets[0], moveBudget)
	}
	if budgets[1] < 0 || budgets[1] > voiceMoveRefreshTimeout {
		t.Fatalf("the repeated read was given %v, want at most %v", budgets[1], voiceMoveRefreshTimeout)
	}
	// Bounded by the refresh timeout, not by the move's budget. No tighter
	// wall-clock claim than "well under the budget" is made.
	if stalled >= guard || elapsed >= guard {
		t.Fatalf("move took %v with the re-read held for %v; budget %v", elapsed, stalled, moveBudget)
	}

	data := f.forceMove(t, "victim")
	if data.Voice != nil {
		t.Fatal("credentials embedded although the repeated read never answered")
	}
	if data.ChannelID != "ch2" || data.ServerID != "srv1" {
		t.Fatalf("event routing: channel=%q server=%q", data.ChannelID, data.ServerID)
	}
	if got := jsonKeys(t, data); !reflect.DeepEqual(got, []string{"channel_id", "server_id"}) {
		t.Fatalf("event fields without credentials: %v", got)
	}
	if extra := f.forceMoves(t); len(extra) != 0 {
		t.Fatalf("more than one voice_force_move: %v", extra)
	}

	warnings := capture.take("voice move credentials not embedded")
	if len(warnings) != 1 || warnings[0]["level"].String() != slog.LevelWarn.String() || warnings[0]["channel_id"].String() != "ch2" {
		t.Fatalf("stalled re-read warnings: %v", warnings)
	}
	lines := capture.take("voice move credentials")
	if len(lines) != 1 || lines[0]["credentials"].String() != voiceMoveCredentialsNone {
		t.Fatalf("credentials outcome line: %v", lines)
	}
}

// TestMoveUser_Snapshot_RepeatedSnapshotIsNotRepeatedAgain: the bound holds
// for the repeated read too. If that snapshot has itself aged past it by the
// time the credentials would leave, there is no third read — the event goes
// out without credentials and the client's own token request decides.
func TestMoveUser_Snapshot_RepeatedSnapshotIsNotRepeatedAgain(t *testing.T) {
	f := newMoveSnapshotFixture(t)
	f.join(t, "victim", "ch1")
	// The bound stays run out: the repeated snapshot is past it as well.
	f.coldMoverCache()

	ctx := context.Background()
	if err := f.svc.MoveUser(ctx, "admin", "victim", "ch2"); err != nil {
		t.Fatalf("MoveUser: %v", err)
	}
	if state := f.svc.GetUserVoiceState("victim"); state == nil || state.ChannelID != "ch2" {
		t.Fatalf("session after the move: %+v", state)
	}
	if tokens, admissions := f.access.reads(); !reflect.DeepEqual(tokens, []string{"victim/ch2", "victim/ch2"}) || len(admissions) != 0 {
		t.Fatalf("access reads for the move: token=%v admission=%v, want the move's read and exactly one repeat", tokens, admissions)
	}
	if data := f.forceMove(t, "victim"); data.Voice != nil {
		t.Fatal("credentials minted from a repeated snapshot that had aged past the bound")
	}
	// The target room's key is created by the mint (nobody asked for it
	// before): the credentials were made and then held back by the last
	// check, not refused on the way in.
	f.svc.mu.RLock()
	_, minted := f.svc.roomPassphrases["srv1:ch2"]
	f.svc.mu.RUnlock()
	if !minted {
		t.Fatal("the repeated snapshot was never minted from; this test no longer reaches the final age check")
	}
	if _, err := f.svc.GenerateToken(ctx, "victim", "victim", "VICTIM", "srv1", "ch2"); err != nil {
		t.Fatalf("token request after the move: %v", err)
	}
}

// TestMoveUser_Snapshot_OvertakenMoveSendsNoInstruction: the repeated access
// read is a database round trip between the unlock and voice_force_move, with
// s.mu free. A second moderator whose permissions are cached can move the
// same user again inside it and send its own voice_force_move first. The
// client follows whichever instruction arrives last, so the first move's —
// for a channel the user is no longer placed in — would drag the session back
// there, undoing the later move (or, without ConnectVoice there, dropping the
// user from voice: the later move already replaced the force-move grant).
// The overtaken move therefore sends nothing; the later move's instruction is
// the only one.
func TestMoveUser_Snapshot_OvertakenMoveSendsNoInstruction(t *testing.T) {
	cases := []struct {
		name string
		// reread shapes what the first move's repeated access read answers,
		// once the second move has overtaken it.
		reread func(f *moveSnapshotFixture)
	}{
		{"repeated read answers", func(*moveSnapshotFixture) {}},
		// moveCredentials gives up here before it ever looks at the placement:
		// the decision is MoveUser's own, not a by-product of the mint.
		{"repeated read finds no channel", func(f *moveSnapshotFixture) {
			f.access.set(func(a *moveSnapshotAccess) { a.missing = map[string]bool{"ch2": true} })
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newMoveSnapshotFixture(t)
			f.join(t, "victim", "ch1")
			ctx := context.Background()

			// admin1's permission reads miss the cache, so its access read is
			// repeated after the unlock. While that is in flight admin2 —
			// cached permissions, fresh snapshot — moves the user on to ch3
			// and returns.
			f.coldMoverCache()
			overtaken := false
			var second error
			f.onAccessRead(func(read int) {
				if read != 2 {
					return
				}
				freshAgain()
				overtaken = true
				second = f.svc.MoveUser(ctx, "admin2", "victim", "ch3")
				tc.reread(f)
			})
			if err := f.svc.MoveUser(ctx, "admin1", "victim", "ch2"); err != nil {
				t.Fatalf("first move: %v", err)
			}
			if !overtaken || second != nil {
				t.Fatalf("second move during the repeated read: ran=%v err=%v", overtaken, second)
			}
			if state := f.svc.GetUserVoiceState("victim"); state == nil || state.ChannelID != "ch3" {
				t.Fatalf("session after both moves: %+v, want ch3", state)
			}

			moves := f.forceMoves(t)
			if len(moves) != 1 {
				t.Fatalf("voice_force_move events: %+v, want only the later move's", moves)
			}
			if moves[0].ChannelID != "ch3" || moves[0].Voice == nil || moves[0].Voice.ChannelID != "ch3" {
				t.Fatalf("the one instruction sent: %+v, want ch3 with its credentials", moves[0])
			}
		})
	}
}

// TestMoveUser_Snapshot_OwnJoinDuringTheRereadKeepsTheInstruction is the
// other side of that rule: only a later MOVE stands in for this one's
// instruction. The moved user's own voice_join arriving during the repeated
// read (a late join for the channel they were just moved out of) replaces the
// session as well, but it tells the client nothing. If the move kept quiet
// then, a single moderator's move would be lost without a trace; its
// instruction still goes out — without credentials, the placement they would
// be minted for is gone — and the client follows it as it always has.
func TestMoveUser_Snapshot_OwnJoinDuringTheRereadKeepsTheInstruction(t *testing.T) {
	f := newMoveSnapshotFixture(t)
	f.join(t, "victim", "ch2")
	f.coldMoverCache()
	rejoined := false
	var joinErr error
	f.onAccessRead(func(read int) {
		if read != 2 {
			return
		}
		freshAgain()
		rejoined = true
		joinErr = f.svc.JoinChannel("victim", "victim", "VICTIM", "", "ch2", false, false)
	})

	if err := f.svc.MoveUser(context.Background(), "admin", "victim", "ch3"); err != nil {
		t.Fatalf("MoveUser: %v", err)
	}
	if !rejoined || joinErr != nil {
		t.Fatalf("own join during the repeated read: ran=%v err=%v", rejoined, joinErr)
	}
	if state := f.svc.GetUserVoiceState("victim"); state == nil || state.ChannelID != "ch2" {
		t.Fatalf("session after the own join: %+v, want ch2", state)
	}

	moves := f.forceMoves(t)
	if len(moves) != 1 || moves[0].ChannelID != "ch3" {
		t.Fatalf("voice_force_move events: %+v, want the move's own instruction for ch3", moves)
	}
	if moves[0].Voice != nil {
		t.Fatal("credentials sent for a placement the session has already left")
	}
}

// TestMoveCredentials_AgedOrUndatedSnapshotIsReadAgainOnce pins the age gate
// against real ages instead of a moved bound: a snapshot inside the bound is
// minted from as it is, with no statement; one past it — or with no read
// time at all, which is as old as a snapshot can be — is never minted from,
// and is replaced by exactly one repeated read whose own (new) age is what
// the final check judges.
func TestMoveCredentials_AgedOrUndatedSnapshotIsReadAgainOnce(t *testing.T) {
	f := newMoveSnapshotFixture(t)
	f.join(t, "victim", "ch2")
	admission, instance, used, err := f.access.VoiceTokenAccess(context.Background(), "victim", "ch2", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	f.access.reads()
	f.svc.mu.RLock()
	state := f.svc.states["victim"]
	placement := voiceMovePlacement{state: state, generation: state.ChannelGeneration, username: "victim"}
	f.svc.mu.RUnlock()

	// What the move read carries a mark the reader's answer does not, so the
	// credentials show which of the two they were minted from.
	const firstURL, rereadURL = "wss://first.example", "wss://fake.example"
	first := *instance
	first.URL = firstURL
	voiceMoveCredentialsMaxSnapshotAge = time.Minute // the fixture restores it
	aged := func() time.Time { return time.Now().Add(-2 * time.Minute) }
	rereads := func() int {
		tokens, admissions := f.access.reads()
		if len(admissions) != 0 {
			t.Fatalf("fallback admission reads: %v", admissions)
		}
		return len(tokens)
	}

	voice, source := f.mint(t, moveReadsAt(admission, &first, used, time.Now()), placement)
	if source != voiceMoveCredentialsSnapshot || voice.URL != firstURL {
		t.Fatalf("fresh snapshot: source=%q voice=%+v", source, voice)
	}
	if n := rereads(); n != 0 {
		t.Fatalf("fresh snapshot was read again %d times", n)
	}

	for _, tc := range []struct {
		name   string
		readAt time.Time
	}{
		{"aged", aged()},
		{"undated", time.Time{}},
	} {
		voice, source := f.mint(t, moveReadsAt(admission, &first, used, tc.readAt), placement)
		if source != voiceMoveCredentialsRefreshed || voice.URL != rereadURL {
			t.Fatalf("%s snapshot: source=%q voice=%+v, want credentials from a repeated read", tc.name, source, voice)
		}
		if n := rereads(); n != 1 {
			t.Fatalf("%s snapshot was read again %d times, want once", tc.name, n)
		}
	}

	// The move found no LiveKit instance: there is nothing to mint for, and
	// no reason to ask again.
	if voice, _ := f.mint(t, moveReadsAt(admission, nil, 0, aged()), placement); voice != nil || rereads() != 0 {
		t.Fatal("a snapshot without a LiveKit instance was read again or minted from")
	}

	// The repeated answer is held to the same rules as the first...
	f.access.set(func(a *moveSnapshotAccess) { a.timedOut = map[string]bool{"victim": true} })
	if voice, _ := f.mint(t, moveReadsAt(admission, &first, used, aged()), placement); voice != nil || rereads() != 1 {
		t.Fatal("credentials for a user the repeated read reports as timed out")
	}
	// ...and must be for the channel and server the move was decided on.
	f.access.set(func(a *moveSnapshotAccess) {
		a.timedOut = nil
		a.servers = map[string]string{"ch2": "srv2"}
	})
	if voice, _ := f.mint(t, moveReadsAt(admission, &first, used, aged()), placement); voice != nil || rereads() != 1 {
		t.Fatal("credentials from a repeated read that answered for another server")
	}
	f.access.set(func(a *moveSnapshotAccess) { a.servers = nil })

	// Without a reader there is nothing to repeat the read with.
	f.replaceAccess(nil)
	if voice, _ := f.mint(t, moveReadsAt(admission, &first, used, aged()), placement); voice != nil || rereads() != 0 {
		t.Fatal("credentials from an aged snapshot without a reader")
	}
}

// TestMoveUser_LogsHowCredentialsWereObtained: one debug line per move says
// where the embedded credentials came from and what minting them cost — the
// repeated access read included — and nothing that identifies anyone.
func TestMoveUser_LogsHowCredentialsWereObtained(t *testing.T) {
	f := newMoveSnapshotFixture(t)
	f.join(t, "victim", "ch1")
	capture := captureVoiceLogs(t)

	move := func(channel, want string, embedded bool) {
		t.Helper()
		if err := f.svc.MoveUser(context.Background(), "admin", "victim", channel); err != nil {
			t.Fatalf("MoveUser: %v", err)
		}
		if data := f.forceMove(t, "victim"); (data.Voice != nil) != embedded {
			t.Fatalf("move to %s: credentials embedded = %v, want %v", channel, data.Voice != nil, embedded)
		}
		lines := capture.take("voice move credentials")
		if len(lines) != 1 {
			t.Fatalf("move to %s: %d credentials lines", channel, len(lines))
		}
		line := lines[0]
		if line["level"].String() != slog.LevelDebug.String() {
			t.Fatalf("credentials line logged at %s", line["level"])
		}
		if got := line["credentials"]; got.Kind() != slog.KindString || got.String() != want {
			t.Fatalf("move to %s: credentials=%v, want %q", channel, got, want)
		}
		if mint := line["credentials_mint"]; mint.Kind() != slog.KindDuration || mint.Duration() < 0 {
			t.Fatalf("credentials_mint: %v", mint)
		}
		if len(line) != 3 {
			t.Fatalf("credentials line carries more than level, source and mint time: %v", line)
		}
	}

	move("ch2", voiceMoveCredentialsSnapshot, true)

	// Cold permission cache: the mint includes the repeated read, which here
	// takes a measurable while.
	const rereadTime = 30 * time.Millisecond
	f.coldMoverCache()
	f.onAccessRead(func(read int) {
		if read == 2 {
			time.Sleep(rereadTime)
			freshAgain()
		}
	})
	if err := f.svc.MoveUser(context.Background(), "admin", "victim", "ch1"); err != nil {
		t.Fatalf("MoveUser: %v", err)
	}
	if data := f.forceMove(t, "victim"); data.Voice == nil {
		t.Fatal("cold-cache move carries no credentials")
	}
	lines := capture.take("voice move credentials")
	if len(lines) != 1 || lines[0]["credentials"].String() != voiceMoveCredentialsRefreshed {
		t.Fatalf("cold-cache move: %v", lines)
	}
	if mint := lines[0]["credentials_mint"]; mint.Kind() != slog.KindDuration || mint.Duration() < rereadTime {
		t.Fatalf("credentials_mint %v does not cover the repeated read (%v)", mint, rereadTime)
	}

	f.set(func(f *moveSnapshotFixture) { f.onResolve = nil })
	f.access.set(func(a *moveSnapshotAccess) {
		a.onTokenRead = nil
		a.timedOut = map[string]bool{"victim": true}
	})
	move("ch2", voiceMoveCredentialsNone, false)
}

// TestMoveUser_Portable_EventCarriesServerIDOnly: without a snapshot reader
// nothing about the lookups changes and no credentials are minted, but the
// event still names the server.
func TestMoveUser_Portable_EventCarriesServerIDOnly(t *testing.T) {
	svc, hub := newTestVoiceService()
	hub.BroadcastToServerFn = func(string, ws.Event) {}
	events := make(chan ws.Event, 4)
	hub.BroadcastToUserFn = func(_ string, event ws.Event) { events <- event }

	if err := svc.JoinChannel("victim", "victim", "Victim", "", "ch1", false, false); err != nil {
		t.Fatal(err)
	}
	if err := svc.MoveUser(context.Background(), "admin", "victim", "ch2"); err != nil {
		t.Fatalf("MoveUser: %v", err)
	}
	event := awaitVoiceTestEvent(t, events, func(event ws.Event) bool { return event.Op == ws.OpVoiceForceMove })
	data, ok := event.Data.(ws.VoiceForceMoveData)
	if !ok || data.ChannelID != "ch2" || data.ServerID != "srv1" || data.Voice != nil {
		t.Fatalf("event: %+v", event.Data)
	}
	if got := jsonKeys(t, data); !reflect.DeepEqual(got, []string{"channel_id", "server_id"}) {
		t.Fatalf("event fields: %v", got)
	}
}

// moveLogCapture collects records by message. slog.SetDefault is atomic and
// the component loggers resolve the default at emission time, so swapping it
// for one test does not race goroutines left over from earlier ones.
type moveLogCapture struct {
	mu      sync.Mutex
	records map[string][]map[string]slog.Value
}

func (c *moveLogCapture) Enabled(context.Context, slog.Level) bool { return true }
func (c *moveLogCapture) WithAttrs([]slog.Attr) slog.Handler       { return c }
func (c *moveLogCapture) WithGroup(string) slog.Handler            { return c }
func (c *moveLogCapture) Handle(_ context.Context, record slog.Record) error {
	attrs := map[string]slog.Value{"level": slog.StringValue(record.Level.String())}
	record.Attrs(func(attr slog.Attr) bool {
		attrs[attr.Key] = attr.Value
		return true
	})
	c.mu.Lock()
	defer c.mu.Unlock()
	c.records[record.Message] = append(c.records[record.Message], attrs)
	return nil
}
func (c *moveLogCapture) take(message string) []map[string]slog.Value {
	c.mu.Lock()
	defer c.mu.Unlock()
	records := c.records[message]
	delete(c.records, message)
	return records
}

// TestMoveUser_LogsDatabasePhase: the debug timing line gains the pre-lock
// database time, and a slow phase is reported once at Info with only the
// duration, whether credentials were embedded, how they were obtained and
// what minting them took.
func TestMoveUser_LogsDatabasePhase(t *testing.T) {
	f := newMoveSnapshotFixture(t)
	f.join(t, "victim", "ch1")

	capture := &moveLogCapture{records: make(map[string][]map[string]slog.Value)}
	// SetDefault also points the standard logger at the handler and does not
	// undo that when the original default is put back.
	previous, stdOutput, stdFlags := slog.Default(), log.Writer(), log.Flags()
	slog.SetDefault(slog.New(capture))
	t.Cleanup(func() {
		slog.SetDefault(previous)
		log.SetOutput(stdOutput)
		log.SetFlags(stdFlags)
	})

	// The un-delayed move is measured in wall-clock time, so a stalled test
	// run could push it over the real threshold. It runs with the threshold
	// out of reach — a move under it is never reported — and the delayed
	// move below runs with the real one.
	slowPhase := voiceMoveSlowDBPhase
	t.Cleanup(func() { voiceMoveSlowDBPhase = slowPhase })
	voiceMoveSlowDBPhase = time.Hour
	if err := f.svc.MoveUser(context.Background(), "admin", "victim", "ch2"); err != nil {
		t.Fatalf("MoveUser: %v", err)
	}
	timing := capture.take("voice move lock timing")
	if len(timing) != 1 || timing[0]["db_phase"].Kind() != slog.KindDuration {
		t.Fatalf("debug timing line: %v", timing)
	}
	if slow := capture.take("voice move database phase slow"); len(slow) != 0 {
		t.Fatalf("fast move reported as slow: %v", slow)
	}
	voiceMoveSlowDBPhase = slowPhase

	f.access.set(func(a *moveSnapshotAccess) { a.delay = voiceMoveSlowDBPhase + 50*time.Millisecond })
	if err := f.svc.MoveUser(context.Background(), "admin", "victim", "ch1"); err != nil {
		t.Fatalf("MoveUser: %v", err)
	}
	slow := capture.take("voice move database phase slow")
	if len(slow) != 1 {
		t.Fatalf("slow database phase reported %d times", len(slow))
	}
	record := slow[0]
	if record["level"].String() != slog.LevelInfo.String() {
		t.Fatalf("slow phase logged at %s", record["level"])
	}
	if phase := record["db_phase"]; phase.Kind() != slog.KindDuration || phase.Duration() <= voiceMoveSlowDBPhase {
		t.Fatalf("db_phase: %v", phase)
	}
	if embedded := record["credentials_embedded"]; embedded.Kind() != slog.KindBool || !embedded.Bool() {
		t.Fatalf("credentials_embedded: %v", embedded)
	}
	if source := record["credentials"]; source.Kind() != slog.KindString || source.String() != voiceMoveCredentialsSnapshot {
		t.Fatalf("credentials: %v", source)
	}
	if mint := record["credentials_mint"]; mint.Kind() != slog.KindDuration || mint.Duration() < 0 {
		t.Fatalf("credentials_mint: %v", mint)
	}
	if len(record) != 5 {
		t.Fatalf("slow phase line carries more than level, duration, embedded flag, credentials source and mint time: %v", record)
	}
}
