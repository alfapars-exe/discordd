package services

import (
	"context"
	"errors"
	"io"
	"log"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/crypto"
	"github.com/argeinfina/hichat/testutil"

	livekit "github.com/livekit/protocol/livekit"
	"google.golang.org/protobuf/proto"
)

// ─── JoinChannel on the snapshot path (voiceAccess != nil) ───
//
// Production (PostgreSQL) wires a repository.VoiceAccessReader. JoinChannel
// then reads the channel, the admission facts and the server's LiveKit
// instance in ONE statement — the token read — instead of an admission read
// followed by a separate instance lookup. Every other JoinChannel test in
// this package runs without a reader and so pins the portable path.

// joinCountingLiveKit records every LiveKitInstanceGetter call JoinChannel
// could make. It errors like mockLiveKitGetter, so an instance the voice
// state ends up with can only have come from the access snapshot.
type joinCountingLiveKit struct {
	mockLiveKitGetter
	mu    sync.Mutex
	calls []string
}

func (g *joinCountingLiveKit) record(call string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.calls = append(g.calls, call)
}

func (g *joinCountingLiveKit) recorded() []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([]string(nil), g.calls...)
}

func (g *joinCountingLiveKit) GetByServerID(ctx context.Context, serverID string) (*models.LiveKitInstance, error) {
	g.record("GetByServerID")
	return g.mockLiveKitGetter.GetByServerID(ctx, serverID)
}

func (g *joinCountingLiveKit) GetMonthlyUsage(ctx context.Context, instanceID string, year, month int) (int64, error) {
	g.record("GetMonthlyUsage")
	return g.mockLiveKitGetter.GetMonthlyUsage(ctx, instanceID, year, month)
}

func (g *joinCountingLiveKit) GetNextAutoSwitchInstance(ctx context.Context, instanceID string, year, month int) (*models.LiveKitInstance, error) {
	g.record("GetNextAutoSwitchInstance")
	return g.mockLiveKitGetter.GetNextAutoSwitchInstance(ctx, instanceID, year, month)
}

func (g *joinCountingLiveKit) MigrateOneServer(ctx context.Context, serverID, instanceID string) error {
	g.record("MigrateOneServer")
	return g.mockLiveKitGetter.MigrateOneServer(ctx, serverID, instanceID)
}

// newJoinSnapshotFixture is the MoveUser snapshot fixture with the LiveKit
// getter swapped for a recording one, before anything has run on it.
func newJoinSnapshotFixture(t *testing.T) (*moveSnapshotFixture, *joinCountingLiveKit) {
	t.Helper()
	f := newMoveSnapshotFixture(t)
	lookups := &joinCountingLiveKit{}
	f.svc.livekitGetter = lookups
	return f, lookups
}

// TestJoinChannel_Snapshot_OneAccessReadFillsQuotaFields: one token read, no
// admission read, no instance lookup — and the quota-attribution fields are
// still filled. The instance is deliberately inside its auto-switch
// threshold: a join only reports the instance, it never migrates the server
// (that decision stays with GenerateToken).
func TestJoinChannel_Snapshot_OneAccessReadFillsQuotaFields(t *testing.T) {
	f, lookups := newJoinSnapshotFixture(t)
	f.access.set(func(a *moveSnapshotAccess) {
		a.instance.IsPlatformManaged = true
		a.instance.AutoSwitchEnabled = true
		a.instance.MonthlyQuotaMinutes = 100
		a.instance.SwitchThresholdMinutes = 10
		a.used = 100 * 60
	})

	if err := f.svc.JoinChannel("u1", "u1", "U1", "", "ch1", true, false); err != nil {
		t.Fatalf("JoinChannel: %v", err)
	}
	tokens, admissions := f.access.reads()
	if !reflect.DeepEqual(tokens, []string{"u1/ch1"}) || len(admissions) != 0 {
		t.Fatalf("access reads: token=%v admission=%v, want one token read only", tokens, admissions)
	}
	if calls := lookups.recorded(); len(calls) != 0 {
		t.Fatalf("join made LiveKit repository calls: %v", calls)
	}
	state := f.svc.GetUserVoiceState("u1")
	if state == nil {
		t.Fatal("no voice state after join")
	}
	if state.ChannelID != "ch1" || state.ServerID != "srv1" || !state.IsMuted || state.IsDeafened {
		t.Fatalf("state: %+v", state)
	}
	if state.LiveKitInstanceID != "lk1" || !state.LiveKitIsCloud {
		t.Fatalf("quota fields: instance=%q cloud=%v, want lk1/true", state.LiveKitInstanceID, state.LiveKitIsCloud)
	}

	// A self-hosted instance is attributed too, just not as cloud.
	f.access.set(func(a *moveSnapshotAccess) { a.instance.IsPlatformManaged = false })
	if err := f.svc.JoinChannel("u2", "u2", "U2", "", "ch1", false, false); err != nil {
		t.Fatalf("JoinChannel u2: %v", err)
	}
	if state := f.svc.GetUserVoiceState("u2"); state == nil || state.LiveKitInstanceID != "lk1" || state.LiveKitIsCloud {
		t.Fatalf("self-hosted quota fields: %+v", state)
	}

	// The same-channel re-confirmation a WS reconnect sends is one read too.
	f.access.reads()
	if err := f.svc.JoinChannel("u1", "u1", "U1", "", "ch1", true, false); err != nil {
		t.Fatalf("same-channel rejoin: %v", err)
	}
	tokens, admissions = f.access.reads()
	if !reflect.DeepEqual(tokens, []string{"u1/ch1"}) || len(admissions) != 0 {
		t.Fatalf("rejoin reads: token=%v admission=%v", tokens, admissions)
	}
	if calls := lookups.recorded(); len(calls) != 0 {
		t.Fatalf("LiveKit repository calls: %v", calls)
	}
}

