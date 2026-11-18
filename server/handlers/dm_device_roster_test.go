package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

type dmRosterAccessFunc func(context.Context, string, string) ([]string, error)

func (f dmRosterAccessFunc) GetDeviceRosterMembers(ctx context.Context, user, channel string) ([]string, error) {
	return f(ctx, user, channel)
}

type dmRosterDevicesFunc func(context.Context, string) ([]models.Device, error)

func (f dmRosterDevicesFunc) ListDevices(ctx context.Context, user string) ([]models.Device, error) {
	return f(ctx, user)
}

func TestDMDeviceRosterHandlerMetadataOnly(t *testing.T) {
	calls := 0
	signing := "c2lnbg=="
	h := NewDMDeviceRosterHandler(dmRosterAccessFunc(func(_ context.Context, user, channel string) ([]string, error) {
		if user != "alice" || channel != "ch" {
			t.Fatalf("access user=%s channel=%s", user, channel)
		}
		return []string{"alice", "bob"}, nil
	}), dmRosterDevicesFunc(func(_ context.Context, user string) ([]models.Device, error) {
		calls++
		return []models.Device{{UserID: user, DeviceID: user + "-device", IdentityKey: "aGVsbG8=", SigningKey: &signing, RegistrationID: 7, SignedPrekey: "prekey-must-not-leak"}}, nil
	}))
	req := httptest.NewRequest(http.MethodGet, "/api/dms/ch/device-roster", nil)
	req.SetPathValue("channelId", "ch")
	req = req.WithContext(context.WithValue(req.Context(), UserContextKey, &models.User{ID: "alice"}))
	rec := httptest.NewRecorder()
	h.Get(rec, req)
	if rec.Code != 200 || calls != 2 {
		t.Fatalf("status=%d calls=%d body=%s", rec.Code, calls, rec.Body.String())
	}
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("roster may be cached")
	}
	var body struct {
		Data models.DMDeviceRoster `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Data.Version != 1 || len(body.Data.Members) != 2 {
		t.Fatalf("roster=%+v", body.Data)
	}
	// Independent SHA256 fixture, using the documented v1 canonical wire recipe.
	for _, member := range body.Data.Members {
		if len(member.Devices) != 1 || member.Devices[0].KeyRevision != "2d51906b5a2c93b4dc81345646ba830e4685675bc2a03ba52d0858f5a6983c73" {
			t.Fatalf("member=%+v", member)
		}
	}
	for _, forbidden := range []string{"aGVsbG8=", "c2lnbg==", "prekey-must-not-leak", "identity_key", "signing_key", "registration_id", "one_time_prekey"} {
		if strings.Contains(rec.Body.String(), forbidden) {
			t.Fatalf("roster exposes %q", forbidden)
		}
	}
}

func TestDMDeviceRosterHandlerDeniesBeforeReadingDevices(t *testing.T) {
	calls := 0
	h := NewDMDeviceRosterHandler(dmRosterAccessFunc(func(context.Context, string, string) ([]string, error) { return nil, pkg.ErrForbidden }), dmRosterDevicesFunc(func(context.Context, string) ([]models.Device, error) { calls++; return nil, nil }))
	for _, authenticated := range []bool{false, true} {
		req := httptest.NewRequest(http.MethodGet, "/api/dms/ch/device-roster", nil)
		if authenticated {
			req = req.WithContext(context.WithValue(req.Context(), UserContextKey, &models.User{ID: "outsider"}))
		}
		rec := httptest.NewRecorder()
		h.Get(rec, req)
		expected := http.StatusUnauthorized
		if authenticated {
			expected = http.StatusForbidden
		}
		if rec.Code != expected || calls != 0 {
			t.Fatalf("auth=%v status=%d device reads=%d", authenticated, rec.Code, calls)
		}
	}
}

func TestDMDeviceRosterHandlerDoesNotReturnPartialRoster(t *testing.T) {
	h := NewDMDeviceRosterHandler(dmRosterAccessFunc(func(context.Context, string, string) ([]string, error) { return []string{"alice", "bob"}, nil }), dmRosterDevicesFunc(func(_ context.Context, user string) ([]models.Device, error) {
		if user == "bob" {
			return nil, errors.New("device read failed")
		}
		return []models.Device{{DeviceID: "partial-must-not-leak"}}, nil
	}))
	req := httptest.NewRequest(http.MethodGet, "/api/dms/ch/device-roster", nil)
	req = req.WithContext(context.WithValue(req.Context(), UserContextKey, &models.User{ID: "alice"}))
	rec := httptest.NewRecorder()
	h.Get(rec, req)
	if rec.Code != 500 || strings.Contains(rec.Body.String(), "partial-must-not-leak") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestDMDeviceRosterHandlerReadsCurrentDeviceReferences(t *testing.T) {
	phase := 0
	h := NewDMDeviceRosterHandler(dmRosterAccessFunc(func(context.Context, string, string) ([]string, error) { return []string{"alice"}, nil }), dmRosterDevicesFunc(func(context.Context, string) ([]models.Device, error) {
		if phase == 0 {
			return []models.Device{{DeviceID: "removed-device", IdentityKey: "YWxpY2U=", RegistrationID: 1}}, nil
		}
		return []models.Device{{DeviceID: "new-device", IdentityKey: "Ym9i", RegistrationID: 2}}, nil
	}))
	req := httptest.NewRequest(http.MethodGet, "/api/dms/ch/device-roster", nil)
	req = req.WithContext(context.WithValue(req.Context(), UserContextKey, &models.User{ID: "alice"}))
	revisions := []string{}
	for phase = 0; phase < 2; phase++ {
		rec := httptest.NewRecorder()
		h.Get(rec, req)
		if rec.Code != 200 {
			t.Fatalf("phase=%d status=%d", phase, rec.Code)
		}
		var body struct {
			Data models.DMDeviceRoster `json:"data"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		refs := body.Data.Members[0].Devices
		expected := "removed-device"
		if phase == 1 {
			expected = "new-device"
		}
		if len(refs) != 1 || refs[0].DeviceID != expected {
			t.Fatalf("phase=%d refs=%+v", phase, refs)
		}
		revisions = append(revisions, refs[0].KeyRevision)
	}
	if revisions[0] == revisions[1] {
		t.Fatal("changed identity retained its old revision")
	}
}

func TestDMSendCapabilitiesAdvertisesRosterVersion(t *testing.T) {
	h := &DMHandler{maxUploadSize: 12345}
	req := httptest.NewRequest(http.MethodGet, "/api/dms/send-capabilities", nil)
	rec := httptest.NewRecorder()
	h.SendCapabilities(rec, req)
	var body struct {
		Data struct {
			Text        int   `json:"text_idempotency_version"`
			Multipart   int   `json:"multipart_idempotency_version"`
			Max         int64 `json:"max_upload_file_bytes"`
			Roster      int   `json:"dm_device_roster_version"`
			GroupRoster int   `json:"group_dm_device_roster_version"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if rec.Code != 200 || body.Data.Text != 1 || body.Data.Multipart != 1 || body.Data.Max != 12345 || body.Data.Roster != 1 || body.Data.GroupRoster != 1 {
		t.Fatalf("capabilities=%+v status=%d", body, rec.Code)
	}
}
