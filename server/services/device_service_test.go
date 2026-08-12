package services

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
)

// passthroughDeviceTxRunner satisfies repository.DeviceTxRunner without a
// real transaction — runs fn directly against the given repo, mirroring
// passthroughTxRunner in message_service_test.go (same package, same
// pattern: RegisterDevice's atomicity is a repository/DB-level concern, not
// something the service-layer unit tests need a real *sql.Tx to observe).
type passthroughDeviceTxRunner struct {
	repo repository.DeviceRepository
}

func (p passthroughDeviceTxRunner) InTx(_ context.Context, fn func(*repository.DeviceTxRepos) error) error {
	return fn(&repository.DeviceTxRepos{Device: p.repo})
}

// failingDeviceTxRunner never calls fn — simulates a transaction that fails
// to even begin (or is deliberately short-circuited), for the "no partial
// side effects on failure" test below.
type failingDeviceTxRunner struct {
	err error
}

func (f failingDeviceTxRunner) InTx(context.Context, func(*repository.DeviceTxRepos) error) error {
	return f.err
}

// mockDeviceRepo is a test-local DeviceRepository. Only the methods a test
// wires are meaningful; the rest satisfy the interface as no-ops.
type mockDeviceRepo struct {
	RegisterFn               func(ctx context.Context, device *models.Device) error
	GetByUserAndDeviceFn     func(ctx context.Context, userID, deviceID string) (*models.Device, error)
	ListByUserFn             func(ctx context.Context, userID string) ([]models.Device, error)
	ListPublicByUserFn       func(ctx context.Context, userID string) ([]models.DevicePublicInfo, error)
	DeleteFn                 func(ctx context.Context, userID, deviceID string) error
	UpdateSignedPrekeyFn     func(ctx context.Context, userID, deviceID string, req *models.UpdateSignedPrekeyRequest) error
	UploadPrekeysFn          func(ctx context.Context, userID, deviceID string, prekeys []models.OTPKey) error
	CountPrekeysFn           func(ctx context.Context, userID, deviceID string) (int, error)
	GetPrekeyBundlesFn       func(ctx context.Context, userID string) ([]models.PrekeyBundle, error)
	ListDeviceBundlesNoOTPFn func(ctx context.Context, userID string) ([]models.PrekeyBundle, error)
}

func (m *mockDeviceRepo) Register(ctx context.Context, device *models.Device) error {
	if m.RegisterFn != nil {
		return m.RegisterFn(ctx, device)
	}
	return nil
}
func (m *mockDeviceRepo) GetByUserAndDevice(ctx context.Context, userID, deviceID string) (*models.Device, error) {
	if m.GetByUserAndDeviceFn != nil {
		return m.GetByUserAndDeviceFn(ctx, userID, deviceID)
	}
	return nil, nil
}
func (m *mockDeviceRepo) ListByUser(ctx context.Context, userID string) ([]models.Device, error) {
	if m.ListByUserFn != nil {
		return m.ListByUserFn(ctx, userID)
	}
	return nil, nil
}
func (m *mockDeviceRepo) ListPublicByUser(ctx context.Context, userID string) ([]models.DevicePublicInfo, error) {
	if m.ListPublicByUserFn != nil {
		return m.ListPublicByUserFn(ctx, userID)
	}
	return nil, nil
}
func (m *mockDeviceRepo) Delete(ctx context.Context, userID, deviceID string) error {
	if m.DeleteFn != nil {
		return m.DeleteFn(ctx, userID, deviceID)
	}
	return nil
}
func (m *mockDeviceRepo) UpdateSignedPrekey(ctx context.Context, userID, deviceID string, req *models.UpdateSignedPrekeyRequest) error {
	if m.UpdateSignedPrekeyFn != nil {
		return m.UpdateSignedPrekeyFn(ctx, userID, deviceID, req)
	}
	return nil
}
func (m *mockDeviceRepo) UpdateLastSeen(context.Context, string, string) error { return nil }
func (m *mockDeviceRepo) UploadPrekeys(ctx context.Context, userID, deviceID string, prekeys []models.OTPKey) error {
	if m.UploadPrekeysFn != nil {
		return m.UploadPrekeysFn(ctx, userID, deviceID, prekeys)
	}
	return nil
}
func (m *mockDeviceRepo) ConsumePrekey(context.Context, string, string) (*models.OneTimePrekey, error) {
	return nil, nil
}
func (m *mockDeviceRepo) CountPrekeys(ctx context.Context, userID, deviceID string) (int, error) {
	if m.CountPrekeysFn != nil {
		return m.CountPrekeysFn(ctx, userID, deviceID)
	}
	return 0, nil
}
func (m *mockDeviceRepo) GetPrekeyBundle(context.Context, string, string) (*models.PrekeyBundle, error) {
	return nil, nil
}
func (m *mockDeviceRepo) GetPrekeyBundles(ctx context.Context, userID string) ([]models.PrekeyBundle, error) {
	if m.GetPrekeyBundlesFn != nil {
		return m.GetPrekeyBundlesFn(ctx, userID)
	}
	return nil, nil
}
func (m *mockDeviceRepo) ListDeviceBundlesNoOTP(ctx context.Context, userID string) ([]models.PrekeyBundle, error) {
	if m.ListDeviceBundlesNoOTPFn != nil {
		return m.ListDeviceBundlesNoOTPFn(ctx, userID)
	}
	return nil, nil
}