// TestJoinChannel_Snapshot_NoLiveKitInstanceStillJoins: the token read joins
// the server's LiveKit instance, so a server without one answers "not found"
// there. A join never required an instance — the session just goes
// unattributed — so it repeats the plain admission read; only that read
// decides that the channel is gone.
func TestJoinChannel_Snapshot_NoLiveKitInstanceStillJoins(t *testing.T) {
	f, lookups := newJoinSnapshotFixture(t)
	f.access.set(func(a *moveSnapshotAccess) {
		a.instance = nil
		a.missing = map[string]bool{"gone": true}
	})

	if err := f.svc.JoinChannel("u1", "u1", "U1", "", "ch1", false, false); err != nil {
		t.Fatalf("JoinChannel without a LiveKit instance: %v", err)
	}
	tokens, admissions := f.access.reads()
	if !reflect.DeepEqual(tokens, []string{"u1/ch1"}) || !reflect.DeepEqual(admissions, []string{"u1/ch1"}) {
		t.Fatalf("access reads: token=%v admission=%v", tokens, admissions)
	}
	state := f.svc.GetUserVoiceState("u1")
	if state == nil || state.ChannelID != "ch1" || state.LiveKitInstanceID != "" || state.LiveKitIsCloud {
		t.Fatalf("state: %+v", state)
	}

	err := f.svc.JoinChannel("u2", "u2", "U2", "", "gone", false, false)
	if !errors.Is(err, pkg.ErrNotFound) || !strings.Contains(err.Error(), "channel not found") {
		t.Fatalf("missing channel: %v", err)
	}
	if state := f.svc.GetUserVoiceState("u2"); state != nil {
		t.Fatalf("state written for a missing channel: %+v", state)
	}
	if calls := lookups.recorded(); len(calls) != 0 {
		t.Fatalf("LiveKit repository calls: %v", calls)
	}
}

// TestJoinChannel_Snapshot_KeepsAdmissionChecks: the token read carries the
// same admission facts as the admission read it replaces, and every
// rejection — including the stale-session cleanup an authoritative one
// triggers — is unchanged.
func TestJoinChannel_Snapshot_KeepsAdmissionChecks(t *testing.T) {
	cases := []struct {
		name   string
		deny   func(*moveSnapshotAccess)
		target string
		want   error
		text   string
	}{
		{"timed out", func(a *moveSnapshotAccess) { a.timedOut = map[string]bool{"u1": true} }, "ch2", pkg.ErrForbidden, "timed out"},
		{"not a member", func(a *moveSnapshotAccess) { a.nonMember = map[string]bool{"u1": true} }, "ch2", pkg.ErrForbidden, "not a member"},
		{"missing connect", func(a *moveSnapshotAccess) {
			a.perms = func(_, channelID string) models.Permission {
				if channelID == "ch2" {
					return models.PermViewChannel
				}
				return models.PermAll
			}
		}, "ch2", pkg.ErrForbidden, "missing voice connect permission"},
		{"text channel", func(a *moveSnapshotAccess) { a.textChannel = map[string]bool{"ch2": true} }, "ch2", pkg.ErrBadRequest, "not a voice channel"},
		// The re-confirmation of the user's own channel is rejected as well.
		{"timed out in own channel", func(a *moveSnapshotAccess) { a.timedOut = map[string]bool{"u1": true} }, "ch1", pkg.ErrForbidden, "timed out"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f, lookups := newJoinSnapshotFixture(t)
			f.join(t, "u1", "ch1")
			f.access.set(tc.deny)

			err := f.svc.JoinChannel("u1", "u1", "U1", "", tc.target, false, false)
			if !errors.Is(err, tc.want) || !strings.Contains(err.Error(), tc.text) {
				t.Fatalf("JoinChannel: %v, want %v (%q)", err, tc.want, tc.text)
			}
			if state := f.svc.GetUserVoiceState("u1"); state != nil {
				t.Fatalf("stale session survived the rejection: %+v", state)
			}
			tokens, admissions := f.access.reads()
			if !reflect.DeepEqual(tokens, []string{"u1/" + tc.target}) || len(admissions) != 0 {
				t.Fatalf("access reads: token=%v admission=%v", tokens, admissions)
			}
			// The rejected join looked nothing up itself; the unguarded
			// eviction of the stale session is the only instance lookup.
			f.svc.ShutdownUsageProducers()
			for _, call := range lookups.recorded() {
				if call != "GetByServerID" {
					t.Fatalf("LiveKit repository call %q", call)
				}
			}
		})
	}
}

