// Atomic user + session creation used during registration.
package repository

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
)

// CreateWithSession creates a user and an associated session atomically —
// either both rows commit or neither does. Closes the orphaned-user-row bug:
// previously user-insert and session-insert were separate autocommit
// statements, so a dropped session insert left a committed, tokenless user
// row (client saw 500; a retry then hit 409). Used by AuthService.Register.
func (r *sqliteUserRepo) CreateWithSession(ctx context.Context, user *models.User, session *models.Session) error {
	if r.rawDB == nil {
		return fmt.Errorf("CreateWithSession requires a *sql.DB-backed repository")
	}
	return database.WithTx(ctx, r.rawDB, func(tx *sql.Tx) error {
		txUserRepo := &sqliteUserRepo{db: tx}
		if err := txUserRepo.Create(ctx, user); err != nil {
			return err
		}

		session.UserID = user.ID
		txSessionRepo := &sqliteSessionRepo{db: tx}
		if err := txSessionRepo.Create(ctx, session); err != nil {
			return fmt.Errorf("failed to create session: %w", err)
		}
		return nil
	})
}