// captureHub records BroadcastToUser events for assertions.
func captureHub(events *[]ws.Event) *testutil.MockBroadcaster {
	return &testutil.MockBroadcaster{
		BroadcastToUserFn: func(_ string, e ws.Event) { *events = append(*events, e) },
	}
}

func validRegisterReq() *models.RegisterDeviceRequest {
	return &models.RegisterDeviceRequest{
		DeviceID:        "dev-1",
		IdentityKey:     "id-key",
		SignedPrekey:    "sp",
		SignedPrekeySig: "sig",
	}
}

func TestRegisterDevice(t *testing.T) {
	ctx := context.Background()

	t.Run("invalid request is rejected before any write", func(t *testing.T) {
		called := false
		repo := &mockDeviceRepo{RegisterFn: func(context.Context, *models.Device) error { called = true; return nil }}
		svc := NewDeviceService(repo, passthroughDeviceTxRunner{repo: repo}, &testutil.MockBroadcaster{}, nil)
		if _, err := svc.RegisterDevice(ctx, "u1", &models.RegisterDeviceRequest{}); !errors.Is(err, pkg.ErrBadRequest) {
			t.Errorf("err = %v, want ErrBadRequest", err)
		}
		if called {
			t.Error("Register must not be called for an invalid request")
		}
	})

	t.Run("valid request registers and broadcasts an add", func(t *testing.T) {
		var events []ws.Event
		repo := &mockDeviceRepo{}
		svc := NewDeviceService(repo, passthroughDeviceTxRunner{repo: repo}, captureHub(&events), nil)
		if _, err := svc.RegisterDevice(ctx, "u1", validRegisterReq()); err != nil {
			t.Fatalf("RegisterDevice: %v", err)
		}
		if len(events) != 1 || events[0].Op != ws.OpDeviceListUpdate {
			t.Fatalf("events = %+v, want one OpDeviceListUpdate", events)
		}
		data, ok := events[0].Data.(DeviceListUpdateData)
		if !ok || data.Action != "added" || data.DeviceID != "dev-1" {
			t.Errorf("event data = %+v, want added/dev-1", events[0].Data)
		}
	})

	t.Run("initial one-time prekeys are uploaded", func(t *testing.T) {
		uploaded := false
		repo := &mockDeviceRepo{UploadPrekeysFn: func(context.Context, string, string, []models.OTPKey) error {
			uploaded = true
			return nil
		}}
		svc := NewDeviceService(repo, passthroughDeviceTxRunner{repo: repo}, &testutil.MockBroadcaster{}, nil)
		req := validRegisterReq()
		req.OneTimePrekeys = []models.OTPKey{{PublicKey: "pk1"}}
		if _, err := svc.RegisterDevice(ctx, "u1", req); err != nil {
			t.Fatalf("RegisterDevice: %v", err)
		}
		if !uploaded {
			t.Error("initial prekeys must be uploaded when present")
		}
	})

	// TestRegisterDevice/transaction failure surfaces as an error and skips
	// the broadcast (P1.12): before Register+UploadPrekeys shared one
	// transaction, an UploadPrekeys failure was invisible to the caller
	// (nothing checked its error) and the broadcast fired regardless — so a
	// device with zero prekeys was announced as fully registered.
	t.Run("transaction failure surfaces as an error and skips the broadcast", func(t *testing.T) {
		var events []ws.Event
		repo := &mockDeviceRepo{}
		failing := failingDeviceTxRunner{err: errors.New("tx exploded")}
		svc := NewDeviceService(repo, failing, captureHub(&events), nil)
		if _, err := svc.RegisterDevice(ctx, "u1", validRegisterReq()); err == nil {
			t.Fatal("expected RegisterDevice to surface the transaction failure, got nil error")
		}
		if len(events) != 0 {
			t.Errorf("events = %+v, want none — no broadcast before a successful commit", events)
		}
	})
}

func TestListDevices_NilNormalizesToEmpty(t *testing.T) {
	repo := &mockDeviceRepo{ListByUserFn: func(context.Context, string) ([]models.Device, error) { return nil, nil }}
	svc := NewDeviceService(repo, passthroughDeviceTxRunner{repo: repo}, &testutil.MockBroadcaster{}, nil)
	got, err := svc.ListDevices(context.Background(), "u1")
	if err != nil {
		t.Fatalf("ListDevices: %v", err)
	}
	if got == nil {
		t.Error("ListDevices must return a non-nil empty slice, not nil")
	}
	if len(got) != 0 {
		t.Errorf("got %d devices, want 0", len(got))
	}
}