// failingTokenAccess makes the token read fail with a plain (transient)
// error while set.
type failingTokenAccess struct {
	*moveSnapshotAccess
	failMu sync.Mutex
	err    error
}

func (a *failingTokenAccess) fail(err error) {
	a.failMu.Lock()
	defer a.failMu.Unlock()
	a.err = err
}

func (a *failingTokenAccess) VoiceTokenAccess(ctx context.Context, userID, channelID string, now time.Time) (*models.VoiceAdmission, *models.LiveKitInstance, int64, error) {
	a.failMu.Lock()
	err := a.err
	a.failMu.Unlock()
	if err != nil {
		a.set(func(m *moveSnapshotAccess) { m.tokenReads = append(m.tokenReads, userID+"/"+channelID) })
		return nil, nil, 0, err
	}
	return a.moveSnapshotAccess.VoiceTokenAccess(ctx, userID, channelID, now)
}

// TestJoinChannel_Snapshot_TransientReadErrorNeverFallsBack: only "not
// found" repeats the read. Any other failure is the join's lookup failure,
// with today's handling: the same-channel re-confirmation keeps the live
// session, and nothing else is read.
func TestJoinChannel_Snapshot_TransientReadErrorNeverFallsBack(t *testing.T) {
	f, lookups := newJoinSnapshotFixture(t)
	access := &failingTokenAccess{moveSnapshotAccess: f.access}
	f.svc.voiceAccess = access
	f.join(t, "u1", "ch1")

	access.fail(errors.New("snapshot unavailable"))
	err := f.svc.JoinChannel("u1", "u1", "U1", "", "ch1", false, false)
	if !errors.Is(err, pkg.ErrNotFound) || !strings.Contains(err.Error(), "channel not found") {
		t.Fatalf("JoinChannel: %v", err)
	}
	tokens, admissions := f.access.reads()
	if !reflect.DeepEqual(tokens, []string{"u1/ch1"}) || len(admissions) != 0 {
		t.Fatalf("access reads: token=%v admission=%v, want no fallback read", tokens, admissions)
	}
	if state := f.svc.GetUserVoiceState("u1"); state == nil || state.ChannelID != "ch1" {
		t.Fatalf("live session lost to a transient read error: %+v", state)
	}
	if calls := lookups.recorded(); len(calls) != 0 {
		t.Fatalf("LiveKit repository calls: %v", calls)
	}
}

// captureVoiceLogs swaps the default slog handler for the test (see
// moveLogCapture, voice_move_snapshot_test.go).
func captureVoiceLogs(t *testing.T) *moveLogCapture {
	t.Helper()
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
	return capture
}

// TestJoinChannel_LogsDatabasePhase: the debug timing line carries the
// pre-lock database time, and a slow phase is reported once at Info with
// only the duration.
func TestJoinChannel_LogsDatabasePhase(t *testing.T) {
	f, _ := newJoinSnapshotFixture(t)
	capture := captureVoiceLogs(t)

	// The un-delayed join is measured in wall-clock time, so a stalled test
	// run could push it over the real threshold. It runs with the threshold
	// out of reach — a join under it is never reported — and the delayed
	// join below runs with the real one.
	slowPhase := voiceJoinSlowDBPhase
	t.Cleanup(func() { voiceJoinSlowDBPhase = slowPhase })
	voiceJoinSlowDBPhase = time.Hour
	if err := f.svc.JoinChannel("u1", "u1", "U1", "", "ch1", false, false); err != nil {
		t.Fatalf("JoinChannel: %v", err)
	}
	timing := capture.take("voice join lock timing")
	if len(timing) != 1 || timing[0]["db_phase"].Kind() != slog.KindDuration ||
		timing[0]["lock_wait"].Kind() != slog.KindDuration || timing[0]["lock_held"].Kind() != slog.KindDuration {
		t.Fatalf("debug timing line: %v", timing)
	}
	if timing[0]["level"].String() != slog.LevelDebug.String() {
		t.Fatalf("timing line logged at %s", timing[0]["level"])
	}
	if slow := capture.take("voice join database phase slow"); len(slow) != 0 {
		t.Fatalf("fast join reported as slow: %v", slow)
	}
	voiceJoinSlowDBPhase = slowPhase

	f.access.set(func(a *moveSnapshotAccess) { a.delay = voiceJoinSlowDBPhase + 50*time.Millisecond })
	if err := f.svc.JoinChannel("u1", "u1", "U1", "", "ch2", false, false); err != nil {
		t.Fatalf("JoinChannel: %v", err)
	}
	slow := capture.take("voice join database phase slow")
	if len(slow) != 1 {
		t.Fatalf("slow database phase reported %d times", len(slow))
	}
	record := slow[0]
	if record["level"].String() != slog.LevelInfo.String() {
		t.Fatalf("slow phase logged at %s", record["level"])
	}
	if phase := record["db_phase"]; phase.Kind() != slog.KindDuration || phase.Duration() <= voiceJoinSlowDBPhase {
		t.Fatalf("db_phase: %v", phase)
	}
	if len(record) != 2 {
		t.Fatalf("slow phase line carries more than level and duration: %v", record)
	}
}

