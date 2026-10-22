package repository

import (
	"context"
	"testing"

	"github.com/argeinfina/hichat/models"
)

// TestUserProfileFields_AllReadPaths guards trap #96 for the migration-085
// columns: rows.Scan is positional, so a SELECT/Scan list that forgets the
// new columns compiles fine and silently returns NULL profile fields. All
// four user read paths (GetByID, GetByUsername, GetByEmail, GetAll) must
// hydrate the five fields written by Update.
func TestUserProfileFields_AllReadPaths(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()
	repo := NewSQLiteUserRepo(db.Conn)

	email := "profile@example.com"
	user := &models.User{Username: "profile_user", Status: "online", Email: &email, Language: "en"}
	if err := repo.Create(ctx, user); err != nil {
		t.Fatalf("create user: %v", err)
	}

	str := func(s string) *string { return &s }
	want := struct{ animated, banner, bio, pronouns, accent string }{
		"/api/uploads/0011223344556677_avatar.gif",
		"/api/uploads/8899aabbccddeeff_banner.jpg",
		"line one\nline two",
		"they/them",
		"#a1b2c3",
	}

	fresh, err := repo.GetByID(ctx, user.ID)
	if err != nil {
		t.Fatalf("GetByID before update: %v", err)
	}
	if fresh.AvatarAnimatedURL != nil || fresh.BannerURL != nil || fresh.Bio != nil ||
		fresh.Pronouns != nil || fresh.AccentColor != nil {
		t.Fatalf("new user has non-NULL profile fields: %+v", fresh)
	}
	fresh.AvatarAnimatedURL = str(want.animated)
	fresh.BannerURL = str(want.banner)
	fresh.Bio = str(want.bio)
	fresh.Pronouns = str(want.pronouns)
	fresh.AccentColor = str(want.accent)
	if err := repo.Update(ctx, fresh); err != nil {
		t.Fatalf("Update: %v", err)
	}

	check := func(path string, u *models.User) {
		t.Helper()
		got := func(p *string) string {
			if p == nil {
				return "<nil>"
			}
			return *p
		}
		if got(u.AvatarAnimatedURL) != want.animated || got(u.BannerURL) != want.banner ||
			got(u.Bio) != want.bio || got(u.Pronouns) != want.pronouns || got(u.AccentColor) != want.accent {
			t.Errorf("%s: profile fields = %q %q %q %q %q", path,
				got(u.AvatarAnimatedURL), got(u.BannerURL), got(u.Bio), got(u.Pronouns), got(u.AccentColor))
		}
		// Positional-scan canary: the columns before the new ones still land
		// in the right fields.
		if u.Username != "profile_user" || u.Email == nil || *u.Email != email {
			t.Errorf("%s: shifted scan — username=%q email=%v", path, u.Username, u.Email)
		}
	}

	byID, err := repo.GetByID(ctx, user.ID)
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}
	check("GetByID", byID)

	byName, err := repo.GetByUsername(ctx, "PROFILE_USER")
	if err != nil {
		t.Fatalf("GetByUsername: %v", err)
	}
	check("GetByUsername", byName)

	byEmail, err := repo.GetByEmail(ctx, email)
	if err != nil {
		t.Fatalf("GetByEmail: %v", err)
	}
	check("GetByEmail", byEmail)

	all, err := repo.GetAll(ctx)
	if err != nil {
		t.Fatalf("GetAll: %v", err)
	}
	found := false
	for i := range all {
		if all[i].ID == user.ID {
			found = true
			check("GetAll", &all[i])
		}
	}
	if !found {
		t.Fatal("GetAll did not return the user")
	}

	// Round-trip back to NULL: Update writes nil as NULL.
	byID.AvatarAnimatedURL, byID.BannerURL, byID.Bio, byID.Pronouns, byID.AccentColor = nil, nil, nil, nil, nil
	if err := repo.Update(ctx, byID); err != nil {
		t.Fatalf("Update (clear): %v", err)
	}
	cleared, err := repo.GetByID(ctx, user.ID)
	if err != nil {
		t.Fatalf("GetByID after clear: %v", err)
	}
	if cleared.AvatarAnimatedURL != nil || cleared.BannerURL != nil || cleared.Bio != nil ||
		cleared.Pronouns != nil || cleared.AccentColor != nil {
		t.Errorf("profile fields not cleared: %+v", cleared)
	}
}
