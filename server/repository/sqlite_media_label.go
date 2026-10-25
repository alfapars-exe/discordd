package repository

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"strings"
)

type MediaLabelRepository struct{ db database.TxQuerier }

func NewMediaLabelRepository(db database.TxQuerier) *MediaLabelRepository {
	return &MediaLabelRepository{db: db}
}
func (r *MediaLabelRepository) Set(ctx context.Context, e *models.MediaLabel) error {
	if err := e.Validate(true); err != nil {
		return fmt.Errorf("%w: %v", pkg.ErrBadRequest, err)
	}
	if e.UserID == "" {
		return pkg.ErrUnauthorized
	}
	var token [16]byte
	if _, err := rand.Read(token[:]); err != nil {
		return err
	}
	version := hex.EncodeToString(token[:])
	var result sql.Result
	var err error
	switch {
	case e.ExpectedVersion == nil:
		// Internal compatibility path; public handlers require ExpectedVersion.
		result, err = r.db.ExecContext(ctx, `INSERT INTO private_media_labels(user_id,source_kind,channel_id,message_id,revision,fingerprint,label,version) VALUES(?,?,?,?,?,?,?,?)
 ON CONFLICT(user_id,source_kind,message_id,fingerprint) DO UPDATE SET channel_id=excluded.channel_id,revision=excluded.revision,label=excluded.label,version=excluded.version,updated_at=CURRENT_TIMESTAMP`, e.UserID, e.SourceKind, e.ChannelID, e.MessageID, e.Revision, e.Fingerprint, e.Label, version)
	case *e.ExpectedVersion == "":
		result, err = r.db.ExecContext(ctx, `INSERT INTO private_media_labels(user_id,source_kind,channel_id,message_id,revision,fingerprint,label,version) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id,source_kind,message_id,fingerprint) DO NOTHING`, e.UserID, e.SourceKind, e.ChannelID, e.MessageID, e.Revision, e.Fingerprint, e.Label, version)
	default:
		result, err = r.db.ExecContext(ctx, `UPDATE private_media_labels SET label=?,version=?,updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND source_kind=? AND channel_id=? AND message_id=? AND revision=? AND fingerprint=? AND version=?`, e.Label, version, e.UserID, e.SourceKind, e.ChannelID, e.MessageID, e.Revision, e.Fingerprint, *e.ExpectedVersion)
	}
	if err != nil && strings.Contains(err.Error(), "media_label_limit") {
		return fmt.Errorf("%w: media_label_limit", pkg.ErrBadRequest)
	}
	if err != nil {
		return err
	}
	if e.ExpectedVersion != nil {
		n, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if n == 0 {
			return pkg.ErrConflict
		}
	}
	return nil
}
func (r *MediaLabelRepository) Get(ctx context.Context, e *models.MediaLabel) (*models.MediaLabel, error) {
	if err := e.Validate(false); err != nil {
		return nil, pkg.ErrBadRequest
	}
	if e.UserID == "" {
		return nil, pkg.ErrUnauthorized
	}
	result := *e
	result.ExpectedVersion = nil
	err := r.db.QueryRowContext(ctx, `SELECT label,version FROM private_media_labels WHERE user_id=? AND source_kind=? AND channel_id=? AND message_id=? AND revision=? AND fingerprint=?`, e.UserID, e.SourceKind, e.ChannelID, e.MessageID, e.Revision, e.Fingerprint).Scan(&result.Label, &result.Version)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &result, nil
}
func (r *MediaLabelRepository) Delete(ctx context.Context, e *models.MediaLabel) error {
	if err := e.Validate(false); err != nil {
		return pkg.ErrBadRequest
	}
	if e.UserID == "" {
		return pkg.ErrUnauthorized
	}
	if e.ExpectedVersion != nil && *e.ExpectedVersion == "" {
		found, err := r.Get(ctx, e)
		if err != nil {
			return err
		}
		if found != nil {
			return pkg.ErrConflict
		}
		return nil
	}
	query := `DELETE FROM private_media_labels WHERE user_id=? AND source_kind=? AND channel_id=? AND message_id=? AND revision=? AND fingerprint=?`
	args := []any{e.UserID, e.SourceKind, e.ChannelID, e.MessageID, e.Revision, e.Fingerprint}
	if e.ExpectedVersion != nil {
		query += ` AND version=?`
		args = append(args, *e.ExpectedVersion)
	}
	result, err := r.db.ExecContext(ctx, query, args...)
	if err != nil {
		return err
	}
	if e.ExpectedVersion != nil {
		n, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if n == 0 {
			return pkg.ErrConflict
		}
	}
	return nil
}
