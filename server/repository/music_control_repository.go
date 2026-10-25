package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

// MusicControlRepository is deliberately separate from the legacy session
// store. Protocol 2 callers must use CommitMusicOperation, never Save followed
// by a receipt insert: those two writes must share the same transaction.
type MusicControlRepository interface {
	MusicControlHead(context.Context, string) (*models.MusicControlHead, error)
	AdoptMusicControl(context.Context, models.MusicControlHead) (models.MusicControlHead, error)
	FindMusicReceipt(context.Context, models.MusicOperation) (*models.MusicOperationReceipt, error)
	CommitMusicOperation(context.Context, models.MusicOperationCommit) (models.MusicOperationReceipt, bool, error)
	SaveMusicTransition(context.Context, models.MusicControlHead, *models.MusicSession) error
}

// SaveMusicTransition is for trusted playback transitions, never HTTP commands.
// A retired publisher cannot overwrite a replacement session after disconnect.
func (r *sqliteMusicSessionRepo) SaveMusicTransition(ctx context.Context, next models.MusicControlHead, session *models.MusicSession) error {
	if session != nil && (session.SessionID != next.SessionID || session.ChannelID != next.ChannelID || session.ServerID != next.ServerID || session.Revision != next.Revision) {
		return pkg.ErrBadRequest
	}
	db := database.RawDB(r.db)
	if db == nil {
		return fmt.Errorf("music transition requires a transaction-capable store")
	}
	return database.WithTx(ctx, db, func(tx *sql.Tx) error {
		if err := lockMusicIdentityTx(ctx, tx, r.postgres); err != nil {
			return err
		}
		if session != nil {
			cleaned, err := sanitizeMusicTracks(ctx, tx, r.postgres, session.Queue)
			if err != nil {
				return err
			}
			copy := *session
			copy.Queue = cleaned
			session = &copy
		}
		// Serialize even equal-revision checks; an equal revision may only
		// confirm exactly the already stored snapshot, never overwrite it.
		_, err := tx.ExecContext(ctx, `UPDATE music_control_heads SET revision=revision WHERE channel_id=?`, next.ChannelID)
		if err != nil {
			return err
		}
		head, err := readMusicHead(ctx, tx, next.ChannelID)
		if err != nil {
			return err
		}
		if head == nil || head.SessionID != next.SessionID || head.ServerID != next.ServerID || head.Revision > next.Revision {
			return pkg.ErrConflict
		}
		if head.Revision == next.Revision {
			var raw, mode string
			var revision uint64
			err := tx.QueryRowContext(ctx, `SELECT queue_json,repeat_mode,revision FROM music_sessions WHERE channel_id=?`, next.ChannelID).Scan(&raw, &mode, &revision)
			if session == nil && errors.Is(err, sql.ErrNoRows) {
				return nil
			}
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			if session != nil && err == nil {
				expected, marshalErr := json.Marshal(session.Queue)
				if marshalErr != nil {
					return marshalErr
				}
				equal, err := equalMusicQueueJSON(expected, []byte(raw))
				if err != nil {
					return err
				}
				if equal && mode == session.RepeatMode && revision == session.Revision {
					return nil
				}
			}
			return pkg.ErrConflict
		}
		res, err := tx.ExecContext(ctx, `UPDATE music_control_heads SET revision=? WHERE channel_id=? AND session_id=? AND revision<?`, next.Revision, next.ChannelID, next.SessionID, next.Revision)
		if err != nil {
			return err
		}
		n, err := res.RowsAffected()
		if err != nil {
			return err
		}
		if n != 1 {
			return pkg.ErrConflict
		}
		store := &sqliteMusicSessionRepo{db: tx, postgres: r.postgres}
		if session == nil {
			return store.Delete(ctx, next.ChannelID)
		}
		return store.Save(ctx, *session)
	})
}

func readMusicHead(ctx context.Context, q database.TxQuerier, channelID string) (*models.MusicControlHead, error) {
	var h models.MusicControlHead
	err := q.QueryRowContext(ctx, `SELECT channel_id,server_id,session_id,revision,minimum_protocol FROM music_control_heads WHERE channel_id=?`, channelID).
		Scan(&h.ChannelID, &h.ServerID, &h.SessionID, &h.Revision, &h.MinimumProtocol)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read music control head: %w", err)
	}
	return &h, nil
}

func (r *sqliteMusicSessionRepo) MusicControlHead(ctx context.Context, channelID string) (*models.MusicControlHead, error) {
	return readMusicHead(ctx, r.db, channelID)
}

