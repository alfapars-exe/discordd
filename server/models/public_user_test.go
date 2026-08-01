package models

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// TestPublicUser_JSONOmitsPII is the regression guard for the leak fixed by
// PublicUser (security scan 2026-07-31, finding N-09): message/DM/pin
// payloads used to embed the full *User, exposing email, admin/ban flags,
// dm_privacy, wallpaper_url, language, pref_status, has_seen_* and
// last_seen_at to every reader of a channel. Every PII field on the input
// User is populated so a passthrough bug (e.g. an accidental embed) shows
// up as a failing "must not contain" assertion, not a vacuous pass.
func TestPublicUser_JSONOmitsPII(t *testing.T) {
	email := "leaky@example.com"
	displayName := "Display Name"
	avatarURL := "https://example.com/avatar.png"
	wallpaperURL := "https://example.com/wallpaper.png"
	customStatus := "brb"
	lastSeen := time.Now()

	full := &User{
		ID:                    "u-1",
		Username:              "alice",
		DisplayName:           &displayName,
		AvatarURL:             &avatarURL,
		WallpaperURL:          &wallpaperURL,
		PasswordHash:          "bcrypt-hash-should-never-appear",
		Status:                UserStatusOnline,
		PrefStatus:            UserStatusOffline,
		CustomStatus:          &customStatus,
		Email:                 &email,
		Language:              "tr",
		DMPrivacy:             "friends_only",
		IsPlatformAdmin:       true,
		IsPlatformBanned:      true,
		HasSeenDownloadPrompt: true,
		HasSeenWelcome:        true,
		LastSeenAt:            &lastSeen,
		IsBot:                 true,
		CreatedAt:             time.Now(),
	}

	pub := ToPublicUser(full)
	if pub == nil {
		t.Fatal("ToPublicUser(non-nil) returned nil")
	}

	body, err := json.Marshal(pub)
	if err != nil {
		t.Fatalf("marshal PublicUser: %v", err)
	}
	got := string(body)

	mustNotContain := []string{
		`"email"`, `"is_platform_admin"`, `"is_platform_banned"`,
		`"dm_privacy"`, `"wallpaper_url"`, `"language"`, `"pref_status"`,
		`"has_seen_download_prompt"`, `"has_seen_welcome"`, `"last_seen_at"`,
		`"is_bot"`, `"password"`,
	}
	for _, key := range mustNotContain {
		if strings.Contains(got, key) {
			t.Errorf("PublicUser JSON leaks PII field %s: %s", key, got)
		}
	}

	mustContain := []string{
		`"id"`, `"username"`, `"display_name"`, `"avatar_url"`,
		`"status"`, `"custom_status"`, `"created_at"`,
	}
	for _, key := range mustContain {
		if !strings.Contains(got, key) {
			t.Errorf("PublicUser JSON missing expected field %s: %s", key, got)
		}
	}

	// Positive-direction sanity: the fields we DO expect actually carry the
	// values from the source User, not zero values that would coincidentally
	// pass the "must contain the key" check above.
	if pub.ID != full.ID || pub.Username != full.Username {
		t.Errorf("PublicUser id/username not copied: got %+v", pub)
	}
	if pub.CustomStatus == nil || *pub.CustomStatus != customStatus {
		t.Errorf("PublicUser.CustomStatus = %v, want %q", pub.CustomStatus, customStatus)
	}
	if !pub.CreatedAt.Equal(full.CreatedAt) {
		t.Errorf("PublicUser.CreatedAt = %v, want %v", pub.CreatedAt, full.CreatedAt)
	}
}

func TestToPublicUser_NilInput(t *testing.T) {
	if got := ToPublicUser(nil); got != nil {
		t.Errorf("ToPublicUser(nil) = %+v, want nil", got)
	}
}