// ─── Guarded departure evictions ───
//
// After a leave, a channel switch, a move or the orphan sweep, the old
// room's LiveKit participant is removed asynchronously. These tests run that
// removal against a fake LiveKit RoomService and hold it at its database
// lookup, so the user can come back to the same channel while the eviction
// is still in flight — the case the guard exists for.

type departureFixture struct {
	svc *voiceService

	mu       sync.Mutex
	gate     chan struct{} // non-nil: evictions wait here, inside their LiveKit instance lookup
	removed  []string      // "room identity" per RemoveParticipant request, in arrival order
	other    []string      // any other request the fake LiveKit received
	timedOut map[string]bool
	// admitted, when set, runs once inside the next join's timeout read,
	// after it has taken its answer (see parkNextJoin).
	admitted func()

	reached chan string // one send per eviction that got to its instance lookup
}

func newDepartureFixture(t *testing.T) *departureFixture {
	t.Helper()
	f := &departureFixture{timedOut: make(map[string]bool), reached: make(chan string, 32)}

	livekitServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var request livekit.RoomParticipantIdentity
		if r.URL.Path != "/twirp/livekit.RoomService/RemoveParticipant" || proto.Unmarshal(body, &request) != nil {
			f.mu.Lock()
			f.other = append(f.other, r.URL.Path)
			f.mu.Unlock()
			http.Error(w, "unexpected request", http.StatusBadRequest)
			return
		}
		f.mu.Lock()
		f.removed = append(f.removed, request.Room+" "+request.Identity)
		f.mu.Unlock()
		// An empty protobuf body is a valid RemoveParticipantResponse.
		w.Header().Set("Content-Type", "application/protobuf")
	}))
	t.Cleanup(livekitServer.Close)

	encrypt := func(value string) string {
		encrypted, err := crypto.Encrypt(value, tokenTestEncryptionKey)
		if err != nil {
			t.Fatalf("setup: encrypt: %v", err)
		}
		return encrypted
	}
	instance := models.LiveKitInstance{ID: "lk1", URL: livekitServer.URL, APIKey: encrypt(tokenTestAPIKey), APISecret: encrypt(tokenTestAPISecret)}

	hub := &testutil.MockBroadcaster{}
	f.svc = NewVoiceService(
		&testutil.MockChannelRepo{
			GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
				// Every channel is srv1's, except the ones named for srv2.
				serverID := "srv1"
				if strings.HasPrefix(id, "srv2-") {
					serverID = "srv2"
				}
				return &models.Channel{ID: id, ServerID: serverID, Type: models.ChannelTypeVoice}, nil
			},
		},
		&mockConfigurableLiveKitGetter{
			GetByServerIDFn: func(ctx context.Context, _ string) (*models.LiveKitInstance, error) {
				// Evictions look the instance up on their own 10-second
				// context; JoinChannel's attribution lookup has no deadline.
				if deadline, ok := ctx.Deadline(); ok && time.Until(deadline) > 8*time.Second {
					f.mu.Lock()
					gate := f.gate
					f.mu.Unlock()
					f.reached <- "eviction"
					if gate != nil {
						<-gate
					}
				}
				found := instance
				return &found, nil
			},
		},
		&testutil.MockChannelPermResolver{
			ResolveChannelPermissionsFn: func(context.Context, string, string) (models.Permission, error) {
				return models.PermAll, nil
			},
		},
		&voiceTestBroadcaster{hub},
		&testutil.MockBroadcastAndOnline{}, // nobody online: the orphan sweep may run
		&testutil.MockServerRepo{
			IsMemberFn: func(context.Context, string, string) (bool, error) { return true, nil },
		},
		tokenTestEncryptionKey,
		&testutil.MockMemberTimeoutRepo{
			IsActiveFn: func(_ context.Context, _, userID string) (bool, error) {
				f.mu.Lock()
				timedOut, admitted := f.timedOut[userID], f.admitted
				f.admitted = nil
				f.mu.Unlock()
				if admitted != nil {
					admitted()
				}
				return timedOut, nil
			},
		},
		nil, // banChecker
		nil, // auditLogger
		VoiceRuntimeDependencies{Fanout: voiceFixtureFanout(hub)},
	).(*voiceService)
	t.Cleanup(f.svc.ShutdownVoiceStateFanout)
	return f
}