// AdoptMusicControl is explicit and idempotent. A second caller receives the
// existing head; it cannot reset a live revision or rotate an existing session.
// The caller holds its channel lifecycle/session locks while providing the live
// snapshot revision. Read-only state requests never call this method.
func (r *sqliteMusicSessionRepo) AdoptMusicControl(ctx context.Context, proposed models.MusicControlHead) (models.MusicControlHead, error) {
	if proposed.ChannelID == "" || proposed.ServerID == "" || proposed.SessionID == "" || proposed.MinimumProtocol != 2 {
		return models.MusicControlHead{}, pkg.ErrBadRequest
	}
	db := database.RawDB(r.db)
	if db == nil {
		return models.MusicControlHead{}, fmt.Errorf("music control adoption requires a transaction-capable store")
	}
	var result models.MusicControlHead
	err := database.WithTx(ctx, db, func(tx *sql.Tx) error {
		if err := lockMusicIdentityTx(ctx, tx, r.postgres); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO music_control_heads(channel_id,server_id,session_id,revision,minimum_protocol) VALUES(?,?,?,?,2) ON CONFLICT(channel_id) DO NOTHING`, proposed.ChannelID, proposed.ServerID, proposed.SessionID, proposed.Revision); err != nil {
			return err
		}
		head, err := readMusicHead(ctx, tx, proposed.ChannelID)
		if err != nil {
			return err
		}
		if head == nil || head.ServerID != proposed.ServerID {
			return pkg.ErrConflict
		}
		result = *head
		return nil
	})
	return result, err
}

func findMusicReceipt(ctx context.Context, q database.TxQuerier, op models.MusicOperation) (*models.MusicOperationReceipt, error) {
	var receipt models.MusicOperationReceipt
	var raw string
	receipt.ActorID, receipt.ChannelID, receipt.RequestID = op.ActorID, op.ChannelID, op.RequestID
	err := q.QueryRowContext(ctx, `SELECT session_id,request_hash,expected_revision,result_json FROM music_operation_receipts WHERE channel_id=? AND actor_id=? AND request_id=?`, op.ChannelID, op.ActorID, op.RequestID).
		Scan(&receipt.SessionID, &receipt.RequestHash, &receipt.ExpectedRevision, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read music operation receipt: %w", err)
	}
	if receipt.SessionID != op.SessionID || receipt.RequestHash != op.RequestHash || receipt.ExpectedRevision != op.ExpectedRevision {
		return nil, fmt.Errorf("%w: music request id was already used with another payload", pkg.ErrConflict)
	}
	receipt.Result = json.RawMessage(raw)
	return &receipt, nil
}

func (r *sqliteMusicSessionRepo) FindMusicReceipt(ctx context.Context, op models.MusicOperation) (*models.MusicOperationReceipt, error) {
	return findMusicReceipt(ctx, r.db, op)
}

// CommitMusicOperation performs a write CAS before the receipt lookup to
// serialize writers on both SQLite and PostgreSQL. The no-op write does not
// change revision/session. Historical receipt lookup still precedes semantic
// CAS validation, so an exact stop retry acknowledges its old result without
// stopping a replacement session. No receipt retention silently downgrades this
// guarantee: receipts live until their actor/channel is deleted.
func (r *sqliteMusicSessionRepo) CommitMusicOperation(ctx context.Context, commit models.MusicOperationCommit) (models.MusicOperationReceipt, bool, error) {
	op := commit.Operation
	if op.ActorID == "" || op.ChannelID == "" || op.SessionID == "" || op.RequestID == "" || len(op.RequestHash) != 64 || !json.Valid(commit.Result) {
		return models.MusicOperationReceipt{}, false, pkg.ErrBadRequest
	}
	if commit.NextHead.ChannelID != op.ChannelID || commit.NextHead.SessionID == "" || commit.NextHead.MinimumProtocol != 2 || commit.NextHead.Revision != op.ExpectedRevision+1 {
		return models.MusicOperationReceipt{}, false, pkg.ErrBadRequest
	}
	if commit.Session != nil && (commit.Session.SessionID != commit.NextHead.SessionID || commit.Session.ChannelID != op.ChannelID || commit.Session.ServerID != commit.NextHead.ServerID || commit.Session.Revision != commit.NextHead.Revision) {
		return models.MusicOperationReceipt{}, false, pkg.ErrBadRequest
	}
	db := database.RawDB(r.db)
	if db == nil {
		return models.MusicOperationReceipt{}, false, fmt.Errorf("music operation requires a transaction-capable store")
	}
	var result models.MusicOperationReceipt
	replayed := false
	err := database.WithTx(ctx, db, func(tx *sql.Tx) error {
		if err := lockMusicIdentityTx(ctx, tx, r.postgres); err != nil {
			return err
		}
		if err := requireLiveMusicActor(ctx, tx, op.ActorID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE music_control_heads SET revision=revision WHERE channel_id=?`, op.ChannelID); err != nil {
			return err
		}
		previous, err := findMusicReceipt(ctx, tx, op)
		if err != nil {
			return err
		}
		if previous != nil {
			result, replayed = *previous, true
			return nil
		}
		head, err := readMusicHead(ctx, tx, op.ChannelID)
		if err != nil {
			return err
		}
		if head == nil || head.SessionID != op.SessionID || head.Revision != op.ExpectedRevision || head.ServerID != commit.NextHead.ServerID {
			return fmt.Errorf("%w: music session or revision changed", pkg.ErrConflict)
		}
		updated, err := tx.ExecContext(ctx, `UPDATE music_control_heads SET session_id=?,revision=? WHERE channel_id=? AND session_id=? AND revision=?`, commit.NextHead.SessionID, commit.NextHead.Revision, op.ChannelID, op.SessionID, op.ExpectedRevision)
		if err != nil {
			return err
		}
		rows, err := updated.RowsAffected()
		if err != nil {
			return err
		}
		if rows != 1 {
			return pkg.ErrConflict
		}
		store := &sqliteMusicSessionRepo{db: tx, postgres: r.postgres}
		if commit.Session == nil {
			err = store.Delete(ctx, op.ChannelID)
		} else {
			err = store.Save(ctx, *commit.Session)
		}
		if err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO music_operation_receipts(channel_id,actor_id,request_id,session_id,request_hash,expected_revision,result_json) VALUES(?,?,?,?,?,?,?)`, op.ChannelID, op.ActorID, op.RequestID, op.SessionID, op.RequestHash, op.ExpectedRevision, string(commit.Result)); err != nil {
			return err
		}
		result = models.MusicOperationReceipt{MusicOperation: op, Result: append(json.RawMessage(nil), commit.Result...)}
		return nil
	})
	return result, replayed, err
}
