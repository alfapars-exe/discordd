package services

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
)

// mockDeviceRepo is a test-local DeviceRepository. Only the methods a test
// wires are meaningful; the rest satisfy the interface as no-ops.
type mockDeviceRepo struct {
	RegisterFn          func(ctx context.Context, device *models.Device) error
	ListByUserFn        func(ctx context.Context, userID string) ([]models.Device, error)
	ListPublicByUserFn  func(ctx context.Context, userID string) ([]models.DevicePublicInfo, error)
	DeleteFn            func(ctx context.Context, userID, deviceID string) error
	UpdateSignedPrekeyFn func(ctx context.Context, userID, deviceID string, req *models.UpdateSignedPrekeyRequest) error
	UploadPrekeysFn     func(ctx context.Context, userID, deviceID string, prekeys []models.OTPKey) error
	CountPrekeysFn      func(ctx context.Context, userID, deviceID string) (int, error)
	GetPrekeyBundlesFn  func(ctx context.Context, userID string) ([]models.PrekeyBundle, error)
}

func (m *mockDeviceRepo) Register(ctx context.Context, device *models.Device) error {
	if m.RegisterFn != nil {
		return m.RegisterFn(ctx, device)
	}
	return nil
}
func (m *mockDeviceRepo) GetByUserAndDevice(context.Context, string, string) (*models.Device, error) {
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
		svc := NewDeviceService(repo, &testutil.MockBroadcaster{})
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
		svc := NewDeviceService(repo, captureHub(&events))
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
		svc := NewDeviceService(repo, &testutil.MockBroadcaster{})
		req := validRegisterReq()
		req.OneTimePrekeys = []models.OTPKey{{PublicKey: "pk1"}}
		if _, err := svc.RegisterDevice(ctx, "u1", req); err != nil {
			t.Fatalf("RegisterDevice: %v", err)
		}
		if !uploaded {
			t.Error("initial prekeys must be uploaded when present")
		}
	})
}

func TestListDevices_NilNormalizesToEmpty(t *testing.T) {
	repo := &mockDeviceRepo{ListByUserFn: func(context.Context, string) ([]models.Device, error) { return nil, nil }}
	svc := NewDeviceService(repo, &testutil.MockBroadcaster{})
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
	svc := NewDeviceService(repo, captureHub(&events))
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

func TestUpdateSignedPrekey_InvalidRejected(t *testing.T) {
	svc := NewDeviceService(&mockDeviceRepo{}, &testutil.MockBroadcaster{})
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
	svc := NewDeviceService(repo, captureHub(&events))
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
