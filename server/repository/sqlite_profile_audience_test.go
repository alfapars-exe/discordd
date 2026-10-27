package repository

import (
	"context"
	"testing"

	"github.com/argeinfina/hichat/models"
)

func TestListSmallSharedServerUserIDsMatchesAnySharedSmallServer(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()
	repo := NewSQLiteServerRepo(db.Conn)
	reader, ok := repo.(ProfileAudienceSharedServerReader)
	if !ok {
		t.Fatal("server repo missing profile audience bulk capability")
	}
	viewer := newTestUser("profile-audience-viewer")
	target := newTestUser("profile-audience-target")
	other := newTestUser("profile-audience-other")
	for _, user := range []*models.User{viewer, target, other} {
		if err := NewSQLiteUserRepo(db.Conn).Create(ctx, user); err != nil {
			t.Fatal(err)
		}
	}
	large := &models.Server{Name: "profile-audience-large", OwnerID: viewer.ID}
	small := &models.Server{Name: "profile-audience-small", OwnerID: viewer.ID}
	for _, server := range []*models.Server{large, small} {
		if err := repo.Create(ctx, server); err != nil {
			t.Fatal(err)
		}
	}
	for _, user := range []*models.User{viewer, target, other} {
		if err := repo.AddMember(ctx, large.ID, user.ID); err != nil {
			t.Fatal(err)
		}
	}
	for _, user := range []*models.User{viewer, target} {
		if err := repo.AddMember(ctx, small.ID, user.ID); err != nil {
			t.Fatal(err)
		}
	}
	got, err := reader.ListSmallSharedServerUserIDs(ctx, viewer.ID, []string{target.ID, other.ID}, 2)
	if err != nil {
		t.Fatal(err)
	}
	if !got[target.ID] || got[other.ID] {
		t.Fatalf("small shared server decisions = %#v, want target=true other=false", got)
	}
}
