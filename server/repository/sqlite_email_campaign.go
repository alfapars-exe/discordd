package repository

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
)

const emailCampaignMaxRecipients = 10_000

type sqliteEmailCampaignRepo struct{ db database.TxQuerier }

func NewSQLiteEmailCampaignRepo(db database.TxQuerier) EmailCampaignRepository {
	return &sqliteEmailCampaignRepo{db: db}
}

func (r *sqliteEmailCampaignRepo) CreateDraft(ctx context.Context, campaign *models.EmailCampaign) error {
	if campaign == nil {
		return fmt.Errorf("email campaign is required")
	}
	_, err := r.db.ExecContext(ctx, `INSERT INTO email_campaigns
		(id,category,subject,body_text,status,expires_at,created_by,created_at)
		VALUES(?,?,?,?,'draft',?,?,?)`, campaign.ID, campaign.Category, campaign.Subject,
		campaign.Body, emailCampaignTimeDB(campaign.ExpiresAt), campaign.CreatedBy, emailCampaignTimeDB(campaign.CreatedAt))
	return err
}

func (r *sqliteEmailCampaignRepo) Get(ctx context.Context, id string) (*models.EmailCampaign, error) {
	campaign, err := scanEmailCampaign(r.db.QueryRowContext(ctx, emailCampaignSelect+` WHERE id=?`, id))
	if err == sql.ErrNoRows {
		return nil, ErrEmailCampaignNotFound
	}
	return campaign, err
}

const emailCampaignSelect = `SELECT id,category,subject,body_text,status,CAST(expires_at AS TEXT),created_by,
	CAST(created_at AS TEXT),published_by,CAST(published_at AS TEXT),recipient_count FROM email_campaigns`

func scanEmailCampaign(row interface{ Scan(...any) error }) (*models.EmailCampaign, error) {
	var c models.EmailCampaign
	var publishedBy, publishedAt sql.NullString
	if err := row.Scan(&c.ID, &c.Category, &c.Subject, &c.Body, &c.Status, &c.ExpiresAt, &c.CreatedBy,
		&c.CreatedAt, &publishedBy, &publishedAt, &c.RecipientCount); err != nil {
		return nil, err
	}
	c.ExpiresAt = emailCampaignTimeAPI(c.ExpiresAt)
	c.CreatedAt = emailCampaignTimeAPI(c.CreatedAt)
	if publishedBy.Valid {
		c.PublishedBy = &publishedBy.String
	}
	if publishedAt.Valid {
		value := emailCampaignTimeAPI(publishedAt.String)
		c.PublishedAt = &value
	}
	return &c, nil
}

