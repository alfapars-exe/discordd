package repository

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
)

func TestEmailCampaignPreviewPublishIsEligibleAtomicAndIdempotent(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()
	repo := NewSQLiteEmailCampaignRepo(db.Conn)
	now := time.Now().UTC().Truncate(time.Second)
	execSeed(t, db, []seedStmt{
		{q: `INSERT INTO users(id,username,password_hash,email,email_verified_at) VALUES
			('eligible','eligible','x','eligible@example.test',1),
			('opted-out','opted-out','x','out@example.test',1),
			('unverified','unverified','x','unverified@example.test',NULL)`},
		{q: `INSERT INTO user_preferences(user_id,data) VALUES('opted-out','{"email_preferences":{"announcements":false}}')`},
	})
	campaign := &models.EmailCampaign{
		ID: "ec_0123456789abcdef0123456789abcdef", Category: models.EmailCampaignCategoryAnnouncements,
		Subject: "A <safe> update", Body: "Hello <script>alert(1)</script>\nhttps://example.test",
		ExpiresAt: now.Add(24 * time.Hour).Format(time.RFC3339Nano), CreatedBy: "platform-admin", CreatedAt: now.Format(time.RFC3339Nano),
	}
	if err := repo.CreateDraft(ctx, campaign); err != nil {
		t.Fatal(err)
	}
	count, err := repo.CountEligible(ctx, campaign.Category)
	if err != nil || count != 1 {
		t.Fatalf("preview count=%d err=%v, want one eligible recipient", count, err)
	}
	published, err := repo.Publish(ctx, campaign.ID, "platform-admin", now.Add(time.Minute))
	if err != nil || published.Status != "published" || published.RecipientCount != 1 || published.PublishedBy == nil || *published.PublishedBy != "platform-admin" || published.PublishedAt == nil || published.CreatedAt != campaign.CreatedAt {
		t.Fatalf("publish result=%+v err=%v", published, err)
	}
	var body, dedupe, expiry string
	if err := db.Conn.QueryRowContext(ctx, `SELECT body_html,dedupe_key,CAST(expires_at AS TEXT) FROM email_delivery_jobs WHERE user_id='eligible'`).Scan(&body, &dedupe, &expiry); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(body, "<script>") || !strings.Contains(body, "&lt;script&gt;") || strings.Contains(body, "href=") || dedupe != "campaign:"+campaign.ID || expiry == "" {
		t.Fatalf("unsafe/mis-keyed campaign job: body=%q dedupe=%q expiry=%q", body, dedupe, expiry)
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM email_delivery_jobs WHERE category='announcements'`); got != 1 {
		t.Fatalf("queued job count=%d, want 1", got)
	}
	second, err := repo.Publish(ctx, campaign.ID, "different-admin", now.Add(2*time.Minute))
	if err != nil || second.RecipientCount != published.RecipientCount || second.PublishedBy == nil || *second.PublishedBy != *published.PublishedBy || second.PublishedAt == nil || *second.PublishedAt != *published.PublishedAt || second.CreatedAt != published.CreatedAt {
		t.Fatalf("repeat publish=%+v err=%v", second, err)
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM email_delivery_jobs WHERE category='announcements'`); got != 1 {
		t.Fatalf("repeat publish created duplicate jobs: %d", got)
	}
	if _, err := db.Conn.ExecContext(ctx, `UPDATE email_campaigns SET subject='changed' WHERE id=?`, campaign.ID); err == nil {
		t.Fatal("published campaign must be immutable")
	}
}

func TestEmailCampaignExpiredJobsNeverClaimAndCannotPassDeliveryEligibility(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()
	repo := NewSQLiteEmailCampaignRepo(db.Conn)
	queue := NewSQLiteEmailDeliveryRepo(db.Conn)
	now := time.Now().UTC().Truncate(time.Second)
	execSeed(t, db, []seedStmt{{q: `INSERT INTO users(id,username,password_hash,email,email_verified_at) VALUES('eligible','eligible','x','eligible@example.test',1)`}})
	campaign := &models.EmailCampaign{ID: "ec_0123456789abcdef0123456789abcdef", Category: models.EmailCampaignCategoryTips,
		Subject: "Tip", Body: "Use HiChat", ExpiresAt: now.Add(time.Hour).Format(time.RFC3339Nano), CreatedBy: "admin", CreatedAt: now.Format(time.RFC3339Nano)}
	if err := repo.CreateDraft(ctx, campaign); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.Publish(ctx, campaign.ID, "admin", now); err != nil {
		t.Fatal(err)
	}
	claimed, err := queue.ClaimDue(ctx, now.Add(time.Minute), 10)
	if err != nil || len(claimed) != 1 {
		t.Fatalf("pre-expiry claim=%+v err=%v", claimed, err)
	}
	allowed, err := queue.CanDeliver(ctx, &claimed[0], now.Add(2*time.Hour))
	if err != nil || allowed {
		t.Fatalf("expired claimed job eligible=%v err=%v", allowed, err)
	}
	expired, err := queue.ClaimDue(ctx, now.Add(2*time.Hour), 10)
	if err != nil || len(expired) != 0 {
		t.Fatalf("post-expiry claims=%+v err=%v", expired, err)
	}
	var status string
	if err := db.Conn.QueryRowContext(ctx, `SELECT status FROM email_delivery_jobs`).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "cancelled" {
		t.Fatalf("expired job status=%q, want cancelled", status)
	}
}