func (f *departureFixture) join(t *testing.T, userID, channelID string) {
	t.Helper()
	if err := f.svc.JoinChannel(userID, userID, strings.ToUpper(userID), "", channelID, false, false); err != nil {
		t.Fatalf("join %s into %s: %v", userID, channelID, err)
	}
}

// hold makes every eviction started from now on wait inside its LiveKit
// instance lookup — the last step before the guard — until release.
func (f *departureFixture) hold() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.gate = make(chan struct{})
}

func (f *departureFixture) release() {
	f.mu.Lock()
	defer f.mu.Unlock()
	close(f.gate)
	f.gate = nil
}

// awaitHeld waits until an eviction is in flight (at its instance lookup).
func (f *departureFixture) awaitHeld(t *testing.T) {
	t.Helper()
	select {
	case <-f.reached:
	case <-time.After(2 * time.Second):
		t.Fatal("no eviction was dispatched")
	}
}

func (f *departureFixture) setTimedOut(userID string, timedOut bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.timedOut[userID] = timedOut
}

// parkNextJoin makes the next JoinChannel stop between its admission read
// and the write lock: the timeout read has taken its answer (as the store
// stood at that moment) but not yet returned it. parked is closed when the
// join is there; closing resume lets it continue.
func (f *departureFixture) parkNextJoin() (parked <-chan struct{}, resume chan<- struct{}) {
	reached, release := make(chan struct{}), make(chan struct{})
	f.mu.Lock()
	defer f.mu.Unlock()
	f.admitted = func() {
		close(reached)
		<-release
	}
	return reached, release
}

// evictions waits for every dispatched eviction to finish and returns the
// RemoveParticipant requests LiveKit received, sorted.
func (f *departureFixture) evictions(t *testing.T) []string {
	t.Helper()
	f.svc.ShutdownUsageProducers()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.other) != 0 {
		t.Fatalf("unexpected LiveKit requests: %v", f.other)
	}
	removed := append([]string{}, f.removed...)
	sort.Strings(removed)
	return removed
}

// expireOrphan marks userID as offline for longer than the grace period.
func (f *departureFixture) expireOrphan(userID string) {
	f.svc.mu.Lock()
	defer f.svc.mu.Unlock()
	f.svc.offlineSince[userID] = time.Now().Add(-orphanGracePeriod - time.Second)
}