func (r *sqliteEmailCampaignRepo) CountEligible(ctx context.Context, category string) (int, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT u.id,p.data FROM users u
		LEFT JOIN user_preferences p ON p.user_id=u.id
		WHERE u.email IS NOT NULL AND u.email<>'' AND u.email_verified_at IS NOT NULL
		AND u.deleted_at IS NULL AND u.is_bot=0
		AND NOT EXISTS(SELECT 1 FROM account_lifecycle l WHERE l.user_id=u.id AND l.disabled_at IS NOT NULL)
		ORDER BY u.id`)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		var userID string
		var prefs sql.NullString
		if err := rows.Scan(&userID, &prefs); err != nil {
			return 0, err
		}
		if emailCategoryAllowed(prefs, category) {
			count++
			if count > emailCampaignMaxRecipients {
				return count, ErrEmailCampaignAudienceFull
			}
		}
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}
	if count > emailCampaignMaxRecipients {
		return count, ErrEmailCampaignAudienceFull
	}
	return count, nil
}

type emailCampaignRecipient struct{ id string }

func (r *sqliteEmailCampaignRepo) eligibleRecipients(ctx context.Context, tx *sql.Tx, category string) ([]emailCampaignRecipient, error) {
	rows, err := tx.QueryContext(ctx, `SELECT u.id,p.data FROM users u
		LEFT JOIN user_preferences p ON p.user_id=u.id
		WHERE u.email IS NOT NULL AND u.email<>'' AND u.email_verified_at IS NOT NULL
		AND u.deleted_at IS NULL AND u.is_bot=0
		AND NOT EXISTS(SELECT 1 FROM account_lifecycle l WHERE l.user_id=u.id AND l.disabled_at IS NOT NULL)
		ORDER BY u.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	recipients := make([]emailCampaignRecipient, 0)
	for rows.Next() {
		var recipient emailCampaignRecipient
		var prefs sql.NullString
		if err := rows.Scan(&recipient.id, &prefs); err != nil {
			return nil, err
		}
		if emailCategoryAllowed(prefs, category) {
			recipients = append(recipients, recipient)
			if len(recipients) > emailCampaignMaxRecipients {
				return nil, ErrEmailCampaignAudienceFull
			}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return recipients, nil
}

func (r *sqliteEmailCampaignRepo) Publish(ctx context.Context, id, adminID string, now time.Time) (*models.EmailCampaign, error) {
	rawDB := database.RawDB(r.db)
	if rawDB == nil {
		return nil, fmt.Errorf("email campaign publish requires transactional database")
	}
	var published *models.EmailCampaign
	err := database.WithTx(ctx, rawDB, func(tx *sql.Tx) error {
		// Acquire the draft's write lock before reading it. The conditional
		// no-op update serializes SQLite and PostgreSQL publishers, so a second
		// request sees the committed published result instead of racing its
		// eligibility snapshot.
		if _, err := tx.ExecContext(ctx, `UPDATE email_campaigns SET status=status
			WHERE id=? AND status='draft' AND expires_at>?`, id, emailCampaignTimeDB(now)); err != nil {
			return err
		}
		var c models.EmailCampaign
		var expiresRaw, createdRaw string
		var publishedBy, publishedAt sql.NullString
		if err := tx.QueryRowContext(ctx, `SELECT id,category,subject,body_text,status,CAST(expires_at AS TEXT),created_by,
			CAST(created_at AS TEXT),published_by,CAST(published_at AS TEXT),recipient_count
			FROM email_campaigns WHERE id=?`, id).Scan(&c.ID, &c.Category, &c.Subject, &c.Body, &c.Status, &expiresRaw,
			&c.CreatedBy, &createdRaw, &publishedBy, &publishedAt, &c.RecipientCount); err != nil {
			if err == sql.ErrNoRows {
				return ErrEmailCampaignNotFound
			}
			return err
		}
		c.ExpiresAt = emailCampaignTimeAPI(expiresRaw)
		c.CreatedAt = emailCampaignTimeAPI(createdRaw)
		if publishedBy.Valid {
			c.PublishedBy = &publishedBy.String
		}
		if publishedAt.Valid {
			value := emailCampaignTimeAPI(publishedAt.String)
			c.PublishedAt = &value
		}
		if c.Status == "published" {
			published = &c
			return nil
		}
		if c.Status != "draft" || !campaignNotExpired(expiresRaw, now) {
			return ErrEmailCampaignExpired
		}
		recipients, err := r.eligibleRecipients(ctx, tx, c.Category)
		if err != nil {
			return err
		}
		// The conditional transition serializes publishers. Content and recipient
		// count become immutable in the same write; the transaction rolls back
		// this transition if any queue insert below fails.
		result, err := tx.ExecContext(ctx, `UPDATE email_campaigns SET status='published',published_by=?,published_at=?,recipient_count=?
			WHERE id=? AND status='draft' AND expires_at>?`, adminID, emailCampaignTimeDB(now), len(recipients), id, emailCampaignTimeDB(now))
		if err != nil {
			return err
		}
		changed, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if changed == 0 {
			// A concurrent publisher may have committed while this UPDATE waited
			// on the draft row. Return the existing immutable result idempotently.
			var status string
			var publishedBy, publishedAt sql.NullString
			if err := tx.QueryRowContext(ctx, `SELECT status,published_by,CAST(published_at AS TEXT),recipient_count
				FROM email_campaigns WHERE id=?`, id).Scan(&status, &publishedBy, &publishedAt, &c.RecipientCount); err != nil {
				return err
			}
			if status != "published" || !publishedAt.Valid {
				return ErrEmailCampaignExpired
			}
			c.Status = status
			if publishedBy.Valid {
				c.PublishedBy = &publishedBy.String
			}
			value := emailCampaignTimeAPI(publishedAt.String)
			c.PublishedAt = &value
			published = &c
			return nil
		}
		bodyHTML := models.RenderEmailCampaignBody(c.Body)
		for _, recipient := range recipients {
			jobID, err := generateID()
			if err != nil {
				return err
			}
			_, err = tx.ExecContext(ctx, `INSERT INTO email_delivery_jobs
				(id,user_id,category,dedupe_key,subject,body_html,expires_at)
				VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,category,dedupe_key) DO NOTHING`,
				jobID, recipient.id, c.Category, "campaign:"+c.ID, c.Subject, bodyHTML, emailCampaignTimeDB(expiresRaw))
			if err != nil {
				return err
			}
		}
		c.Status = "published"
		c.PublishedBy = &adminID
		publishedAtValue := emailCampaignTimeAPI(emailCampaignTimeDB(now))
		c.PublishedAt = &publishedAtValue
		c.RecipientCount = len(recipients)
		published = &c
		return nil
	})
	if err != nil {
		return nil, err
	}
	// Re-read after commit for idempotent concurrent/repeated publish callers.
	if published == nil || published.PublishedAt == nil {
		return r.Get(ctx, id)
	}
	return published, nil
}

func campaignNotExpired(raw string, now time.Time) bool {
	parsed, err := parseEmailCampaignTime(raw)
	return err == nil && parsed.After(now.UTC())
}

func emailCampaignTimeDB(value any) string {
	switch typed := value.(type) {
	case time.Time:
		return typed.UTC().Format("2006-01-02 15:04:05.000000000")
	case string:
		if t, err := parseEmailCampaignTime(typed); err == nil {
			return t.UTC().Format("2006-01-02 15:04:05.000000000")
		}
	}
	return ""
}

func emailCampaignTimeAPI(raw string) string {
	parsed, err := parseEmailCampaignTime(raw)
	if err == nil {
		return parsed.UTC().Format(time.RFC3339Nano)
	}
	return ""
}

func parseEmailCampaignTime(raw string) (time.Time, error) {
	for _, layout := range []string{"2006-01-02 15:04:05.999999999", time.RFC3339Nano,
		"2006-01-02 15:04:05.999999999-07:00", "2006-01-02 15:04:05.999999999-07",
		"2006-01-02 15:04:05-07:00", "2006-01-02 15:04:05-07", "2006-01-02 15:04:05"} {
		if parsed, err := time.Parse(layout, raw); err == nil {
			return parsed.UTC(), nil
		}
	}
	return time.Time{}, fmt.Errorf("invalid email campaign timestamp")
}

var _ EmailCampaignRepository = (*sqliteEmailCampaignRepo)(nil)
