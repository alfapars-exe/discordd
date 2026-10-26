package services

import (
	"context"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/testutil"
)

// Exercise the actual registration transaction and profile service: the first
// registration payload must be as usable as a subsequent database-backed login.
func TestRegisterDefaultsRemainValidForProfileSave(t *testing.T) {
	h, auth, _ := boundAuthHarness(t)
	ctx := context.Background()
	tokens, err := auth.Register(ctx, &models.CreateUserRequest{
		Username: "registration_defaults", Email: "defaults@example.test", Password: "registration-password",
	})
	if err != nil {
		t.Fatal(err)
	}
	users := repository.NewSQLiteUserRepo(h.db.Conn)
	stored, err := users.GetByID(ctx, tokens.User.ID)
	if err != nil {
		t.Fatal(err)
	}
	login, err := auth.Login(ctx, &models.LoginRequest{Username: tokens.User.Username, Password: "registration-password"})
	if err != nil {
		t.Fatal(err)
	}
	for name, user := range map[string]*models.User{"registration": &tokens.User, "database": stored, "login": &login.User} {
		if user.Language != "en" || user.DMPrivacy != "message_request" {
			t.Errorf("%s defaults = %q/%q, want en/message_request", name, user.Language, user.DMPrivacy)
		}
	}
	bio := "Yerel kabul testi — HiChat."
	profile := NewMemberService(users, nil, nil, nil, &testutil.MockServerRepo{}, &testutil.MockEventPublisher{}, nil, nil)
	if _, err := profile.UpdateProfile(ctx, tokens.User.ID, &models.UpdateProfileRequest{
		Bio: &bio, Language: &tokens.User.Language, DMPrivacy: &tokens.User.DMPrivacy,
	}); err != nil {
		t.Fatalf("profile save using newly registered account: %v", err)
	}
	stored, err = users.GetByID(ctx, tokens.User.ID)
	if err != nil || stored.Bio == nil || *stored.Bio != bio {
		t.Fatalf("profile was not persisted: %v", err)
	}
	// Registration must not repair or otherwise modify unrelated legacy rows.
	legacy, err := users.GetByID(ctx, h.user.ID)
	if err != nil || legacy.Language != "" {
		t.Fatalf("registration changed legacy language: %v", err)
	}
}