// TestDepartureEviction_SkipsUserWhoCameBack: for each departure path, the
// eviction from ch1 still removes both identities when the user stays away,
// and leaves the main identity alone when the user is back in ch1 before the
// LiveKit call. The "_ss" identity is evicted either way: a stream never
// survives a departure, so one still in the room is the old session's.
func TestDepartureEviction_SkipsUserWhoCameBack(t *testing.T) {
	const (
		oldMain   = "srv1:ch1 u1"
		oldScreen = "srv1:ch1 u1_ss"
		newMain   = "srv1:ch2 u1"
		newScreen = "srv1:ch2 u1_ss"
	)
	departures := []struct {
		name string
		// depart ends u1's presence in ch1. It reports whether u1 is now in
		// ch2, in which case coming back to ch1 is itself a departure (from
		// ch2) with evictions of its own.
		depart func(t *testing.T, f *departureFixture) (movedToCh2 bool)
	}{
		{"leave", func(t *testing.T, f *departureFixture) bool {
			if err := f.svc.LeaveChannel("u1"); err != nil {
				t.Fatalf("LeaveChannel: %v", err)
			}
			return false
		}},
		{"channel switch", func(t *testing.T, f *departureFixture) bool {
			f.join(t, "u1", "ch2")
			return true
		}},
		{"move", func(t *testing.T, f *departureFixture) bool {
			if err := f.svc.MoveUser(context.Background(), "admin", "u1", "ch2"); err != nil {
				t.Fatalf("MoveUser: %v", err)
			}
			return true
		}},
	}
	for _, departure := range departures {
		t.Run(departure.name+"/stays away", func(t *testing.T) {
			f := newDepartureFixture(t)
			f.join(t, "u1", "ch1")
			departure.depart(t, f)
			if got, want := f.evictions(t), []string{oldMain, oldScreen}; !reflect.DeepEqual(got, want) {
				t.Fatalf("evictions: %v, want %v", got, want)
			}
		})
		t.Run(departure.name+"/comes back", func(t *testing.T) {
			f := newDepartureFixture(t)
			f.join(t, "u1", "ch1")
			f.hold()
			movedToCh2 := departure.depart(t, f)
			f.awaitHeld(t)
			f.join(t, "u1", "ch1")
			f.release()

			want := []string{oldScreen}
			if movedToCh2 {
				want = []string{oldScreen, newMain, newScreen}
			}
			if got := f.evictions(t); !reflect.DeepEqual(got, want) {
				t.Fatalf("evictions: %v, want %v", got, want)
			}
			if state := f.svc.GetUserVoiceState("u1"); state == nil || state.ChannelID != "ch1" {
				t.Fatalf("state after coming back: %+v", state)
			}
		})
	}

	t.Run("orphan sweep/stays away", func(t *testing.T) {
		f := newDepartureFixture(t)
		f.join(t, "u1", "ch1")
		f.expireOrphan("u1")
		f.svc.sweepOrphanStates()
		if got, want := f.evictions(t), []string{oldMain, oldScreen}; !reflect.DeepEqual(got, want) {
			t.Fatalf("evictions: %v, want %v", got, want)
		}
	})
	t.Run("orphan sweep/comes back", func(t *testing.T) {
		f := newDepartureFixture(t)
		f.join(t, "u1", "ch1")
		f.expireOrphan("u1")
		f.hold()
		swept := make(chan struct{})
		go func() {
			defer close(swept)
			f.svc.sweepOrphanStates() // evicts synchronously
		}()
		f.awaitHeld(t)
		f.join(t, "u1", "ch1")
		f.release()
		select {
		case <-swept:
		case <-time.After(5 * time.Second):
			t.Fatal("orphan sweep did not finish")
		}
		if got, want := f.evictions(t), []string{oldScreen}; !reflect.DeepEqual(got, want) {
			t.Fatalf("evictions: %v, want %v", got, want)
		}
	})
}

// TestDepartureEviction_KeepsScreenShareOfReturnedStreamer: the one case in
// which the "_ss" identity is spared — the user is back in the channel AND
// streaming again, so the participant may be the new share.
func TestDepartureEviction_KeepsScreenShareOfReturnedStreamer(t *testing.T) {
	f := newDepartureFixture(t)
	f.join(t, "u1", "ch1")
	f.hold()
	if err := f.svc.LeaveChannel("u1"); err != nil {
		t.Fatalf("LeaveChannel: %v", err)
	}
	f.awaitHeld(t)
	f.join(t, "u1", "ch1")
	streaming := true
	if err := f.svc.UpdateState("u1", nil, nil, &streaming); err != nil {
		t.Fatalf("UpdateState: %v", err)
	}
	f.release()
	if got := f.evictions(t); len(got) != 0 {
		t.Fatalf("evictions: %v, want none", got)
	}
}

// TestModerationEvictions_IgnoreDepartureGuard: every eviction that enforces
// something stays unconditional. In each case the target's voice state is in
// ch1 when the LiveKit call is made — exactly what makes a departure
// eviction stand down — and both identities are removed regardless.
func TestModerationEvictions_IgnoreDepartureGuard(t *testing.T) {
	both := []string{"srv1:ch1 u1", "srv1:ch1 u1_ss"}
	cases := []struct {
		name string
		// evict removes u1 from ch1 while evictions are held; u1 then joins
		// ch1 again before they are released.
		evict func(t *testing.T, f *departureFixture)
	}{
		{"admin disconnect", func(t *testing.T, f *departureFixture) {
			if err := f.svc.AdminDisconnectUser(context.Background(), "admin", "u1"); err != nil {
				t.Fatalf("AdminDisconnectUser: %v", err)
			}
		}},
		// Platform ban and credential revocation end the session through
		// DisconnectUser; kick, ban and timeout through
		// DisconnectSanctionedMember.
		{"disconnect user", func(_ *testing.T, f *departureFixture) { f.svc.DisconnectUser("u1") }},
		{"sanctioned member", func(_ *testing.T, f *departureFixture) { f.svc.DisconnectSanctionedMember("srv1", "u1") }},
		{"server member removed", func(_ *testing.T, f *departureFixture) { f.svc.DisconnectServerMember("srv1", "u1") }},
		{"rejected re-confirmation of own channel", func(t *testing.T, f *departureFixture) {
			f.setTimedOut("u1", true)
			if err := f.svc.JoinChannel("u1", "u1", "U1", "", "ch1", false, false); !errors.Is(err, pkg.ErrForbidden) {
				t.Fatalf("timed-out join: %v", err)
			}
			f.setTimedOut("u1", false)
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newDepartureFixture(t)
			f.join(t, "u1", "ch1")
			f.hold()
			tc.evict(t, f)
			f.awaitHeld(t)
			if state := f.svc.GetUserVoiceState("u1"); state != nil {
				t.Fatalf("session not ended: %+v", state)
			}
			f.join(t, "u1", "ch1")
			f.release()
			if got := f.evictions(t); !reflect.DeepEqual(got, both) {
				t.Fatalf("evictions: %v, want %v", got, both)
			}
		})
	}

	t.Run("moderated participant joined", func(t *testing.T) {
		f := newDepartureFixture(t)
		f.join(t, "u1", "ch1")
		f.setTimedOut("u1", true)
		f.svc.EnforceModerationOnJoin(context.Background(), "srv1", "ch1", "u1")
		if got := f.evictions(t); !reflect.DeepEqual(got, both) {
			t.Fatalf("evictions: %v, want %v", got, both)
		}
	})
	t.Run("channel deleted", func(t *testing.T) {
		f := newDepartureFixture(t)
		f.join(t, "u1", "ch1")
		for _, identity := range []string{"u1", "u1_ss"} {
			f.svc.removeDeletedChannelParticipant(context.Background(), "srv1", "ch1", identity)
		}
		if got := f.evictions(t); !reflect.DeepEqual(got, both) {
			t.Fatalf("evictions: %v, want %v", got, both)
		}
	})
}

