package services

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
)

// TestGetOrCreateChannel_OtherUserPayloadHasNoPII is the regression guard
// for the leak fixed by models.PublicUser (security scan 2026-07-31,
// finding N-09): dm_channel.go used to embed the full *models.User for the
// other participant (only blanking PasswordHash) into both the API response
// and the OpDMChannelCreate WS broadcast, shipping email, admin/ban flags
// and other PII to the channel's own creator.
func TestGetOrCreateChannel_OtherUserPayloadHasNoPII(t *testing.T) {
	f := newDMFixture()

	email := "bob@example.com"
	lastSeen := time.Now()
	f.users.GetByIDFn = func(_ context.Context, id string) (*models.User, error) {
		return &models.User{
			ID:               id,
			Username:         "bob",
			DMPrivacy:        "everyone",
			Email:            &email,
			IsPlatformAdmin:  true,
			IsPlatformBanned: true,
			Language:         "tr",
			PrefStatus:       models.UserStatusOnline,
			LastSeenAt:       &lastSeen,
			PasswordHash:     "bcrypt-hash-should-never-appear",
		}, nil
	}
	f.repo.GetChannelByUsersFn = func(_ context.Context, _, _ string) (*models.DMChannel, error) {
		return nil, nil // no existing channel — exercise the create path
	}

	result, err := f.svc.GetOrCreateChannel(context.Background(), "alice", "bob")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.OtherUser == nil {
		t.Fatal("other_user should be populated")
	}

	body, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal channel: %v", err)
	}
	leaked := []string{`"email"`, `"is_platform_admin"`, `"is_platform_banned"`, `"dm_privacy"`, `"language"`, `"last_seen_at"`, `"password`}
	for _, key := range leaked {
		if strings.Contains(string(body), key) {
			t.Errorf("DM channel payload leaks PII field %s: %s", key, body)
		}
	}
}

// TestGetOrCreateChannel_ExistingChannel_OtherUserPayloadHasNoPII covers the
// early-return branch (channel already exists), which builds its
// DMChannelWithUser separately from the create branch above.
func TestGetOrCreateChannel_ExistingChannel_OtherUserPayloadHasNoPII(t *testing.T) {
	f := newDMFixture()

	email := "bob@example.com"
	f.users.GetByIDFn = func(_ context.Context, id string) (*models.User, error) {
		return &models.User{
			ID:              id,
			Username:        "bob",
			DMPrivacy:       "everyone",
			Email:           &email,
			IsPlatformAdmin: true,
			PasswordHash:    "bcrypt-hash-should-never-appear",
		}, nil
	}
	f.repo.GetChannelByUsersFn = func(_ context.Context, _, _ string) (*models.DMChannel, error) {
		return &models.DMChannel{ID: "ch-existing", User1ID: "alice", User2ID: "bob", Status: models.DMStatusAccepted}, nil
	}

	result, err := f.svc.GetOrCreateChannel(context.Background(), "alice", "bob")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	body, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal channel: %v", err)
	}
	if strings.Contains(string(body), `"email"`) || strings.Contains(string(body), `"is_platform_admin"`) || strings.Contains(string(body), `"password`) {
		t.Errorf("DM channel payload (existing-channel branch) leaks PII: %s", body)
	}
}
