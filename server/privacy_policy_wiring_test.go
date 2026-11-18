package main

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
	"testing"
)

func TestPrivacyPolicyCompositionReadsCurrentRepositoryPreferences(t *testing.T) {
	db, _ := newCensusDB(t)
	repos := initRepositories(db.Conn, repository.DataExportStorageOptions{UploadDir: t.TempDir(), ArchiveDir: t.TempDir()})
	ctx := context.Background()
	viewer := &models.User{Username: "policy_viewer", PasswordHash: "fixture", Status: "offline"}
	target := &models.User{Username: "policy_target", PasswordHash: "fixture", Status: "offline"}
	for _, user := range []*models.User{viewer, target} {
		if err := repos.User.Create(ctx, user); err != nil {
			t.Fatal(err)
		}
	}
	server := &models.Server{Name: "policy", OwnerID: viewer.ID}
	if err := repos.Server.Create(ctx, server); err != nil {
		t.Fatal(err)
	}
	for _, user := range []*models.User{viewer, target} {
		if err := repos.Server.AddMember(ctx, server.ID, user.ID); err != nil {
			t.Fatal(err)
		}
	}
	policies := initPrivacyPolicies(repos, ws.NewHub())
	for _, allowed := range []bool{false, true} {
		audience := "friends_only"
		if allowed {
			audience = "all_servers"
		}
		raw, err := json.Marshal(map[string]any{"privacy": map[string]any{"profileAudience": audience, "serverDMDefault": allowed}})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := repos.Preferences.Upsert(ctx, target.ID, raw); err != nil {
			t.Fatal(err)
		}
		profile, err := policies.Profile.CanView(ctx, viewer.ID, target.ID)
		if err != nil || profile != allowed {
			t.Fatalf("profile=%v want=%v err=%v", profile, allowed, err)
		}
		dm, err := policies.ServerDM.CanCreate(ctx, viewer.ID, target.ID)
		if err != nil || dm != allowed {
			t.Fatalf("DM=%v want=%v err=%v", dm, allowed, err)
		}
	}
}

type nilPrivacyPreferences struct{ repository.PreferencesStore }

func TestPrivacyPolicyCompositionRejectsMissingReaders(t *testing.T) {
	db, _ := newCensusDB(t)
	base := initRepositories(db.Conn, repository.DataExportStorageOptions{UploadDir: t.TempDir(), ArchiveDir: t.TempDir()})
	for _, name := range []string{"repositories", "preferences", "typed nil preferences", "friendship", "server", "bans", "presence", "typed nil presence"} {
		t.Run(name, func(t *testing.T) {
			copy := *base
			repos := &copy
			var presence gameActivityOnlineVisibilityChecker = ws.NewHub()
			want := name
			switch name {
			case "repositories":
				repos = nil
			case "preferences":
				repos.Preferences = nil
			case "typed nil preferences":
				var value *nilPrivacyPreferences
				repos.Preferences = value
				want = "preferences"
			case "friendship":
				repos.Friendship = nil
			case "server":
				repos.Server = nil
			case "bans":
				repos.Ban = nil
			case "presence":
				presence = nil
			case "typed nil presence":
				var value *ws.Hub
				presence = value
				want = "presence"
			}
			var caught any
			func() { defer func() { caught = recover() }(); initPrivacyPolicies(repos, presence) }()
			if fmt.Sprint(caught) != "privacy policies require "+want {
				t.Fatalf("panic=%v want missing %s", caught, want)
			}
		})
	}
}
