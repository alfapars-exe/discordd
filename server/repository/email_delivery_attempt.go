package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"github.com/argeinfina/hichat/models"
	"time"
)

func (r *sqliteEmailDeliveryRepo) ReadAttempt(ctx context.Context, id string) (*models.EmailDeliveryAttempt, error) {
	var a models.EmailDeliveryAttempt
	var payload string
	err := r.db.QueryRowContext(ctx, `SELECT provider_key,payload,first_attempt_ms,provider_id,outcome FROM email_delivery_attempts WHERE job_id=?`, id).Scan(&a.Key, &payload, &a.FirstAttemptMS, &a.ProviderID, &a.Outcome)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if payload != "" {
		if err = json.Unmarshal([]byte(payload), &a.Payload); err != nil {
			return nil, errors.New("invalid stored email payload")
		}
	}
	return &a, nil
}

func (r *sqliteEmailDeliveryRepo) PrepareAttempt(ctx context.Context, j *models.EmailDeliveryJob, p models.EmailDeliveryPayload, now time.Time) (*models.EmailDeliveryAttempt, error) {
	payload, err := json.Marshal(p)
	if err != nil {
		return nil, err
	}
	res, err := r.db.ExecContext(ctx, `INSERT INTO email_delivery_attempts(job_id,provider_key,payload,first_attempt_ms,outcome) SELECT id,?,?,?,'prepared' FROM email_delivery_jobs WHERE id=? AND status='delivering' AND claim_token=? AND lease_expires_at>? ON CONFLICT(job_id) DO NOTHING`, "hichat-email/"+j.ID, string(payload), now.UnixMilli(), j.ID, j.ClaimToken, emailTime(now))
	if err != nil {
		return nil, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return nil, ErrStaleEmailDeliveryClaim
	}
	return r.ReadAttempt(ctx, j.ID)
}

func (r *sqliteEmailDeliveryRepo) FinishAttempt(ctx context.Context, j *models.EmailDeliveryJob, providerID, outcome string, now time.Time) error {
	if outcome != "delivered" && outcome != "review" && outcome != "failed" {
		return errors.New("invalid delivery outcome")
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	status, reason := "cancelled", "delivery requires review"
	switch outcome {
	case "delivered":
		status, reason = "delivered", ""
	case "failed":
		reason = "provider rejected immutable payload"
	}
	res, err := tx.ExecContext(ctx, `UPDATE email_delivery_jobs SET status=?,last_error=?,delivered_at=CASE WHEN ?='delivered' THEN ? ELSE delivered_at END,claim_token=NULL,lease_expires_at=NULL WHERE id=? AND status='delivering' AND claim_token=? AND lease_expires_at>?`, status, reason, status, emailTime(now), j.ID, j.ClaimToken, emailTime(now))
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return ErrStaleEmailDeliveryClaim
	}
	res, err = tx.ExecContext(ctx, `UPDATE email_delivery_attempts SET provider_id=?,outcome=? WHERE job_id=?`, providerID, outcome, j.ID)
	if err != nil {
		return err
	}
	n, err = res.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return errors.New("missing prepared delivery")
	}
	return tx.Commit()
}
