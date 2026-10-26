package repository

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/models"
)

func TestProfileShowcaseLegacyEmptyCollections(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()
	u := &models.User{Username: "showcase_owner", Status: "online", Language: "en"}
	if err := NewSQLiteUserRepo(db.Conn).Create(ctx, u); err != nil {
		t.Fatal(err)
	}
	repo := NewSQLiteProfileShowcaseRepo(db.Conn)
	for _, raw := range []string{`{"theme":{}}`, `{"theme":{},"links":null,"widgets":null}`} {
		if _, err := db.Conn.ExecContext(ctx, `INSERT INTO profile_showcases(user_id,scope_server_id,document,version) VALUES(?,?,?,1) ON CONFLICT(user_id,scope_server_id) DO UPDATE SET document=excluded.document`, u.ID, "", raw); err != nil {
			t.Fatal(err)
		}
		out, err := repo.Get(ctx, u.ID, "")
		if err != nil {
			t.Fatal(err)
		}
		encoded, err := json.Marshal(out)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(encoded), `"links":[]`) || !strings.Contains(string(encoded), `"widgets":[]`) {
			t.Fatalf("non-array collections: %s", encoded)
		}
	}
}

func TestProfileShowcaseManualLinksRoundTrip(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()
	u := &models.User{Username: "link_owner", Status: "online", Language: "en"}
	if err := NewSQLiteUserRepo(db.Conn).Create(ctx, u); err != nil {
		t.Fatal(err)
	}
	repo := NewSQLiteProfileShowcaseRepo(db.Conn)
	in := &models.ProfileShowcase{Links: []models.ProfileLink{{ID: "public", Label: "Site", URL: "https://example.com", Visible: true}, {ID: "private", Label: "Hidden", URL: "https://example.org", Visible: false}}}
	if err := in.Validate(); err != nil {
		t.Fatal(err)
	}
	out, err := repo.Put(ctx, u.ID, "", in, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Links) != 2 || !out.Links[0].Visible || out.Links[1].Visible {
		t.Fatalf("visibility lost on write: %+v", out.Links)
	}
	out.Links = out.Links[:0]
	out, err = repo.Put(ctx, u.ID, "", out, out.Version)
	if err != nil {
		t.Fatal(err)
	}
	if out.Links == nil || len(out.Links) != 0 {
		t.Fatalf("deletion not persisted: %+v", out.Links)
	}
}
