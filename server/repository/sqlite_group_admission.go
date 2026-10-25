package repository

import (
	"context"
	"database/sql"
	"sort"
	"strings"

	"github.com/argeinfina/hichat/pkg"
)

// No scope is a trusted internal legacy/import path, never a public-service fallback.
func checkGroupAdmissionScope(actor []string, owner string) error {
	if len(actor) == 0 {
		return nil
	}
	if len(actor) != 1 || strings.TrimSpace(actor[0]) == "" || actor[0] != strings.TrimSpace(actor[0]) {
		return pkg.ErrBadRequest
	}
	if actor[0] != owner {
		return pkg.ErrForbidden
	}
	return nil
}

// Lock the existing accepted pair until group commit, serializing concurrent
// unfriend/block transitions without adding a second permission infrastructure.
func lockGroupAdmissionFriends(ctx context.Context, tx *sql.Tx, actor string, targets []string) error {
	ordered := append([]string(nil), targets...)
	sort.Strings(ordered)
	for _, target := range ordered {
		if target == actor {
			continue
		}
		const lockQuery = `UPDATE friendships SET status=status WHERE status='accepted' AND ((user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?))`
		result, err := tx.ExecContext(ctx, lockQuery, actor, target, target, actor)
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if count == 0 {
			return pkg.ErrForbidden
		}
		var blocked bool
		const blockQuery = `SELECT EXISTS(SELECT 1 FROM friendships WHERE status='blocked' AND ((user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?)))`
		if err := tx.QueryRowContext(ctx, blockQuery, actor, target, target, actor).Scan(&blocked); err != nil {
			return err
		}
		if blocked {
			return pkg.ErrForbidden
		}
	}
	return nil
}