// ─── A sanction landing on a join in flight ───

// TestDisconnectUser_RevokesJoinInFlight: JoinChannel reads its admission
// before the write lock. A timeout that commits after that read finds no
// voice state to end — the user has just left ch1, or is in ch2 — so
// ending the session on its own would evict nobody from ch1, the join would
// then write a ch1 state from the pre-sanction read, and that state would make
// the still-pending departure eviction from ch1 stand down: the timed-out
// user's old LiveKit connection would stay in the room. The sanction has to
// revoke the join instead, so no state is written and the departure eviction
// runs. Both forms of the disconnect do: the one the member service calls for
// a sanction in the join's own server, and the account-wide one.
func TestDisconnectUser_RevokesJoinInFlight(t *testing.T) {
	disconnects := []struct {
		name string
		end  func(f *departureFixture)
	}{
		{"server sanction", func(f *departureFixture) { f.svc.DisconnectSanctionedMember("srv1", "u1") }},
		{"account revocation", func(f *departureFixture) { f.svc.DisconnectUser("u1") }},
	}
	cases := []struct {
		name string
		// depart ends u1's presence in ch1 with a guarded departure eviction.
		depart func(t *testing.T, f *departureFixture)
		want   []string
	}{
		{"left and coming back", func(t *testing.T, f *departureFixture) {
			if err := f.svc.LeaveChannel("u1"); err != nil {
				t.Fatalf("LeaveChannel: %v", err)
			}
		}, []string{"srv1:ch1 u1", "srv1:ch1 u1_ss"}},
		// The sanction finds the session in ch2 and evicts from there only.
		{"switched away and coming back", func(t *testing.T, f *departureFixture) {
			f.join(t, "u1", "ch2")
		}, []string{"srv1:ch1 u1", "srv1:ch1 u1_ss", "srv1:ch2 u1", "srv1:ch2 u1_ss"}},
	}
	for _, disconnect := range disconnects {
		for _, tc := range cases {
			t.Run(disconnect.name+"/"+tc.name, func(t *testing.T) {
				f := newDepartureFixture(t)
				f.join(t, "u1", "ch1")
				f.hold()
				tc.depart(t, f)
				f.awaitHeld(t)

				parked, resume := f.parkNextJoin()
				joined := make(chan error, 1)
				go func() { joined <- f.svc.JoinChannel("u1", "u1", "U1", "", "ch1", false, false) }()
				select {
				case <-parked:
				case <-time.After(2 * time.Second):
					t.Fatal("join never reached its admission read")
				}

				// The sanction commits, then the session is ended for it.
				f.setTimedOut("u1", true)
				disconnect.end(f)
				close(resume)

				select {
				case err := <-joined:
					if !errors.Is(err, pkg.ErrForbidden) {
						t.Fatalf("join admitted before the sanction returned %v, want it refused", err)
					}
				case <-time.After(5 * time.Second):
					t.Fatal("join did not return")
				}
				if state := f.svc.GetUserVoiceState("u1"); state != nil {
					t.Fatalf("sanctioned user has a voice state: %+v", state)
				}
				f.release()
				if got := f.evictions(t); !reflect.DeepEqual(got, tc.want) {
					t.Fatalf("evictions: %v, want %v", got, tc.want)
				}
			})
		}
	}
}