func TestEmailCampaignPublishRollsBackCampaignAndJobsOnQueueFailure(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()
	repo := NewSQLiteEmailCampaignRepo(db.Conn)
	now := time.Now().UTC().Truncate(time.Second)
	execSeed(t, db, []seedStmt{
		{q: `INSERT INTO users(id,username,password_hash,email,email_verified_at) VALUES('eligible','eligible','x','eligible@example.test',1)`},
		{q: `INSERT INTO user_preferences(user_id,data) VALUES('eligible','{"privacy":{"experiencePersonalization":true}}')`},
	})
	campaign := &models.EmailCampaign{ID: "ec_0123456789abcdef0123456789abcdef", Category: models.EmailCampaignCategoryRecommendations,
		Subject: "A community", Body: "Try a community", ExpiresAt: now.Add(time.Hour).Format(time.RFC3339Nano), CreatedBy: "admin", CreatedAt: now.Format(time.RFC3339Nano)}
	if err := repo.CreateDraft(ctx, campaign); err != nil {
		t.Fatal(err)
	}
	if database.IsPostgres(db.Conn) {
		if _, err := db.Conn.ExecContext(ctx, `CREATE FUNCTION reject_campaign_job_for_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$`); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Conn.ExecContext(ctx, `CREATE TRIGGER reject_campaign_jobs BEFORE INSERT ON email_delivery_jobs FOR EACH ROW EXECUTE FUNCTION reject_campaign_job_for_test()`); err != nil {
			t.Fatal(err)
		}
	} else if _, err := db.Conn.ExecContext(ctx, `CREATE TRIGGER reject_campaign_jobs BEFORE INSERT ON email_delivery_jobs BEGIN SELECT RAISE(ABORT,'test failure'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.Publish(ctx, campaign.ID, "admin", now); err == nil {
		t.Fatal("publish should fail when queue insert fails")
	}
	got, err := repo.Get(ctx, campaign.ID)
	if err != nil || got.Status != "draft" {
		t.Fatalf("campaign after rollback=%+v err=%v, want draft", got, err)
	}
	if count := countRows(t, db, `SELECT COUNT(*) FROM email_delivery_jobs`); count != 0 {
		t.Fatalf("jobs after rollback=%d, want none", count)
	}
	if database.IsPostgres(db.Conn) {
		if _, err := db.Conn.ExecContext(ctx, `DROP TRIGGER reject_campaign_jobs ON email_delivery_jobs`); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Conn.ExecContext(ctx, `DROP FUNCTION reject_campaign_job_for_test()`); err != nil {
			t.Fatal(err)
		}
	} else if _, err := db.Conn.ExecContext(ctx, `DROP TRIGGER reject_campaign_jobs`); err != nil {
		t.Fatal(err)
	}
	if published, err := repo.Publish(ctx, campaign.ID, "admin", now); err != nil || published.Status != "published" {
		t.Fatalf("retry publish=%+v err=%v", published, err)
	}
}

func TestEmailCampaignExpiredDraftCannotPublish(t *testing.T) {
	db := newTestDB(t)
	repo := NewSQLiteEmailCampaignRepo(db.Conn)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	campaign := &models.EmailCampaign{ID: "ec_0123456789abcdef0123456789abcdef", Category: models.EmailCampaignCategoryTips,
		Subject: "Tip", Body: "Body", ExpiresAt: now.Add(time.Hour).Format(time.RFC3339Nano), CreatedBy: "admin", CreatedAt: now.Format(time.RFC3339Nano)}
	if err := repo.CreateDraft(ctx, campaign); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.Publish(ctx, campaign.ID, "admin", now.Add(2*time.Hour)); !errors.Is(err, ErrEmailCampaignExpired) {
		t.Fatalf("expired publish error=%v", err)
	}
	got, err := repo.Get(ctx, campaign.ID)
	if err != nil || got.Status != "draft" {
		t.Fatalf("expired campaign=%+v err=%v", got, err)
	}
}

func TestRecommendationCampaignAudienceRequiresPersonalizationConsent(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()
	repo := NewSQLiteEmailCampaignRepo(db.Conn)
	now := time.Now().UTC().Truncate(time.Second)
	execSeed(t, db, []seedStmt{
		{q: `INSERT INTO users(id,username,password_hash,email,email_verified_at) VALUES
			('personalized','personalized','x','yes@example.test',1),
			('no-consent','no-consent','x','no@example.test',1)`},
		{q: `INSERT INTO user_preferences(user_id,data) VALUES
			('personalized','{"email_preferences":{"recommendations":true},"privacy":{"experiencePersonalization":true}}'),
			('no-consent','{"email_preferences":{"recommendations":true},"privacy":{"experiencePersonalization":false}}')`},
	})
	campaign := &models.EmailCampaign{ID: "ec_0123456789abcdef0123456789abcdef", Category: models.EmailCampaignCategoryRecommendations,
		Subject: "A community", Body: "Try a community", ExpiresAt: now.Add(time.Hour).Format(time.RFC3339Nano), CreatedBy: "admin", CreatedAt: now.Format(time.RFC3339Nano)}
	if err := repo.CreateDraft(ctx, campaign); err != nil {
		t.Fatal(err)
	}
	count, err := repo.CountEligible(ctx, campaign.Category)
	if err != nil || count != 1 {
		t.Fatalf("recommendations preview count=%d err=%v, want only consented account", count, err)
	}
	if _, err := repo.Publish(ctx, campaign.ID, "admin", now); err != nil {
		t.Fatal(err)
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM email_delivery_jobs WHERE category='recommendations'`); got != 1 {
		t.Fatalf("recommendations queued jobs=%d, want only consented account", got)
	}
}