func TestDeleteDevice_BroadcastsRemoval(t *testing.T) {
	var events []ws.Event
	deleted := false
	repo := &mockDeviceRepo{DeleteFn: func(context.Context, string, string) error { deleted = true; return nil }}
	svc := NewDeviceService(repo, passthroughDeviceTxRunner{repo: repo}, captureHub(&events), nil)
	if err := svc.DeleteDevice(context.Background(), "u1", "dev-1"); err != nil {
		t.Fatalf("DeleteDevice: %v", err)
	}
	if !deleted {
		t.Error("Delete must be called")
	}
	if len(events) != 1 {
		t.Fatalf("events = %+v, want one", events)
	}
	if d, ok := events[0].Data.(DeviceListUpdateData); !ok || d.Action != "removed" {
		t.Errorf("event = %+v, want a removed action", events[0].Data)
	}
}

// TestRegisterDevice_FansOutToUserServers proves BULGU 4 (pentest C-03
// follow-up finding 4): a new device is broadcast not just to the owner's
// own sessions (BroadcastToUser) but to every server the owner shares with
// other members (BroadcastToServer) -- otherwise those members' senders
// never learn the device exists and keep sealing envelopes for a roster that
// silently left one device out.
func TestRegisterDevice_FansOutToUserServers(t *testing.T) {
	repo := &mockDeviceRepo{}
	var serverBroadcasts []string
	hub := &testutil.MockBroadcaster{
		BroadcastToServerFn: func(serverID string, _ ws.Event) { serverBroadcasts = append(serverBroadcasts, serverID) },
	}
	serverLister := &testutil.MockServerRepo{
		GetMemberServerIDsFn: func(context.Context, string) ([]string, error) { return []string{"srv-1", "srv-2"}, nil },
	}
	svc := NewDeviceService(repo, passthroughDeviceTxRunner{repo: repo}, hub, serverLister)

	if _, err := svc.RegisterDevice(context.Background(), "u1", validRegisterReq()); err != nil {
		t.Fatalf("RegisterDevice: %v", err)
	}

	if len(serverBroadcasts) != 2 {
		t.Fatalf("BroadcastToServer called for %v, want exactly [srv-1 srv-2]", serverBroadcasts)
	}
}

// TestDeleteDevice_FansOutToUserServers is the removal-side twin of the test
// above: other members' senders should stop sealing envelopes for a device
// that's gone, not just the owner's own other sessions.
func TestDeleteDevice_FansOutToUserServers(t *testing.T) {
	repo := &mockDeviceRepo{}
	var serverBroadcasts []string
	hub := &testutil.MockBroadcaster{
		BroadcastToServerFn: func(serverID string, _ ws.Event) { serverBroadcasts = append(serverBroadcasts, serverID) },
	}
	serverLister := &testutil.MockServerRepo{
		GetMemberServerIDsFn: func(context.Context, string) ([]string, error) { return []string{"srv-1"}, nil },
	}
	svc := NewDeviceService(repo, passthroughDeviceTxRunner{repo: repo}, hub, serverLister)

	if err := svc.DeleteDevice(context.Background(), "u1", "dev-1"); err != nil {
		t.Fatalf("DeleteDevice: %v", err)
	}

	if len(serverBroadcasts) != 1 || serverBroadcasts[0] != "srv-1" {
		t.Fatalf("BroadcastToServer called for %v, want exactly [srv-1]", serverBroadcasts)
	}
}

func TestUpdateSignedPrekey_InvalidRejected(t *testing.T) {
	deviceRepo := &mockDeviceRepo{}
	svc := NewDeviceService(deviceRepo, passthroughDeviceTxRunner{repo: deviceRepo}, &testutil.MockBroadcaster{}, nil)
	if err := svc.UpdateSignedPrekey(context.Background(), "u1", "dev-1", &models.UpdateSignedPrekeyRequest{}); !errors.Is(err, pkg.ErrBadRequest) {
		t.Errorf("err = %v, want ErrBadRequest", err)
	}
}

func TestGetPrekeyBundles_EmitsPrekeyLowBelowThreshold(t *testing.T) {
	var events []ws.Event
	repo := &mockDeviceRepo{
		GetPrekeyBundlesFn: func(context.Context, string) ([]models.PrekeyBundle, error) {
			return []models.PrekeyBundle{}, nil
		},
		ListByUserFn: func(context.Context, string) ([]models.Device, error) {
			return []models.Device{{DeviceID: "low"}, {DeviceID: "high"}}, nil
		},
		CountPrekeysFn: func(_ context.Context, _, deviceID string) (int, error) {
			if deviceID == "low" {
				return PrekeyLowThreshold - 1, nil // below -> should alert
			}
			return PrekeyLowThreshold + 50, nil // above -> no alert
		},
	}
	svc := NewDeviceService(repo, passthroughDeviceTxRunner{repo: repo}, captureHub(&events), nil)
	if _, err := svc.GetPrekeyBundles(context.Background(), "u1"); err != nil {
		t.Fatalf("GetPrekeyBundles: %v", err)
	}

	var lows []string
	for _, e := range events {
		if e.Op == ws.OpPrekeyLow {
			d := e.Data.(PrekeyLowData)
			lows = append(lows, d.DeviceID)
		}
	}
	if len(lows) != 1 || lows[0] != "low" {
		t.Errorf("prekey_low emitted for %v, want only the below-threshold device [low]", lows)
	}
}
