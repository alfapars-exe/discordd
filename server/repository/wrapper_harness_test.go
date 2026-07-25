// Regression guard for the "NewRetryingQuerier stranded every WithTx repo"
// class documented in database/tx.go: the retry wrapper landed in
// initRepositories and silently broke CreateWithSession plus six
// UpdatePositions/Migrate methods, uncaught because the suite built repos from
// a raw *sql.DB and never put the wrapper in the chain.
//
// These tests construct the at-risk repos through wrapForRepo (the SAME
// database.NewRetryingQuerier wrapper prod uses) and exercise their transaction
// path. Both repo shapes are covered:
//   - rawDB computed at construction  (sqliteUserRepo.rawDB → CreateWithSession)
//   - RawDB(r.db) called per-method    (sqliteCategoryRepo.UpdatePositions)
// If either reverts from database.RawDB(...) to a bare db.(*sql.DB) assertion,
// RawDB returns nil through the wrapper and the transaction start fails here —
// which the raw-*sql.DB harness could not detect.
package repository

import (
	"context"
	"testing"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
)

func TestWrapper_RawDBUnwrapsThroughRetryingQuerier(t *testing.T) {
	db := newTestDB(t)
	if got := database.RawDB(wrapForRepo(db)); got != db.Conn {
		t.Fatalf("RawDB(NewRetryingQuerier(db.Conn)) = %v, want the underlying *sql.DB %v", got, db.Conn)
	}
}

func TestWrapper_UserCreateWithSessionThroughRetryingQuerier(t *testing.T) {
	db := newTestDB(t)
	repo := NewSQLiteUserRepo(wrapForRepo(db)) // wrapped, exactly like initRepositories
	ctx := context.Background()

	user := newTestUser("wrapped-createwithsession")
	session := &models.Session{RefreshToken: "wrapped-refresh-token"}

	// CreateWithSession opens its own transaction via database.WithTx(r.rawDB),
	// where rawDB = database.RawDB(db) computed at construction. Through the
	// wrapper that means RawDB must UNWRAP to reach *sql.DB; a bare
	// db.(*sql.DB) assertion would yield nil and this would fail.
	if err := repo.CreateWithSession(ctx, user, session); err != nil {
		t.Fatalf("CreateWithSession through the retry wrapper: %v", err)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM users WHERE id = ?`, user.ID); n != 1 {
		t.Errorf("user rows = %d, want 1 after wrapped CreateWithSession", n)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM sessions WHERE id = ?`, session.ID); n != 1 {
		t.Errorf("session rows = %d, want 1 after wrapped CreateWithSession", n)
	}
}

func TestWrapper_CategoryUpdatePositionsThroughRetryingQuerier(t *testing.T) {
	db := newTestDB(t)
	// Whole repo set through the wrapper — this mirrors initRepositories.
	serverRepo := NewSQLiteServerRepo(wrapForRepo(db))
	roleRepo := NewSQLiteRoleRepo(wrapForRepo(db))
	channelRepo := NewSQLiteChannelRepo(wrapForRepo(db))
	categoryRepo := NewSQLiteCategoryRepo(wrapForRepo(db))
	messageRepo := NewSQLiteMessageRepo(wrapForRepo(db))
	userRepo := NewSQLiteUserRepo(wrapForRepo(db))

	serverID, _, _, _ := seedFullServer(t, struct {
		server   ServerRepository
		role     RoleRepository
		channel  ChannelRepository
		category CategoryRepository
		message  MessageRepository
		user     UserRepository
	}{serverRepo, roleRepo, channelRepo, categoryRepo, messageRepo, userRepo})

	ctx := context.Background()
	catA := &models.Category{ServerID: serverID, Name: "wrap-A", Position: 0}
	catB := &models.Category{ServerID: serverID, Name: "wrap-B", Position: 1}
	if err := categoryRepo.Create(ctx, catA); err != nil {
		t.Fatalf("create category A: %v", err)
	}
	if err := categoryRepo.Create(ctx, catB); err != nil {
		t.Fatalf("create category B: %v", err)
	}

	// UpdatePositions calls database.RawDB(r.db) at method time to start its
	// transaction (sqlite_category.go). Through the wrapper this exercises the
	// unwrap; the method itself returns an explicit error if RawDB yields nil.
	if err := categoryRepo.UpdatePositions(ctx, []models.PositionUpdate{
		{ID: catA.ID, Position: 5},
		{ID: catB.ID, Position: 3},
	}); err != nil {
		t.Fatalf("UpdatePositions through the retry wrapper: %v", err)
	}

	if got := categoryPosition(t, db, catA.ID); got != 5 {
		t.Errorf("category A position = %d, want 5", got)
	}
	if got := categoryPosition(t, db, catB.ID); got != 3 {
		t.Errorf("category B position = %d, want 3", got)
	}
}

func categoryPosition(t *testing.T, db *database.DB, id string) int {
	t.Helper()
	var pos int
	if err := db.Conn.QueryRow(`SELECT position FROM categories WHERE id = ?`, id).Scan(&pos); err != nil {
		t.Fatalf("read category position for %s: %v", id, err)
	}
	return pos
}
