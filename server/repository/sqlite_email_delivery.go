package repository

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"time"

	"github.com/argeinfina/hichat/models"
)

type sqliteEmailDeliveryRepo struct{ db *sql.DB }

func NewSQLiteEmailDeliveryRepo(db *sql.DB) EmailDeliveryRepository {
	return &sqliteEmailDeliveryRepo{db: db}
}

func emailTime(t time.Time) string { return t.UTC().Format("2006-01-02 15:04:05") }

const emailDeliveryMaxAttempts = 5
const emailDeliveryLease = 5 * time.Minute

func newEmailDeliveryClaimToken() (string, error) {
	var value [32]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value[:]), nil
}

func validEmailDeliveryCategory(category string) bool {
	switch category {
	case models.EmailCategoryCommunication, models.EmailCategorySocial,
		models.EmailCategoryAnnouncements, models.EmailCategoryTips,
		models.EmailCategoryRecommendations:
		return true
	default:
		return false
	}
}

// Missing preference namespaces and category values retain the existing
// enabled-by-default behavior. Present but malformed consent data fails
// closed so corrupted JSON cannot silently opt a user back in.
func emailCategoryAllowed(raw sql.NullString, category string) bool {
	if !validEmailDeliveryCategory(category) {
		return false
	}
	if !raw.Valid {
		return category != models.EmailCategoryRecommendations
	}
	var root map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw.String), &root); err != nil || root == nil {
		return false
	}
	preferences, exists := root["email_preferences"]
	values := make(map[string]json.RawMessage)
	if exists {
		if err := json.Unmarshal(preferences, &values); err != nil || values == nil {
			return false
		}
	}
	if rawUnsubscribed, exists := values["marketingUnsubscribed"]; exists {
		unsubscribed, ok := parseEmailPreferenceBool(rawUnsubscribed)
		if !ok || unsubscribed {
			return false
		}
	}
	if rawEnabled, exists := values[category]; exists {
		enabled, ok := parseEmailPreferenceBool(rawEnabled)
		if !ok || !enabled {
			return false
		}
	}
	if category == models.EmailCategoryRecommendations {
		// Personalization recommendations are consent-gated independently from
		// the email category and are disabled by default in the product service.
		privacyRaw, exists := root["privacy"]
		if !exists {
			return false
		}
		var privacy map[string]json.RawMessage
		if err := json.Unmarshal(privacyRaw, &privacy); err != nil || privacy == nil {
			return false
		}
		personalizationRaw, exists := privacy["experiencePersonalization"]
		if !exists {
			return false
		}
		personalization, ok := parseEmailPreferenceBool(personalizationRaw)
		if !ok || !personalization {
			return false
		}
	}
	return true
}

func parseEmailPreferenceBool(raw json.RawMessage) (bool, bool) {
	switch string(bytes.TrimSpace(raw)) {
	case "true":
		return true, true
	case "false":
		return false, true
	default:
		return false, false
	}
}

