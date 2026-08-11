package services

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
)

// newE2EETestDB boots a throwaway file-backed DB with the full embedded
// migration set (mirrors newBotTestDB in bot_service_test.go).
//
// The recipient filter this closes pentest C-03 with is a SQL WHERE clause
// (repository/sqlite_group_session.go GetForRecipient) — only a real SQL
// engine running the real query can falsify it. A hand-rolled Go map fake
// would trivially "cheat" by always filtering correctly regardless of what
// the production SQL actually says.
func newE2EETestDB(t *testing.T) *database.DB {
	t.Helper()
	migrationsFS, err := fs.Sub(database.EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatalf("fs.Sub: %v", err)
	}
	db, err := database.New(filepath.Join(t.TempDir(), "e2ee_test.db"), migrationsFS)
	if err != nil {
		t.Fatalf("database.New: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

// seedE2EEFixture creates a server, a channel, and two member users so
// tests only have to reason about the envelope/permission rows under test.
func seedE2EEFixture(t *testing.T, db *database.DB) (serverID, channelID string) {
	t.Helper()
	ctx := context.Background()
	mustExecE2EE(t, ctx, db, `INSERT INTO users (id, username, password_hash) VALUES ('user-a','alice','x')`)
	mustExecE2EE(t, ctx, db, `INSERT INTO users (id, username, password_hash) VALUES ('user-b','bob','x')`)
	// The distribution SENDER also needs a users row: channel_sender_key_envelopes
	// declares sender_user_id REFERENCES users(id), so seeding only the recipients
	// makes every Upsert fail with FOREIGN KEY constraint failed (787).
	mustExecE2EE(t, ctx, db, `INSERT INTO users (id, username, password_hash) VALUES ('user-sender','carol','x')`)
	mustExecE2EE(t, ctx, db, `INSERT INTO servers (id, name, owner_id) VALUES ('srv-1','Test Server','user-a')`)
	mustExecE2EE(t, ctx, db, `INSERT INTO server_members (server_id, user_id) VALUES ('srv-1','user-a')`)
	mustExecE2EE(t, ctx, db, `INSERT INTO server_members (server_id, user_id) VALUES ('srv-1','user-b')`)
	mustExecE2EE(t, ctx, db, `INSERT INTO server_members (server_id, user_id) VALUES ('srv-1','user-sender')`)
	mustExecE2EE(t, ctx, db, `INSERT INTO channels (id, name, type, server_id) VALUES ('ch-1','general','text','srv-1')`)
	return "srv-1", "ch-1"
}

func mustExecE2EE(t *testing.T, ctx context.Context, db *database.DB, q string, args ...any) {
	t.Helper()
	if _, err := db.Conn.ExecContext(ctx, q, args...); err != nil {
		t.Fatalf("seed %q: %v", q, err)
	}
}

// ─── Service-level test wiring ───

// e2eeTestServiceConfig holds newE2EEServiceForTest's overridable
// collaborators. Zero value matches its defaults: no member lister, a
// permission resolver with no bulk override (falls back to the single-user
// answer per testutil.MockChannelPermResolver), and a no-op broadcaster.
type e2eeTestServiceConfig struct {
	permBulkFn   func(ctx context.Context, channelID string, userIDs []string) (map[string]models.Permission, error)
	memberLister ServerMemberLister
	hub          ws.Broadcaster
}

// e2eeTestServiceOption customizes newE2EEServiceForTest's collaborators for
// tests that need more than the shared defaults.
type e2eeTestServiceOption func(*e2eeTestServiceConfig)

// withPermBulk sets ResolveChannelPermissionsBulk on the permission resolver
// -- needed by tests that exercise UpsertGroupSession's authorized-roster
// check, where the bulk answer must differ per recipient.
func withPermBulk(fn func(ctx context.Context, channelID string, userIDs []string) (map[string]models.Permission, error)) e2eeTestServiceOption {
	return func(c *e2eeTestServiceConfig) { c.permBulkFn = fn }
}

// withMemberLister overrides the (nil-by-default) server member lister --
// needed by tests that exercise the roster's server-membership check.
func withMemberLister(l ServerMemberLister) e2eeTestServiceOption {
	return func(c *e2eeTestServiceConfig) { c.memberLister = l }
}

// withBroadcaster overrides the default no-op broadcaster -- needed by
// tests that assert on which recipients got notified.
func withBroadcaster(hub ws.Broadcaster) e2eeTestServiceOption {
	return func(c *e2eeTestServiceConfig) { c.hub = hub }
}

// newE2EEServiceForTest wires the collaborators every group-session test
// needs: the channel resolves inside serverID, the caller has full channel
// permissions (View+Read+Send), and ownedDevices maps user id -> the one
// device id that user owns -- any other (user, device) pairing returns
// pkg.ErrNotFound, mirroring the real DeviceRepository.GetByUserAndDevice.
func newE2EEServiceForTest(
	t *testing.T,
	serverID, channelID string,
	repo repository.GroupSessionRepository,
	ownedDevices map[string]string,
	opts ...e2eeTestServiceOption,
) E2EEService {
	t.Helper()

	cfg := e2eeTestServiceConfig{hub: &testutil.MockBroadcaster{}}
	for _, opt := range opts {
		opt(&cfg)
	}

	channelGetter := &testutil.MockChannelRepo{
		GetByIDFn: func(context.Context, string) (*models.Channel, error) {
			return &models.Channel{ID: channelID, ServerID: serverID}, nil
		},
	}
	permResolver := &testutil.MockChannelPermResolver{
		ResolveChannelPermissionsFn: func(context.Context, string, string) (models.Permission, error) {
			return models.PermViewChannel | models.PermReadMessages | models.PermSendMessages, nil
		},
		ResolveChannelPermissionsBulkFn: cfg.permBulkFn,
	}
	deviceRepo := &mockDeviceRepo{
		GetByUserAndDeviceFn: func(_ context.Context, userID, deviceID string) (*models.Device, error) {
			if owned, ok := ownedDevices[userID]; ok && owned == deviceID {
				return &models.Device{UserID: userID, DeviceID: deviceID}, nil
			}
			return nil, pkg.ErrNotFound
		},
	}

	return NewE2EEService(nil, repo, deviceRepo, cfg.memberLister,
		cfg.hub, channelGetter, permResolver, nil)
}

// ─── Repository-level: recipient isolation (the SQL WHERE clause itself) ───

// TestGroupSessionRepo_RecipientIsolation is the core C-03 guarantee at the
// SQL layer: a distribution sealing two different envelopes for two
// different recipient devices must only ever surface each envelope to its
// own (recipient_user_id, recipient_device_id).
//
// VACUOUS CONTROL (manually verified, not executed — go test cannot run on
// this Windows dev box; libsql cgo doesn't build here, see repo policy):
// with the `AND recipient_user_id = ? AND recipient_device_id = ?` clause
// temporarily removed from GetForRecipient's query in
// repository/sqlite_group_session.go, GetForRecipient(ctx, "ch-1", "user-b",
// "dev-b1") returns BOTH rows (cipher-for-a and cipher-for-b) instead of
// one, which fails both the len(bEnvelopes) != 1 check and the explicit
// "cipher-for-a" leak check below. Reverted after confirming this by
// inspection; the shipped query keeps the filter.
func TestGroupSessionRepo_RecipientIsolation(t *testing.T) {
	db := newE2EETestDB(t)
	_, channelID := seedE2EEFixture(t, db)
	ctx := context.Background()

	repo := repository.NewSQLiteGroupSessionRepo(db.Conn)

	req := &models.CreateSenderKeyDistributionRequest{
		SessionID: "sess-1",
		Version:   2,
		Envelopes: []models.SenderKeyEnvelopeInput{
			{RecipientUserID: "user-a", RecipientDeviceID: "dev-a1", MessageType: 3, Ciphertext: "cipher-for-a"},
			{RecipientUserID: "user-b", RecipientDeviceID: "dev-b1", MessageType: 3, Ciphertext: "cipher-for-b"},
		},
	}
	if err := repo.Upsert(ctx, channelID, "user-sender", "dev-sender", req); err != nil {
		t.Fatalf("Upsert: %v", err)
	}

	// Precondition — guards against a vacuously-passing test: both envelope
	// rows actually landed.
	var total int
	if err := db.Conn.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM channel_sender_key_envelopes WHERE channel_id = ?`, channelID,
	).Scan(&total); err != nil {
		t.Fatalf("count envelopes: %v", err)
	}
	if total != 2 {
		t.Fatalf("setup: expected 2 envelope rows, got %d", total)
	}

	// B must receive exactly its own envelope — never A's.
	bEnvelopes, err := repo.GetForRecipient(ctx, channelID, "user-b", "dev-b1")
	if err != nil {
		t.Fatalf("GetForRecipient(b): %v", err)
	}
	if len(bEnvelopes) != 1 || bEnvelopes[0].Ciphertext != "cipher-for-b" {
		t.Fatalf("expected exactly B's own envelope, got %+v", bEnvelopes)
	}
	for _, e := range bEnvelopes {
		if e.Ciphertext == "cipher-for-a" {
			t.Fatal("SECURITY: recipient B received recipient A's ciphertext")
		}
	}

	// A must receive exactly its own envelope.
	aEnvelopes, err := repo.GetForRecipient(ctx, channelID, "user-a", "dev-a1")
	if err != nil {
		t.Fatalf("GetForRecipient(a): %v", err)
	}
	if len(aEnvelopes) != 1 || aEnvelopes[0].Ciphertext != "cipher-for-a" {
		t.Fatalf("expected exactly A's own envelope, got %+v", aEnvelopes)
	}

	// Sealing is per DEVICE, not per user — an unrelated device id for A
	// gets nothing, even though it belongs to the same user_id.
	unrelated, err := repo.GetForRecipient(ctx, channelID, "user-a", "dev-a2-never-sealed")
	if err != nil {
		t.Fatalf("GetForRecipient(a, other device): %v", err)
	}
	if len(unrelated) != 0 {
		t.Fatalf("expected no envelopes for an unrelated device id, got %+v", unrelated)
	}
}

// ─── Service-level: GetGroupSessions ───

func TestE2EEService_GetGroupSessions_RecipientIsolation(t *testing.T) {
	db := newE2EETestDB(t)
	serverID, channelID := seedE2EEFixture(t, db)
	ctx := context.Background()
	groupSessionRepo := repository.NewSQLiteGroupSessionRepo(db.Conn)

	req := &models.CreateSenderKeyDistributionRequest{
		SessionID: "sess-1",
		Version:   2,
		Envelopes: []models.SenderKeyEnvelopeInput{
			{RecipientUserID: "user-a", RecipientDeviceID: "dev-a1", MessageType: 3, Ciphertext: "cipher-for-a"},
			{RecipientUserID: "user-b", RecipientDeviceID: "dev-b1", MessageType: 3, Ciphertext: "cipher-for-b"},
		},
	}
	if err := groupSessionRepo.Upsert(ctx, channelID, "user-sender", "dev-sender", req); err != nil {
		t.Fatalf("Upsert: %v", err)
	}

	svc := newE2EEServiceForTest(t, serverID, channelID, groupSessionRepo,
		map[string]string{"user-a": "dev-a1", "user-b": "dev-b1"})

	got, err := svc.GetGroupSessions(ctx, serverID, channelID, "user-b", "dev-b1")
	if err != nil {
		t.Fatalf("GetGroupSessions(b): %v", err)
	}
	if len(got) != 1 || got[0].Ciphertext != "cipher-for-b" {
		t.Fatalf("expected exactly B's own envelope, got %+v", got)
	}
}

// TestE2EEService_GetGroupSessions_ForeignDeviceForbidden proves the device
// ownership gate: a caller cannot read another device's envelopes just by
// naming that device_id in the query string, even for a device that DOES
// have envelopes waiting (dev-a1 does — see fixture above).
func TestE2EEService_GetGroupSessions_ForeignDeviceForbidden(t *testing.T) {
	db := newE2EETestDB(t)
	serverID, channelID := seedE2EEFixture(t, db)
	ctx := context.Background()
	groupSessionRepo := repository.NewSQLiteGroupSessionRepo(db.Conn)

	req := &models.CreateSenderKeyDistributionRequest{
		SessionID: "sess-1",
		Version:   2,
		Envelopes: []models.SenderKeyEnvelopeInput{
			{RecipientUserID: "user-a", RecipientDeviceID: "dev-a1", MessageType: 3, Ciphertext: "cipher-for-a"},
		},
	}
	if err := groupSessionRepo.Upsert(ctx, channelID, "user-sender", "dev-sender", req); err != nil {
		t.Fatalf("Upsert: %v", err)
	}

	// dev-a1 belongs to user-a only -- newE2EEServiceForTest's deviceRepo
	// returns pkg.ErrNotFound for any other (user, device) pairing.
	svc := newE2EEServiceForTest(t, serverID, channelID, groupSessionRepo,
		map[string]string{"user-a": "dev-a1"})

	// user-b (authenticated) tries to read as if it owned dev-a1.
	_, err := svc.GetGroupSessions(ctx, serverID, channelID, "user-b", "dev-a1")
	if err == nil {
		t.Fatal("expected an error for a device_id the caller does not own")
	}
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("expected pkg.ErrForbidden, got %v", err)
	}
}

// ─── UpsertGroupSession / Validate: v2-only, no legacy path ───

func TestCreateSenderKeyDistributionRequest_Validate(t *testing.T) {
	base := func() *models.CreateSenderKeyDistributionRequest {
		return &models.CreateSenderKeyDistributionRequest{
			SessionID: "sess-1",
			Version:   2,
			Envelopes: []models.SenderKeyEnvelopeInput{
				{RecipientUserID: "user-a", RecipientDeviceID: "dev-a1", MessageType: 3, Ciphertext: "c"},
			},
		}
	}

	t.Run("valid v2 request passes", func(t *testing.T) {
		if err := base().Validate(); err != nil {
			t.Fatalf("expected no error, got %v", err)
		}
	})
	t.Run("version != 2 is rejected", func(t *testing.T) {
		req := base()
		req.Version = 1
		if err := req.Validate(); err == nil {
			t.Fatal("expected an error for version 1 (legacy)")
		}
	})
	t.Run("empty envelopes is rejected", func(t *testing.T) {
		req := base()
		req.Envelopes = nil
		if err := req.Validate(); err == nil {
			t.Fatal("expected an error for an empty envelope list")
		}
	})
	t.Run("empty ciphertext is rejected", func(t *testing.T) {
		req := base()
		req.Envelopes[0].Ciphertext = ""
		if err := req.Validate(); err == nil {
			t.Fatal("expected an error for an empty ciphertext")
		}
	})
	// BULGU 3 (pentest C-03 follow-up): unbounded envelope count / ciphertext
	// length let any channel-send-permitted member write arbitrarily large
	// rows. VACUOUS CONTROL: with the len(r.Envelopes) > maxSenderKeyEnvelopes
	// check temporarily removed, this subtest failed to error on 513
	// envelopes as expected -- confirmed by inspection, then reverted (go
	// test cannot run on this Windows dev box; see repo policy).
	t.Run("envelope count over the cap is rejected", func(t *testing.T) {
		req := base()
		env := req.Envelopes[0]
		req.Envelopes = make([]models.SenderKeyEnvelopeInput, 513)
		for i := range req.Envelopes {
			e := env
			e.RecipientDeviceID = fmt.Sprintf("dev-%d", i)
			req.Envelopes[i] = e
		}
		if err := req.Validate(); err == nil {
			t.Fatal("expected an error for 513 envelopes (cap is 512)")
		}
	})
	t.Run("envelope count at the cap is accepted", func(t *testing.T) {
		req := base()
		env := req.Envelopes[0]
		req.Envelopes = make([]models.SenderKeyEnvelopeInput, 512)
		for i := range req.Envelopes {
			e := env
			e.RecipientDeviceID = fmt.Sprintf("dev-%d", i)
			req.Envelopes[i] = e
		}
		if err := req.Validate(); err != nil {
			t.Fatalf("expected no error for exactly 512 envelopes, got %v", err)
		}
	})
	// VACUOUS CONTROL: with the len(e.Ciphertext) > maxSenderKeyCiphertextLen
	// check temporarily removed, this subtest failed to error on a 16385-byte
	// ciphertext -- confirmed by inspection, then reverted (same constraint
	// as above).
	t.Run("ciphertext over the length cap is rejected", func(t *testing.T) {
		req := base()
		req.Envelopes[0].Ciphertext = strings.Repeat("x", 16385)
		if err := req.Validate(); err == nil {
			t.Fatal("expected an error for a 16385-byte ciphertext (cap is 16384)")
		}
	})
	t.Run("ciphertext at the length cap is accepted", func(t *testing.T) {
		req := base()
		req.Envelopes[0].Ciphertext = strings.Repeat("x", 16384)
		if err := req.Validate(); err != nil {
			t.Fatalf("expected no error for a 16384-byte ciphertext, got %v", err)
		}
	})
}

// TestE2EEService_UpsertGroupSession_RejectsWrongVersion proves the service
// surfaces Validate failures as pkg.ErrBadRequest, matching the "reject 400
// for version != 2" wire contract at the service boundary (the raw
// "session_data" legacy-field sniff itself is a handler-layer concern —
// see handlers/e2ee_test.go — since it needs the pre-decode JSON body).
func TestE2EEService_UpsertGroupSession_RejectsWrongVersion(t *testing.T) {
	svc := NewE2EEService(nil, nil, nil, nil, nil, nil, nil, nil)
	req := &models.CreateSenderKeyDistributionRequest{
		SessionID: "sess-1",
		Version:   1,
		Envelopes: []models.SenderKeyEnvelopeInput{
			{RecipientUserID: "user-a", RecipientDeviceID: "dev-a1", MessageType: 3, Ciphertext: "c"},
		},
	}
	err := svc.UpsertGroupSession(context.Background(), "srv-1", "ch-1", "user-a", "dev-a1", req)
	if !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatalf("expected pkg.ErrBadRequest, got %v", err)
	}
}

// TestE2EEService_UpsertGroupSession_NotifiesRecipientsOnly proves the
// group_session_new broadcast targets only the envelope recipients, not
// BroadcastToServer — everyone else on the server wasn't sealed a copy and
// couldn't resolve a GetGroupSessions read from it anyway.
func TestE2EEService_UpsertGroupSession_NotifiesRecipientsOnly(t *testing.T) {
	db := newE2EETestDB(t)
	serverID, channelID := seedE2EEFixture(t, db)
	groupSessionRepo := repository.NewSQLiteGroupSessionRepo(db.Conn)

	var broadcastToServerCalled bool
	var notifiedUserIDs []string
	hub := &testutil.MockBroadcaster{
		BroadcastToServerFn: func(string, ws.Event) { broadcastToServerCalled = true },
		BroadcastToUsersFn:  func(userIDs []string, _ ws.Event) { notifiedUserIDs = userIDs },
	}
	svc := newE2EEServiceForTest(t, serverID, channelID, groupSessionRepo,
		// BULGU 7: the write path now checks the caller owns the sending device.
		map[string]string{"user-a": "dev-a1"},
		withMemberLister(&testutil.MockServerRepo{
			ListMemberIDsFn: func(context.Context, string) ([]string, error) {
				return []string{"user-a", "user-b"}, nil
			},
		}),
		// BULGU 2: UpsertGroupSession now resolves the same authorized-roster
		// set the sender-key-recipients roster does; user-b must be in it for
		// this envelope to be accepted.
		withPermBulk(func(context.Context, string, []string) (map[string]models.Permission, error) {
			return map[string]models.Permission{
				"user-a": models.PermViewChannel | models.PermReadMessages | models.PermSendMessages,
				"user-b": models.PermViewChannel | models.PermReadMessages,
			}, nil
		}),
		withBroadcaster(hub),
	)

	req := &models.CreateSenderKeyDistributionRequest{
		SessionID: "sess-1",
		Version:   2,
		Envelopes: []models.SenderKeyEnvelopeInput{
			{RecipientUserID: "user-b", RecipientDeviceID: "dev-b1", MessageType: 3, Ciphertext: "c"},
		},
	}
	if err := svc.UpsertGroupSession(context.Background(), serverID, channelID, "user-a", "dev-a1", req); err != nil {
		t.Fatalf("UpsertGroupSession: %v", err)
	}

	if broadcastToServerCalled {
		t.Fatal("must not BroadcastToServer for a per-recipient distribution")
	}
	if len(notifiedUserIDs) != 1 || notifiedUserIDs[0] != "user-b" {
		t.Fatalf("expected to notify exactly [user-b], got %v", notifiedUserIDs)
	}
}

// ─── Service-level: GetSenderKeyRecipients roster ───

func TestE2EEService_GetSenderKeyRecipients(t *testing.T) {
	channelGetter := &testutil.MockChannelRepo{
		GetByIDFn: func(context.Context, string) (*models.Channel, error) {
			return &models.Channel{ID: "ch-1", ServerID: "srv-1"}, nil
		},
	}
	permResolver := &testutil.MockChannelPermResolver{
		ResolveChannelPermissionsFn: func(_ context.Context, userID, _ string) (models.Permission, error) {
			if userID == "user-a" {
				return models.PermViewChannel | models.PermReadMessages | models.PermSendMessages, nil
			}
			return 0, nil
		},
		ResolveChannelPermissionsBulkFn: func(_ context.Context, _ string, userIDs []string) (map[string]models.Permission, error) {
			out := make(map[string]models.Permission, len(userIDs))
			for _, id := range userIDs {
				switch id {
				case "user-a":
					out[id] = models.PermViewChannel | models.PermReadMessages | models.PermSendMessages
				case "user-b":
					out[id] = models.PermViewChannel | models.PermReadMessages // read only, no send
				default:
					out[id] = 0 // user-c: no channel access at all
				}
			}
			return out, nil
		},
	}
	memberLister := &testutil.MockServerRepo{
		ListMemberIDsFn: func(context.Context, string) ([]string, error) {
			return []string{"user-a", "user-b", "user-c"}, nil
		},
	}
	calledFor := map[string]bool{}
	deviceRepo := &mockDeviceRepo{
		// BULGU 7: the roster read now also checks caller device ownership.
		GetByUserAndDeviceFn: func(_ context.Context, userID, deviceID string) (*models.Device, error) {
			if userID == "user-a" && deviceID == "dev-a1" {
				return &models.Device{UserID: userID, DeviceID: deviceID}, nil
			}
			return nil, pkg.ErrNotFound
		},
		// BULGU 1: the roster is backed by ListDeviceBundlesNoOTP, not
		// GetPrekeyBundles, so it never touches the one-time-prekey pool.
		ListDeviceBundlesNoOTPFn: func(_ context.Context, userID string) ([]models.PrekeyBundle, error) {
			calledFor[userID] = true
			switch userID {
			case "user-a":
				return []models.PrekeyBundle{{DeviceID: "dev-a1"}, {DeviceID: "dev-a2"}}, nil
			case "user-b":
				return []models.PrekeyBundle{{DeviceID: "dev-b1"}}, nil
			default:
				return nil, nil
			}
		},
	}
	svc := NewE2EEService(nil, nil, deviceRepo, memberLister,
		&testutil.MockBroadcaster{}, channelGetter, permResolver, nil)

	// Caller is user-a on device dev-a1.
	recipients, err := svc.GetSenderKeyRecipients(context.Background(), "srv-1", "ch-1", "user-a", "dev-a1")
	if err != nil {
		t.Fatalf("GetSenderKeyRecipients: %v", err)
	}

	// user-c cannot read the channel: roster excludes it, and its (nonexistent)
	// prekey bundles are never even fetched.
	if calledFor["user-c"] {
		t.Fatal("must not fetch prekey bundles for a member without channel read access")
	}

	byDevice := map[string]bool{}
	for _, r := range recipients {
		byDevice[r.UserID+"/"+r.DeviceID] = true
	}

	// Caller's OWN calling device is excluded.
	if byDevice["user-a/dev-a1"] {
		t.Fatal("roster must not include the caller's own calling device")
	}
	// Caller's OTHER device IS included.
	if !byDevice["user-a/dev-a2"] {
		t.Fatal("roster must include the caller's other devices")
	}
	// A readable member's device is included, even without send permission.
	if !byDevice["user-b/dev-b1"] {
		t.Fatal("roster must include a read-only member's devices")
	}
	// No device belongs to user-c.
	for key := range byDevice {
		if strings.HasPrefix(key, "user-c/") {
			t.Fatalf("roster must not include a member without channel read access, got %s", key)
		}
	}
	if len(recipients) != 2 {
		t.Fatalf("expected exactly 2 recipient devices (a/dev-a2, b/dev-b1), got %d: %+v", len(recipients), recipients)
	}
}

// ─── Service-level: UpsertGroupSession authorization (BULGU 2 / BULGU 7) ───

// TestE2EEService_UpsertGroupSession_RejectsRosterExternalRecipient proves
// BULGU 2 (pentest C-03 follow-up): an envelope addressed to a user outside
// the same authorized-read roster GetSenderKeyRecipients would hand the
// sender is rejected before it ever reaches the repository -- a member
// cannot plant an envelope row (and the group_session_new push that follows
// it) for an arbitrary platform user.
//
// VACUOUS CONTROL: with the `if !authorized[env.RecipientUserID]` check
// temporarily removed from UpsertGroupSession, this test failed to error and
// the envelope row landed -- confirmed by inspection, then reverted (go test
// cannot run on this Windows dev box; see repo policy).
func TestE2EEService_UpsertGroupSession_RejectsRosterExternalRecipient(t *testing.T) {
	db := newE2EETestDB(t)
	serverID, channelID := seedE2EEFixture(t, db)
	groupSessionRepo := repository.NewSQLiteGroupSessionRepo(db.Conn)

	svc := newE2EEServiceForTest(t, serverID, channelID, groupSessionRepo,
		map[string]string{"user-a": "dev-a1"},
		// "user-outsider" is deliberately not a member -- the roster the
		// service resolves never includes it, regardless of what the
		// sender's client claims.
		withMemberLister(&testutil.MockServerRepo{
			ListMemberIDsFn: func(context.Context, string) ([]string, error) {
				return []string{"user-a"}, nil
			},
		}),
		withPermBulk(func(_ context.Context, _ string, userIDs []string) (map[string]models.Permission, error) {
			out := make(map[string]models.Permission, len(userIDs))
			for _, id := range userIDs {
				out[id] = models.PermViewChannel | models.PermReadMessages | models.PermSendMessages
			}
			return out, nil
		}),
	)

	req := &models.CreateSenderKeyDistributionRequest{
		SessionID: "sess-1",
		Version:   2,
		Envelopes: []models.SenderKeyEnvelopeInput{
			{RecipientUserID: "user-outsider", RecipientDeviceID: "dev-x1", MessageType: 3, Ciphertext: "c"},
		},
	}
	err := svc.UpsertGroupSession(context.Background(), serverID, channelID, "user-a", "dev-a1", req)
	if !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatalf("expected pkg.ErrBadRequest for a roster-external recipient, got %v", err)
	}

	var count int
	if err := db.Conn.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM channel_sender_key_envelopes WHERE channel_id = ?`, channelID,
	).Scan(&count); err != nil {
		t.Fatalf("count envelopes: %v", err)
	}
	if count != 0 {
		t.Fatalf("expected no envelope rows written for a rejected upload, got %d", count)
	}
}

// TestE2EEService_UpsertGroupSession_ForeignDeviceForbidden proves BULGU 7
// (pentest C-03 follow-up): the write path now checks device ownership the
// same way the read path (GetGroupSessions) already did -- a caller cannot
// upload a distribution claiming to be sealed BY a device it doesn't own.
func TestE2EEService_UpsertGroupSession_ForeignDeviceForbidden(t *testing.T) {
	db := newE2EETestDB(t)
	serverID, channelID := seedE2EEFixture(t, db)
	groupSessionRepo := repository.NewSQLiteGroupSessionRepo(db.Conn)

	// dev-a1 belongs to user-a only -- newE2EEServiceForTest's deviceRepo
	// returns pkg.ErrNotFound for any other (user, device) pairing.
	svc := newE2EEServiceForTest(t, serverID, channelID, groupSessionRepo,
		map[string]string{"user-a": "dev-a1"})

	req := &models.CreateSenderKeyDistributionRequest{
		SessionID: "sess-1",
		Version:   2,
		Envelopes: []models.SenderKeyEnvelopeInput{
			{RecipientUserID: "user-a", RecipientDeviceID: "dev-a2", MessageType: 3, Ciphertext: "c"},
		},
	}
	// user-b (authenticated) tries to upload as if it owned dev-a1.
	err := svc.UpsertGroupSession(context.Background(), serverID, channelID, "user-b", "dev-a1", req)
	if err == nil {
		t.Fatal("expected an error for a device_id the caller does not own")
	}
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("expected pkg.ErrForbidden, got %v", err)
	}
}

// ─── Repository-level: pruning (BULGU 8) ───

// TestGroupSessionRepo_PruneKeepsOnlyThreeMostRecentGenerations proves BULGU
// 8 (pentest C-03 follow-up): the ON CONFLICT target on Upsert includes
// session_id, so repeated key rotations for the same (channel, sender
// device, recipient device) INSERT a new row per rotation instead of
// overwriting -- without pruning that grows without bound over a channel's
// lifetime. Only the 3 most recent session_ids must survive.
//
// VACUOUS CONTROL: with the prune DELETE temporarily removed from Upsert,
// this test found 4 surviving rows (all of sess-1..sess-4) instead of 3 --
// confirmed by inspection, then reverted (go test cannot run on this Windows
// dev box; see repo policy).
func TestGroupSessionRepo_PruneKeepsOnlyThreeMostRecentGenerations(t *testing.T) {
	db := newE2EETestDB(t)
	_, channelID := seedE2EEFixture(t, db)
	ctx := context.Background()
	repo := repository.NewSQLiteGroupSessionRepo(db.Conn)

	for i := 1; i <= 4; i++ {
		req := &models.CreateSenderKeyDistributionRequest{
			SessionID: fmt.Sprintf("sess-%d", i),
			Version:   2,
			Envelopes: []models.SenderKeyEnvelopeInput{
				{RecipientUserID: "user-a", RecipientDeviceID: "dev-a1", MessageType: 3, Ciphertext: fmt.Sprintf("cipher-%d", i)},
			},
		}
		if err := repo.Upsert(ctx, channelID, "user-sender", "dev-sender", req); err != nil {
			t.Fatalf("Upsert #%d: %v", i, err)
		}
	}

	rows, err := db.Conn.QueryContext(ctx,
		`SELECT session_id FROM channel_sender_key_envelopes
		 WHERE channel_id = ? AND recipient_user_id = 'user-a' AND recipient_device_id = 'dev-a1'
		 ORDER BY rowid ASC`, channelID)
	if err != nil {
		t.Fatalf("query surviving sessions: %v", err)
	}
	defer rows.Close()
	var sessionIDs []string
	for rows.Next() {
		var sid string
		if err := rows.Scan(&sid); err != nil {
			t.Fatalf("scan session_id: %v", err)
		}
		sessionIDs = append(sessionIDs, sid)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows: %v", err)
	}

	want := []string{"sess-2", "sess-3", "sess-4"}
	if len(sessionIDs) != len(want) {
		t.Fatalf("survivors = %v, want %v", sessionIDs, want)
	}
	for i, w := range want {
		if sessionIDs[i] != w {
			t.Fatalf("survivors = %v, want %v", sessionIDs, want)
		}
	}
}
