package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

type sqliteProfileShowcaseRepo struct{ db database.TxQuerier }

func NewSQLiteProfileShowcaseRepo(db database.TxQuerier) ProfileShowcaseRepository {
	return &sqliteProfileShowcaseRepo{db: db}
}

func (r *sqliteProfileShowcaseRepo) Get(ctx context.Context, userID, scope string) (*models.ProfileShowcase, error) {
	var raw, updated string
	var version int64
	err := r.db.QueryRowContext(ctx, `SELECT document,version,CAST(updated_at AS TEXT) FROM profile_showcases WHERE user_id=? AND scope_server_id=?`, userID, scope).Scan(&raw, &version, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return &models.ProfileShowcase{ScopeServerID: scope, Widgets: []models.ProfileWidget{}, Links: []models.ProfileLink{}}, nil
	}
	if err != nil {
		return nil, err
	}
	var out models.ProfileShowcase
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return nil, err
	}
	out.NormalizeCollections()
	out.ScopeServerID, out.Version, out.UpdatedAt = scope, version, updated
	return &out, nil
}

func (r *sqliteProfileShowcaseRepo) Put(ctx context.Context, userID, scope string, in *models.ProfileShowcase, expected int64) (*models.ProfileShowcase, error) {
	raw, err := json.Marshal(in)
	if err != nil {
		return nil, err
	}
	if expected < 0 {
		return nil, pkg.ErrBadRequest
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if expected == 0 {
		res, err := r.db.ExecContext(ctx, `INSERT INTO profile_showcases(user_id,scope_server_id,document,version,updated_at) VALUES(?,?,?,1,?) ON CONFLICT(user_id,scope_server_id) DO NOTHING`, userID, scope, string(raw), now)
		if err != nil {
			return nil, err
		}
		if n, _ := res.RowsAffected(); n != 1 {
			return nil, pkg.ErrConflict
		}
	} else {
		res, err := r.db.ExecContext(ctx, `UPDATE profile_showcases SET document=?,version=version+1,updated_at=? WHERE user_id=? AND scope_server_id=? AND version=?`, string(raw), now, userID, scope, expected)
		if err != nil {
			return nil, err
		}
		if n, _ := res.RowsAffected(); n != 1 {
			return nil, pkg.ErrConflict
		}
	}
	return r.Get(ctx, userID, scope)
}
