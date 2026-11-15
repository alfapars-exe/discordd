package repository

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

// Both native backend lanes execute this contract through the production retry
// wrapper. Prepared transaction statements must preserve null/category intent
// and roll back earlier writes when a later row is missing or violates an FK.
func TestChannelPositionsPreparedTransactionContract(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()
	users := NewSQLiteUserRepo(wrapForRepo(db))
	servers := NewSQLiteServerRepo(wrapForRepo(db))
	channels := NewSQLiteChannelRepo(wrapForRepo(db))
	categories := NewSQLiteCategoryRepo(wrapForRepo(db))
	owner := newTestUser("channel-position-contract")
	if err := users.Create(ctx, owner); err != nil {
		t.Fatal(err)
	}
	server := &models.Server{Name: "position-contract", OwnerID: owner.ID}
	if err := servers.Create(ctx, server); err != nil {
		t.Fatal(err)
	}
	first := &models.Category{Name: "first", ServerID: server.ID}
	second := &models.Category{Name: "second", ServerID: server.ID}
	for _, category := range []*models.Category{first, second} {
		if err := categories.Create(ctx, category); err != nil {
			t.Fatal(err)
		}
	}
	a := &models.Channel{Name: "a", Type: "text", ServerID: server.ID, CategoryID: &first.ID, Position: 0}
	b := &models.Channel{Name: "b", Type: "text", ServerID: server.ID, CategoryID: &first.ID, Position: 1}
	for _, channel := range []*models.Channel{a, b} {
		if err := channels.Create(ctx, channel); err != nil {
			t.Fatal(err)
		}
	}
	assertChannel := func(id string, position int, category string) {
		t.Helper()
		got, err := channels.GetByID(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		if got.Position != position {
			t.Fatalf("position=%d want %d", got.Position, position)
		}
		if category == "" {
			if got.CategoryID != nil {
				t.Fatalf("category=%v want NULL", got.CategoryID)
			}
		} else if got.CategoryID == nil || *got.CategoryID != category {
			t.Fatalf("category=%v want %s", got.CategoryID, category)
		}
	}
	if err := channels.UpdatePositions(ctx, []models.PositionUpdate{
		{ID: a.ID, Position: 5}, {ID: b.ID, Position: 6, CategoryID: &second.ID},
	}); err != nil {
		t.Fatal(err)
	}
	assertChannel(a.ID, 5, first.ID)
	assertChannel(b.ID, 6, second.ID)
	empty := ""
	if err := channels.UpdatePositions(ctx, []models.PositionUpdate{
		{ID: a.ID, Position: 7, CategoryID: &empty}, {ID: b.ID, Position: 8},
	}); err != nil {
		t.Fatal(err)
	}
	assertChannel(a.ID, 7, "")
	assertChannel(b.ID, 8, second.ID)
	missing := "00000000-0000-0000-0000-000000000000"
	err := channels.UpdatePositions(ctx, []models.PositionUpdate{
		{ID: a.ID, Position: 90, CategoryID: &second.ID}, {ID: missing, Position: 99},
	})
	if !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("missing row error=%v", err)
	}
	assertChannel(a.ID, 7, "")
	assertChannel(b.ID, 8, second.ID)
	if err := channels.UpdatePositions(ctx, []models.PositionUpdate{
		{ID: a.ID, Position: 91, CategoryID: &second.ID}, {ID: b.ID, Position: 92, CategoryID: &missing},
	}); err == nil {
		t.Fatal("invalid category accepted")
	}
	assertChannel(a.ID, 7, "")
	assertChannel(b.ID, 8, second.ID)
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if err := channels.UpdatePositions(cancelled, []models.PositionUpdate{{ID: a.ID, Position: 100}}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation error=%v", err)
	}
	if err := channels.UpdatePositions(ctx, nil); err != nil {
		t.Fatal(err)
	}
	assertChannel(a.ID, 7, "")
	assertChannel(b.ID, 8, second.ID)
}