// TestDisconnectSanctionedMember_SparesJoinIntoAnotherServer: a kick, ban or
// timeout in srv1 says nothing about srv2, where the user is still a member
// in good standing. A voice join into srv2 that is between its admission read
// and the write lock when the sanction lands must therefore be admitted.
// Refusing it would leave the client — which already holds a valid token and
// an SFU connection for that room — connected with no voice state at all:
// nothing evicts the participant of a refused join, and srv2 has no sanction
// for the participant_joined check to act on. The session the user had in
// srv1 is ended and evicted as before. Only an account-wide revocation
// (DisconnectUser) refuses the join wherever it is headed.
func TestDisconnectSanctionedMember_SparesJoinIntoAnotherServer(t *testing.T) {
	const otherServerChannel = "srv2-ch1"
	// park starts u1's join into srv2 and stops it after its admission read.
	park := func(t *testing.T, f *departureFixture) (joined <-chan error, resume chan<- struct{}) {
		t.Helper()
		parked, release := f.parkNextJoin()
		result := make(chan error, 1)
		go func() { result <- f.svc.JoinChannel("u1", "u1", "U1", "", otherServerChannel, false, false) }()
		select {
		case <-parked:
		case <-time.After(2 * time.Second):
			t.Fatal("join never reached its admission read")
		}
		return result, release
	}
	await := func(t *testing.T, joined <-chan error) error {
		t.Helper()
		select {
		case err := <-joined:
			return err
		case <-time.After(5 * time.Second):
			t.Fatal("join did not return")
			return nil
		}
	}

	cases := []struct {
		name string
		// prior is the srv1 channel u1 is in when the join starts ("": none).
		prior string
		want  []string
	}{
		{"fresh join", "", []string{}},
		// The srv1 session is what the sanction ends; the switch still lands.
		{"switch from the sanctioning server", "ch1", []string{"srv1:ch1 u1", "srv1:ch1 u1_ss"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newDepartureFixture(t)
			if tc.prior != "" {
				f.join(t, "u1", tc.prior)
			}
			joined, resume := park(t, f)

			f.svc.DisconnectSanctionedMember("srv1", "u1")
			close(resume)

			if err := await(t, joined); err != nil {
				t.Fatalf("join into another server refused for a sanction in srv1: %v", err)
			}
			state := f.svc.GetUserVoiceState("u1")
			if state == nil || state.ChannelID != otherServerChannel || state.ServerID != "srv2" {
				t.Fatalf("state after the join: %+v, want %s in srv2", state, otherServerChannel)
			}
			if got := f.evictions(t); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("evictions: %v, want %v", got, tc.want)
			}
		})
	}

	t.Run("account revocation refuses it", func(t *testing.T) {
		f := newDepartureFixture(t)
		joined, resume := park(t, f)

		f.svc.DisconnectUser("u1")
		close(resume)

		if err := await(t, joined); !errors.Is(err, pkg.ErrForbidden) {
			t.Fatalf("join in flight during an account-wide revocation returned %v, want it refused", err)
		}
		if state := f.svc.GetUserVoiceState("u1"); state != nil {
			t.Fatalf("revoked account has a voice state: %+v", state)
		}
	})
}

// TestAFKKick_LeavesJoinInFlightAlone: being idle is not a sanction. The AFK
// sweep ends the idle session with the same unguarded eviction, but a channel
// switch the user has in flight at that moment still lands.
func TestAFKKick_LeavesJoinInFlightAlone(t *testing.T) {
	f := newDepartureFixture(t)
	f.svc.afkTimeoutGetter = &testutil.MockServerRepo{
		IsMemberFn: func(context.Context, string, string) (bool, error) { return true, nil },
		GetByIDFn: func(_ context.Context, id string) (*models.Server, error) {
			return &models.Server{ID: id, AFKTimeoutMinutes: 15}, nil
		},
	}
	f.join(t, "u1", "ch1")
	f.svc.mu.Lock()
	f.svc.states["u1"].LastActivity = time.Now().Add(-time.Hour)
	f.svc.mu.Unlock()

	parked, resume := f.parkNextJoin()
	joined := make(chan error, 1)
	go func() { joined <- f.svc.JoinChannel("u1", "u1", "U1", "", "ch2", false, false) }()
	select {
	case <-parked:
	case <-time.After(2 * time.Second):
		t.Fatal("join never reached its admission read")
	}

	f.svc.sweepAFKUsersContext(context.Background())
	if state := f.svc.GetUserVoiceState("u1"); state != nil {
		t.Fatalf("idle session survived the AFK sweep: %+v", state)
	}
	close(resume)

	select {
	case err := <-joined:
		if err != nil {
			t.Fatalf("channel switch in flight during an AFK kick: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("join did not return")
	}
	if state := f.svc.GetUserVoiceState("u1"); state == nil || state.ChannelID != "ch2" {
		t.Fatalf("state after the switch: %+v", state)
	}
	if got, want := f.evictions(t), []string{"srv1:ch1 u1", "srv1:ch1 u1_ss"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("evictions: %v, want %v", got, want)
	}
}
