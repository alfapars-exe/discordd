package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type groupRosterAccessFunc func(context.Context, string, string) (int64, []string, error)

func (f groupRosterAccessFunc) GetGroupDeviceRosterMembers(ctx context.Context, user, group string) (int64, []string, error) {
	return f(ctx, user, group)
}
func TestGroupDeviceRosterMetadataAndEpoch(t *testing.T) {
	var users []string
	h := NewGroupDMDeviceRosterHandler(groupRosterAccessFunc(func(_ context.Context, user, group string) (int64, []string, error) {
		if user != "me" || group != "g" {
			t.Fatalf("wrong scope %s %s", user, group)
		}
		return 9, []string{"me", "peer", "third"}, nil
	}), dmRosterDevicesFunc(func(_ context.Context, user string) ([]models.Device, error) {
		users = append(users, user)
		return []models.Device{{DeviceID: user + "-device", IdentityKey: "secret-key-must-not-leak", SignedPrekey: "prekey-must-not-leak"}}, nil
	}))
	req := httptest.NewRequest("GET", "/api/group-dms/g/device-roster", nil)
	req.SetPathValue("groupId", "g")
	req = req.WithContext(context.WithValue(req.Context(), UserContextKey, &models.User{ID: "me"}))
	rec := httptest.NewRecorder()
	h.Get(rec, req)
	if rec.Code != http.StatusOK || rec.Header().Get("Cache-Control") != "no-store" || len(users) != 3 {
		t.Fatalf("status=%d calls=%v", rec.Code, users)
	}
	var body struct {
		Data struct {
			Version  int                           `json:"version"`
			KeyEpoch int64                         `json:"key_epoch"`
			Members  []models.DMDeviceRosterMember `json:"members"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Data.KeyEpoch != 9 || body.Data.Version != 1 || len(body.Data.Members) != 3 {
		t.Fatalf("roster=%+v", body)
	}
	if strings.Contains(rec.Body.String(), "must-not-leak") {
		t.Fatal("keys exposed")
	}
}
func TestGroupDeviceRosterDenialAndPartialFailure(t *testing.T) {
	for _, tc := range []struct {
		name          string
		auth          bool
		denied        bool
		deviceFailure bool
		status        int
		calls         int
	}{
		{name: "unauthenticated", status: 401},
		{name: "nonmember", auth: true, denied: true, status: 404},
		{name: "partial device failure", auth: true, deviceFailure: true, status: 500, calls: 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			h := NewGroupDMDeviceRosterHandler(groupRosterAccessFunc(func(context.Context, string, string) (int64, []string, error) {
				if tc.denied {
					return 0, nil, pkg.ErrNotFound
				}
				return 7, []string{"me", "peer"}, nil
			}), dmRosterDevicesFunc(func(context.Context, string) ([]models.Device, error) {
				calls++
				if calls == 2 && tc.deviceFailure {
					return nil, errors.New("unavailable")
				}
				return []models.Device{{DeviceID: "partial-device"}}, nil
			}))
			req := httptest.NewRequest("GET", "/api/group-dms/g/device-roster", nil)
			if tc.auth {
				req = req.WithContext(context.WithValue(req.Context(), UserContextKey, &models.User{ID: "me"}))
			}
			rec := httptest.NewRecorder()
			h.Get(rec, req)
			if rec.Code != tc.status || calls != tc.calls {
				t.Fatalf("status=%d calls=%d body=%s", rec.Code, calls, rec.Body.String())
			}
			if strings.Contains(rec.Body.String(), "partial-device") || strings.Contains(rec.Body.String(), "key_epoch") {
				t.Fatal("partial roster leaked")
			}
		})
	}
}