func (r *sqliteEmailDeliveryRepo) EnqueueIfEligible(ctx context.Context, j *models.EmailDeliveryJob) (bool, error) {
	if err := j.Validate(); err != nil {
		return false, err
	}
	var address sql.NullString
	var verified sql.NullString
	var raw sql.NullString
	err := r.db.QueryRowContext(ctx, `SELECT u.email,u.email_verified_at,p.data FROM users u LEFT JOIN user_preferences p ON p.user_id=u.id WHERE u.id=? AND u.deleted_at IS NULL AND u.is_bot=0 AND NOT EXISTS(SELECT 1 FROM account_lifecycle l WHERE l.user_id=u.id AND l.disabled_at IS NOT NULL)`, j.UserID).Scan(&address, &verified, &raw)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !address.Valid || address.String == "" || !verified.Valid {
		return false, nil
	}
	if !emailCategoryAllowed(raw, j.Category) {
		return false, nil
	}
	id, err := generateID()
	if err != nil {
		return false, err
	}
	j.ID = id
	var res sql.Result
	if j.NotBefore == "" && j.ExpiresAt == "" && j.DMMessageID == "" && j.FriendshipID == "" {
		res, err = r.db.ExecContext(ctx, `INSERT INTO email_delivery_jobs(id,user_id,category,dedupe_key,subject,body_html,server_event_id,server_event_starts_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id,category,dedupe_key) DO NOTHING`, j.ID, j.UserID, j.Category, j.DedupeKey, j.Subject, j.BodyHTML, nullableEmailEvent(j.ServerEventID), nullableEmailEvent(j.ServerEventStartsAt))
	} else {
		notBefore := any(nil)
		if j.NotBefore != "" {
			notBefore = emailCampaignTimeDB(serverEventParsedTime(j.NotBefore))
		}
		expiresAt := any(nil)
		if j.ExpiresAt != "" {
			expiresAt = emailCampaignTimeDB(serverEventParsedTime(j.ExpiresAt))
		}
		res, err = r.db.ExecContext(ctx, `INSERT INTO email_delivery_jobs(id,user_id,category,dedupe_key,subject,body_html,server_event_id,server_event_starts_at,expires_at,dm_message_id,friendship_id,friendship_event,next_attempt_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,COALESCE(?,CURRENT_TIMESTAMP)) ON CONFLICT(user_id,category,dedupe_key) DO NOTHING`, j.ID, j.UserID, j.Category, j.DedupeKey, j.Subject, j.BodyHTML, nullableEmailEvent(j.ServerEventID), nullableEmailEvent(j.ServerEventStartsAt), expiresAt, nullableEmailEvent(j.DMMessageID), nullableEmailEvent(j.FriendshipID), nullableEmailEvent(j.FriendshipEvent), notBefore)
	}
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

func (r *sqliteEmailDeliveryRepo) CanDeliver(ctx context.Context, job *models.EmailDeliveryJob, now time.Time) (bool, error) {
	if job == nil || !validEmailDeliveryCategory(job.Category) {
		return false, nil
	}
	if job.ExpiresAt != "" {
		expiresAt, err := time.Parse(time.RFC3339Nano, job.ExpiresAt)
		if err != nil || !expiresAt.After(now.UTC()) {
			return false, nil
		}
	}
	var address, verified, raw sql.NullString
	if job.ClaimToken != "" {
		var owns int
		if err := r.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM email_delivery_jobs WHERE id=? AND status='delivering' AND claim_token=? AND lease_expires_at>?`, job.ID, job.ClaimToken, emailTime(now.Add(10*time.Second))).Scan(&owns); err != nil {
			return false, err
		}
		if owns != 1 {
			return false, nil
		}
	}
	err := r.db.QueryRowContext(ctx, `SELECT u.email,u.email_verified_at,p.data FROM users u LEFT JOIN user_preferences p ON p.user_id=u.id WHERE u.id=? AND u.deleted_at IS NULL AND u.is_bot=0 AND NOT EXISTS(SELECT 1 FROM account_lifecycle l WHERE l.user_id=u.id AND l.disabled_at IS NOT NULL)`, job.UserID).Scan(&address, &verified, &raw)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !address.Valid || address.String == "" || !verified.Valid || address.String != job.Address {
		return false, nil
	}
	if !emailCategoryAllowed(raw, job.Category) {
		return false, nil
	}
	if job.DMMessageID != "" {
		if job.Category != models.EmailCategoryCommunication {
			return false, nil
		}
		job.DMUnreadCount = 0
		var unreadCount int
		err = r.db.QueryRowContext(ctx, `SELECT COALESCE(MAX(dr.unread_count),0) FROM dm_messages m
			JOIN dm_channels dc ON dc.id=m.dm_channel_id AND dc.status='accepted'
			JOIN dm_reads dr ON dr.dm_channel_id=dc.id AND dr.user_id=? AND dr.unread_count>0
			WHERE m.id=? AND m.user_id<>? AND ((dc.user1_id=? AND dc.user2_id=m.user_id) OR (dc.user2_id=? AND dc.user1_id=m.user_id))
			AND (dr.last_read_message_id IS NULL OR EXISTS(SELECT 1 FROM dm_messages cursor WHERE cursor.id=dr.last_read_message_id AND cursor.dm_channel_id=dc.id AND (m.created_at>cursor.created_at OR (m.created_at=cursor.created_at AND m.id>cursor.id))))
			AND NOT EXISTS(SELECT 1 FROM friendships f WHERE f.status='blocked' AND ((f.user_id=? AND f.friend_id=m.user_id) OR (f.user_id=m.user_id AND f.friend_id=?)))
			AND NOT EXISTS(
				SELECT 1 FROM email_delivery_jobs newer_job JOIN dm_messages newer ON newer.id=newer_job.dm_message_id
				WHERE newer_job.user_id=? AND newer_job.category='communication'
				AND newer_job.status IN ('pending','delivering','delivered')
				AND (newer_job.expires_at IS NULL OR newer_job.expires_at>?)
				AND newer.dm_channel_id=m.dm_channel_id AND newer.user_id=m.user_id
				AND (newer.created_at>m.created_at OR (newer.created_at=m.created_at AND newer.id>m.id))
			)`, job.UserID, job.DMMessageID, job.UserID, job.UserID, job.UserID, job.UserID, job.UserID, job.UserID, emailTime(now)).Scan(&unreadCount)
		if err != nil {
			return false, err
		}
		if unreadCount <= 0 {
			return false, nil
		}
		job.DMUnreadCount = unreadCount
		return true, nil
	}
	if job.FriendshipID != "" {
		if job.Category != models.EmailCategorySocial {
			return false, nil
		}
		var current bool
		err = r.db.QueryRowContext(ctx, `SELECT EXISTS(
			SELECT 1 FROM friendships f
			WHERE f.id=? AND (
				(?='request' AND f.status='pending' AND f.friend_id=?) OR
				(?='accepted' AND f.status='accepted' AND f.user_id=?)
			) AND NOT EXISTS(
				SELECT 1 FROM friendships blocked WHERE blocked.status='blocked' AND
				((blocked.user_id=f.user_id AND blocked.friend_id=f.friend_id) OR (blocked.user_id=f.friend_id AND blocked.friend_id=f.user_id))
			)
		)`, job.FriendshipID, job.FriendshipEvent, job.UserID, job.FriendshipEvent, job.UserID).Scan(&current)
		if err != nil {
			return false, err
		}
		return current, nil
	}
	if job.ServerEventID == "" {
		return true, nil
	}
	if job.Category != models.EmailCategorySocial {
		return false, nil
	}
	start, err := time.Parse(time.RFC3339Nano, serverEventTimeAPI(job.ServerEventStartsAt))
	if err != nil {
		return false, nil
	}
	var eventStart string
	err = r.db.QueryRowContext(ctx, `SELECT CAST(e.starts_at AS TEXT) FROM server_events e
		JOIN server_members sm ON sm.server_id=e.server_id AND sm.user_id=?
		JOIN server_event_rsvps rsvp ON rsvp.event_id=e.id AND rsvp.user_id=sm.user_id
	WHERE e.id=? AND e.status='scheduled'`, job.UserID, job.ServerEventID).Scan(&eventStart)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	currentStart, err := time.Parse(time.RFC3339Nano, serverEventTimeAPI(eventStart))
	if err != nil || !currentStart.Equal(start) {
		return false, nil
	}
	if !currentStart.After(now.UTC()) || currentStart.After(now.UTC().Add(serverEventNoticeWindow)) {
		return false, nil
	}
	return true, nil
}

func nullableEmailEvent(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func (r *sqliteEmailDeliveryRepo) ClaimDue(ctx context.Context, now time.Time, limit int) ([]models.EmailDeliveryJob, error) {
	if limit < 1 || limit > 100 {
		limit = 25
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `UPDATE email_delivery_jobs SET status='cancelled',claim_token=NULL,lease_expires_at=NULL,
		last_error='campaign expired' WHERE status IN ('pending','delivering') AND expires_at IS NOT NULL AND expires_at<=?`, emailCampaignTimeDB(now)); err != nil {
		return nil, err
	}
	// Recover expired and pre-lease rows. A crashed worker's attempt counts
	// against the same hard retry ceiling as an explicit send failure.
	if _, err = tx.ExecContext(ctx, `UPDATE email_delivery_jobs SET status=CASE WHEN attempts>=? THEN 'cancelled' ELSE 'pending' END,claim_token=NULL,lease_expires_at=NULL,last_error=CASE WHEN attempts>=? THEN 'delivery lease expired; retry limit reached' ELSE 'delivery lease expired' END WHERE status='delivering' AND (lease_expires_at IS NULL OR lease_expires_at<=?)`, emailDeliveryMaxAttempts, emailDeliveryMaxAttempts, emailTime(now)); err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE email_delivery_attempts SET outcome='review' WHERE outcome='prepared' AND job_id IN (SELECT id FROM email_delivery_jobs WHERE status='cancelled')`); err != nil {
		return nil, err
	}
	rows, err := tx.QueryContext(ctx, `SELECT j.id,j.user_id,j.category,j.subject,j.body_html,j.attempts,u.email,j.server_event_id,CAST(j.server_event_starts_at AS TEXT),CAST(j.expires_at AS TEXT),j.dm_message_id,j.friendship_id,j.friendship_event FROM email_delivery_jobs j JOIN users u ON u.id=j.user_id WHERE j.status='pending' AND j.attempts<? AND j.next_attempt_at<=? AND u.email_verified_at IS NOT NULL AND (j.expires_at IS NULL OR j.expires_at>?) ORDER BY j.next_attempt_at,j.id LIMIT ?`, emailDeliveryMaxAttempts, emailTime(now), emailCampaignTimeDB(now), limit)
	if err != nil {
		return nil, err
	}
	var jobs []models.EmailDeliveryJob
	for rows.Next() {
		var j models.EmailDeliveryJob
		var eventID, eventStartsAt, expiresAt, dmMessageID, friendshipID, friendshipEvent sql.NullString
		if err = rows.Scan(&j.ID, &j.UserID, &j.Category, &j.Subject, &j.BodyHTML, &j.Attempts, &j.Address, &eventID, &eventStartsAt, &expiresAt, &dmMessageID, &friendshipID, &friendshipEvent); err != nil {
			rows.Close()
			return nil, err
		}
		j.ServerEventID = eventID.String
		if eventStartsAt.Valid {
			j.ServerEventStartsAt = serverEventTimeAPI(eventStartsAt.String)
		}
		if expiresAt.Valid {
			j.ExpiresAt = emailCampaignTimeAPI(expiresAt.String)
		}
		j.DMMessageID = dmMessageID.String
		j.FriendshipID = friendshipID.String
		j.FriendshipEvent = friendshipEvent.String
		jobs = append(jobs, j)
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	if err = rows.Close(); err != nil {
		return nil, err
	}
	claimed := jobs[:0]
	for _, j := range jobs {
		token, e := newEmailDeliveryClaimToken()
		if e != nil {
			return nil, e
		}
		res, e := tx.ExecContext(ctx, `UPDATE email_delivery_jobs SET status='delivering',attempts=attempts+1,claim_token=?,lease_expires_at=? WHERE id=? AND status='pending' AND attempts<?`, token, emailTime(now.Add(emailDeliveryLease)), j.ID, emailDeliveryMaxAttempts)
		if e != nil {
			return nil, e
		}
		n, _ := res.RowsAffected()
		if n > 0 {
			j.Attempts++
			j.ClaimToken = token
			claimed = append(claimed, j)
		}
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return claimed, nil
}

func serverEventParsedTime(value string) time.Time {
	t, _ := time.Parse(time.RFC3339Nano, value)
	return t.UTC()
}
func (r *sqliteEmailDeliveryRepo) MarkDelivered(ctx context.Context, id, claimToken string, now time.Time) error {
	res, err := r.db.ExecContext(ctx, `UPDATE email_delivery_jobs SET status='delivered',delivered_at=?,last_error=NULL,claim_token=NULL,lease_expires_at=NULL WHERE id=? AND status='delivering' AND claim_token=? AND lease_expires_at>?`, emailTime(now), id, claimToken, emailTime(now))
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrStaleEmailDeliveryClaim
	}
	return nil
}
func (r *sqliteEmailDeliveryRepo) Retry(ctx context.Context, id, claimToken, message string, next time.Time, max int) error {
	if len(message) > 1000 {
		message = message[:1000]
	}
	if max < 1 {
		max = 5
	}
	if max > emailDeliveryMaxAttempts || max < 1 {
		max = emailDeliveryMaxAttempts
	}
	res, err := r.db.ExecContext(ctx, `UPDATE email_delivery_jobs SET status=CASE WHEN attempts>=? THEN 'cancelled' ELSE 'pending' END,next_attempt_at=?,last_error=?,claim_token=NULL,lease_expires_at=NULL WHERE id=? AND status='delivering' AND claim_token=? AND lease_expires_at>?`, max, emailTime(next), message, id, claimToken, emailTime(time.Now()))
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrStaleEmailDeliveryClaim
	}
	return nil
}
