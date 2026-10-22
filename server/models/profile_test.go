package models

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestNormalizeBio(t *testing.T) {
	ok190 := strings.Repeat("ş", BioMaxRunes)
	cases := []struct {
		name    string
		in      string
		want    string
		wantErr bool
	}{
		{"190 runes accepted", ok190, ok190, false},
		{"191 runes rejected", ok190 + "x", "", true},
		{"CRLF normalised to LF", "line1\r\nline2", "line1\nline2", false},
		{"CR stripped before counting", strings.Repeat("a\r\n", 95), strings.TrimSpace(strings.Repeat("a\n", 95)), false},
		{"newline and tab allowed", "a\n\tb", "a\n\tb", false},
		{"surrounding whitespace trimmed", "  hi  \n", "hi", false},
		{"bidi override rejected", "evil‮txt", "", true},
		{"empty means clear", "   ", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := NormalizeBio(tc.in)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("NormalizeBio(%q) = %q, want error", tc.in, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("NormalizeBio(%q): %v", tc.in, err)
			}
			if got != tc.want {
				t.Errorf("NormalizeBio(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestNormalizePronouns(t *testing.T) {
	ok40 := strings.Repeat("ı", PronounsMaxRunes)
	cases := []struct {
		name    string
		in      string
		want    string
		wantErr bool
	}{
		{"40 runes accepted", ok40, ok40, false},
		{"41 runes rejected", ok40 + "x", "", true},
		{"trimmed", "  she/her ", "she/her", false},
		{"newline rejected (single line)", "she\nher", "", true},
		{"bidi override rejected", "he‮him", "", true},
		{"empty means clear", "", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := NormalizePronouns(tc.in)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("NormalizePronouns(%q) = %q, want error", tc.in, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("NormalizePronouns(%q): %v", tc.in, err)
			}
			if got != tc.want {
				t.Errorf("NormalizePronouns(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestNormalizeAccentColor(t *testing.T) {
	good := map[string]string{"#ABCDEF": "#abcdef", "#00ff7f": "#00ff7f", "": ""}
	for in, want := range good {
		got, err := NormalizeAccentColor(in)
		if err != nil || got != want {
			t.Errorf("NormalizeAccentColor(%q) = %q, %v; want %q, nil", in, got, err, want)
		}
	}
	for _, in := range []string{"#abc", "red", "#gggggg", "abcdef", "#abcdef0", " #abcdef"} {
		if got, err := NormalizeAccentColor(in); err == nil {
			t.Errorf("NormalizeAccentColor(%q) = %q, want error", in, got)
		}
	}
}

// TestUpdateProfileRequest_ValidateNormalisesProfileFields pins that
// Validate writes the normalised value back into the request (the service
// stores what Validate leaves behind).
func TestUpdateProfileRequest_ValidateNormalisesProfileFields(t *testing.T) {
	bio := " hi\r\nthere "
	pronouns := " they/them "
	accent := "#FFAA00"
	req := &UpdateProfileRequest{Bio: &bio, Pronouns: &pronouns, AccentColor: &accent}
	if err := req.Validate(); err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if *req.Bio != "hi\nthere" || *req.Pronouns != "they/them" || *req.AccentColor != "#ffaa00" {
		t.Errorf("normalised = %q / %q / %q", *req.Bio, *req.Pronouns, *req.AccentColor)
	}

	long := strings.Repeat("x", BioMaxRunes+1)
	if err := (&UpdateProfileRequest{Bio: &long}).Validate(); err == nil {
		t.Error("191-rune bio passed Validate")
	}
	bad := "blue"
	if err := (&UpdateProfileRequest{AccentColor: &bad}).Validate(); err == nil {
		t.Error("named accent colour passed Validate")
	}
}

// TestUpdateProfileRequest_MediaFieldsNotDecodable pins the json:"-" tags:
// a PATCH body naming the server-internal media fields must not populate
// them (IsPublicAsset laundering defence, see handlers/member.go).
func TestUpdateProfileRequest_MediaFieldsNotDecodable(t *testing.T) {
	var req UpdateProfileRequest
	body := `{"avatar_animated_url":"/api/uploads/x.gif","banner_url":"/api/uploads/y.png","clear_banner":true,"ClearBanner":true,"BannerURL":"/api/uploads/z.png","AvatarAnimatedURL":"/api/uploads/w.gif"}`
	if err := json.Unmarshal([]byte(body), &req); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if req.AvatarAnimatedURL != nil || req.BannerURL != nil || req.ClearBanner {
		t.Errorf("server-internal fields decoded from JSON: %+v", req)
	}
}

// TestUserProfile_JSONOmitsPII mirrors TestPublicUser_JSONOmitsPII: every
// private field on the input is populated so an accidental passthrough
// shows up as a failing "must not contain" assertion.
func TestUserProfile_JSONOmitsPII(t *testing.T) {
	str := func(s string) *string { return &s }
	owner := "owner-1"
	lastSeen := time.Now()
	full := &User{
		ID:                    "u-1",
		Username:              "alice",
		DisplayName:           str("Alice"),
		AvatarURL:             str("/api/uploads/a_avatar.png"),
		AvatarAnimatedURL:     str("/api/uploads/b_avatar.gif"),
		BannerURL:             str("/api/uploads/c_banner.jpg"),
		Bio:                   str("hello"),
		Pronouns:              str("she/her"),
		AccentColor:           str("#112233"),
		WallpaperURL:          str("/api/uploads/wall.png"),
		PasswordHash:          "bcrypt-hash-should-never-appear",
		Status:                UserStatusOnline,
		PrefStatus:            UserStatusOffline,
		CustomStatus:          str("brb"),
		Email:                 str("leaky@example.com"),
		Language:              "tr",
		DMPrivacy:             "friends_only",
		IsPlatformAdmin:       true,
		IsPlatformBanned:      true,
		HasSeenDownloadPrompt: true,
		HasSeenWelcome:        true,
		LastSeenAt:            &lastSeen,
		IsBot:                 true,
		OwnerUserID:           &owner,
		CreatedAt:             time.Now(),
	}

	body, err := json.Marshal(ToUserProfile(full))
	if err != nil {
		t.Fatalf("marshal UserProfile: %v", err)
	}
	got := string(body)

	for _, key := range []string{
		`"email"`, `"status"`, `"pref_status"`, `"last_seen_at"`, `"dm_privacy"`,
		`"language"`, `"wallpaper_url"`, `"is_platform_`, `"has_seen_`,
		`"owner_user_id"`, `"password`, `leaky@example.com`, `bcrypt-hash`,
	} {
		if strings.Contains(got, key) {
			t.Errorf("UserProfile JSON leaks %s: %s", key, got)
		}
	}
	for _, key := range []string{
		`"id":"u-1"`, `"username":"alice"`, `"display_name":"Alice"`,
		`"avatar_url":"/api/uploads/a_avatar.png"`, `"avatar_animated_url":"/api/uploads/b_avatar.gif"`,
		`"banner_url":"/api/uploads/c_banner.jpg"`, `"bio":"hello"`, `"pronouns":"she/her"`,
		`"accent_color":"#112233"`, `"custom_status":"brb"`, `"is_bot":true`, `"created_at"`,
	} {
		if !strings.Contains(got, key) {
			t.Errorf("UserProfile JSON missing %s: %s", key, got)
		}
	}

	if ToUserProfile(nil) != nil {
		t.Error("ToUserProfile(nil) != nil")
	}
}
