package repository

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
)

func TestEmailDeliveryRequiresVerifiedOptedInAddressAndRetries(t *testing.T) {
	db := newTestDB(t)
	repo := NewSQLiteEmailDeliveryRepo(db.Conn)
	ctx := context.Background()
	execSeed(t, db, []seedStmt{
		{q: `INSERT INTO users(id,username,password_hash,email,email_verified_at) VALUES('yes','yes','x','yes@example.test',1),('no','no','x','no@example.test',NULL),('out','out','x','out@example.test',1)`},
		{q: `INSERT INTO user_preferences(user_id,data) VALUES('out','{"email_preferences":{"social":false}}')`},
	})
	job := func(user string) *models.EmailDeliveryJob {
		return &models.EmailDeliveryJob{UserID: user, Category: models.EmailCategorySocial, DedupeKey: "friend-1", Subject: "Friend update", BodyHTML: "<p>Safe body</p>"}
	}
	if ok, err := repo.EnqueueIfEligible(ctx, job("no")); err != nil || ok {
		t.Fatalf("unverified enqueue = %v, %v", ok, err)
	}
	if ok, err := repo.EnqueueIfEligible(ctx, job("out")); err != nil || ok {
		t.Fatalf("opted-out enqueue = %v, %v", ok, err)
	}
	queued := job("yes")
	if ok, err := repo.EnqueueIfEligible(ctx, queued); err != nil || !ok {
		t.Fatalf("verified enqueue = %v, %v", ok, err)
	}
	if ok, err := repo.EnqueueIfEligible(ctx, job("yes")); err != nil || ok {
		t.Fatalf("duplicate enqueue = %v, %v", ok, err)
	}
	jobs, err := repo.ClaimDue(ctx, time.Now().Add(time.Minute), 10)
	if err != nil || len(jobs) != 1 || jobs[0].Address != "yes@example.test" {
		t.Fatalf("claim = %#v, %v", jobs, err)
	}
	if err = repo.Retry(ctx, jobs[0].ID, jobs[0].ClaimToken, "temporary", time.Now().Add(-time.Minute), 5); err != nil {
		t.Fatal(err)
	}
	jobs, err = repo.ClaimDue(ctx, time.Now(), 10)
	if err != nil || len(jobs) != 1 {
		t.Fatalf("reclaim = %#v, %v", jobs, err)
	}
	if err = repo.MarkDelivered(ctx, jobs[0].ID, jobs[0].ClaimToken, time.Now()); err != nil {
		t.Fatal(err)
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM email_delivery_jobs WHERE status='delivered'`); got != 1 {
		t.Fatalf("delivered=%d", got)
	}
}

func TestCommunicationEmailWaitsAndRechecksExactDMStillUnreadAndAccepted(t *testing.T) {
	db := newTestDB(t)
	repo := NewSQLiteEmailDeliveryRepo(db.Conn)
	ctx := context.Background()
	execSeed(t, db, []seedStmt{
		{q: `INSERT INTO users(id,username,password_hash,email,email_verified_at) VALUES('alice','alice','x','alice@example.test',1),('bob','bob','x','bob@example.test',1)`},
		{q: `INSERT INTO dm_channels(id,user1_id,user2_id,status) VALUES('dm-1','alice','bob','accepted')`},
		{q: `INSERT INTO dm_messages(id,dm_channel_id,user_id,content) VALUES('msg-1','dm-1','alice','never-read-by-this-check')`},
		{q: `INSERT INTO dm_reads(user_id,dm_channel_id,last_read_message_id,unread_count) VALUES('bob','dm-1',NULL,1)`},
	})
	now := time.Now().UTC().Truncate(time.Second)
	job := &models.EmailDeliveryJob{UserID: "bob", Category: models.EmailCategoryCommunication, DedupeKey: "unread-dm:msg-1", Subject: "Unread message", BodyHTML: "<p>Generic</p>", NotBefore: now.Add(10 * time.Minute).Format(time.RFC3339Nano), ExpiresAt: now.Add(24 * time.Hour).Format(time.RFC3339Nano), DMMessageID: "msg-1"}
	if queued, err := repo.EnqueueIfEligible(ctx, job); err != nil || !queued {
		t.Fatalf("enqueue=(%v,%v)", queued, err)
	}
	if due, err := repo.ClaimDue(ctx, now.Add(9*time.Minute), 10); err != nil || len(due) != 0 {
		t.Fatalf("early claim=%+v err=%v", due, err)
	}
	due, err := repo.ClaimDue(ctx, now.Add(11*time.Minute), 10)
	if err != nil || len(due) != 1 || due[0].DMMessageID != "msg-1" {
		t.Fatalf("due claim=%+v err=%v", due, err)
	}
	if allowed, err := repo.CanDeliver(ctx, &due[0], now.Add(11*time.Minute)); err != nil || !allowed {
		t.Fatalf("unread eligibility=(%v,%v), want allowed", allowed, err)
	}
	if _, err := db.Conn.ExecContext(ctx, `UPDATE dm_reads SET unread_count=0 WHERE user_id='bob' AND dm_channel_id='dm-1'`); err != nil {
		t.Fatal(err)
	}
	if allowed, err := repo.CanDeliver(ctx, &due[0], now.Add(12*time.Minute)); err != nil || allowed {
		t.Fatalf("read message eligibility=(%v,%v), want suppressed", allowed, err)
	}
	if _, err := db.Conn.ExecContext(ctx, `UPDATE dm_reads SET unread_count=1 WHERE user_id='bob' AND dm_channel_id='dm-1'`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.ExecContext(ctx, `INSERT INTO friendships(id,user_id,friend_id,status) VALUES('block','bob','alice','blocked')`); err != nil {
		t.Fatal(err)
	}
	if allowed, err := repo.CanDeliver(ctx, &due[0], now.Add(12*time.Minute)); err != nil || allowed {
		t.Fatalf("blocked DM eligibility=(%v,%v), want suppressed", allowed, err)
	}
	if _, err := db.Conn.ExecContext(ctx, `DELETE FROM friendships WHERE id='block'; UPDATE dm_channels SET status='pending' WHERE id='dm-1'`); err != nil {
		t.Fatal(err)
	}
	if allowed, err := repo.CanDeliver(ctx, &due[0], now.Add(12*time.Minute)); err != nil || allowed {
		t.Fatalf("pending DM eligibility=(%v,%v), want suppressed", allowed, err)
	}
	if allowed, err := repo.CanDeliver(ctx, &due[0], now.Add(25*time.Hour)); err != nil || allowed {
		t.Fatalf("expired DM eligibility=(%v,%v), want suppressed", allowed, err)
	}
}

func TestCommunicationEmailCoalescesConversationWithoutSuppressingOtherConversations(t *testing.T) {
	db := newTestDB(t)
	repo := NewSQLiteEmailDeliveryRepo(db.Conn)
	ctx := context.Background()
	execSeed(t, db, []seedStmt{
		{q: `INSERT INTO users(id,username,password_hash,email,email_verified_at) VALUES('alice','alice','x','alice@example.test',1),('bob','bob','x','bob@example.test',1),('carol','carol','x','carol@example.test',1)`},
		{q: `INSERT INTO dm_channels(id,user1_id,user2_id,status) VALUES('dm-1','alice','bob','accepted'),('dm-2','carol','bob','accepted')`},
		{q: `INSERT INTO dm_messages(id,dm_channel_id,user_id,content,created_at) VALUES('msg-1','dm-1','alice','private first','2026-10-24 01:00:00'),('msg-2','dm-1','alice','private second','2026-10-24 01:01:00'),('msg-3','dm-2','carol','private other','2026-10-24 01:02:00')`},
		{q: `INSERT INTO dm_reads(user_id,dm_channel_id,last_read_message_id,unread_count) VALUES('bob','dm-1',NULL,2),('bob','dm-2',NULL,1)`},
	})
	now := time.Now().UTC()
	jobs := make([]*models.EmailDeliveryJob, 3)
	for index, id := range []string{"msg-1", "msg-2", "msg-3"} {
		job := &models.EmailDeliveryJob{UserID: "bob", Category: models.EmailCategoryCommunication, DedupeKey: "unread-dm:" + id, Subject: "Generic", BodyHTML: "<p>Generic</p>", DMMessageID: id, ExpiresAt: now.Add(time.Hour).Format(time.RFC3339Nano)}
		if queued, err := repo.EnqueueIfEligible(ctx, job); err != nil || !queued {
			t.Fatalf("enqueue %s = %v,%v", id, queued, err)
		}
		job.Address = "bob@example.test"
		jobs[index] = job
	}
	if allowed, err := repo.CanDeliver(ctx, jobs[0], now); err != nil || allowed {
		t.Fatalf("older duplicate allowed=%v err=%v", allowed, err)
	}
	if allowed, err := repo.CanDeliver(ctx, jobs[1], now); err != nil || !allowed || jobs[1].DMUnreadCount != 2 {
		t.Fatalf("summary allowed=%v count=%d err=%v", allowed, jobs[1].DMUnreadCount, err)
	}
	if allowed, err := repo.CanDeliver(ctx, jobs[2], now); err != nil || !allowed || jobs[2].DMUnreadCount != 1 {
		t.Fatalf("other conversation allowed=%v count=%d err=%v", allowed, jobs[2].DMUnreadCount, err)
	}
	// Even if a newer summary is acknowledged first, an older lease must not
	// later send a duplicate summary from the same conversation.
	if _, err := db.Conn.ExecContext(ctx, `UPDATE email_delivery_jobs SET status='delivered' WHERE id=?`, jobs[1].ID); err != nil {
		t.Fatal(err)
	}
	if allowed, err := repo.CanDeliver(ctx, jobs[0], now); err != nil || allowed {
		t.Fatalf("older after delivered summary=%v,%v", allowed, err)
	}
	if _, err := db.Conn.ExecContext(ctx, `UPDATE dm_reads SET last_read_message_id='msg-2',unread_count=0 WHERE user_id='bob' AND dm_channel_id='dm-1'`); err != nil {
		t.Fatal(err)
	}
	if allowed, err := repo.CanDeliver(ctx, jobs[1], now); err != nil || allowed || jobs[1].DMUnreadCount != 0 {
		t.Fatalf("read summary=%v count=%d err=%v", allowed, jobs[1].DMUnreadCount, err)
	}
}

func TestSocialFriendshipEmailRechecksCurrentRequestOrAcceptedState(t *testing.T) {
	db := newTestDB(t)
	repo := NewSQLiteEmailDeliveryRepo(db.Conn)
	ctx := context.Background()
	execSeed(t, db, []seedStmt{
		{q: `INSERT INTO users(id,username,password_hash,email,email_verified_at) VALUES('alice','alice','x','alice@example.test',1),('bob','bob','x','bob@example.test',1)`},
		{q: `INSERT INTO friendships(id,user_id,friend_id,status) VALUES('friendship-1','alice','bob','pending')`},
	})
	request := &models.EmailDeliveryJob{UserID: "bob", Category: models.EmailCategorySocial, DedupeKey: "friend-request:friendship-1", Subject: "New friend request", BodyHTML: "<p>Generic</p>", FriendshipID: "friendship-1", FriendshipEvent: "request"}
	accepted := &models.EmailDeliveryJob{UserID: "alice", Category: models.EmailCategorySocial, DedupeKey: "friend-accepted:friendship-1", Subject: "Friend request accepted", BodyHTML: "<p>Generic</p>", FriendshipID: "friendship-1", FriendshipEvent: "accepted"}
	if queued, err := repo.EnqueueIfEligible(ctx, request); err != nil || !queued {
		t.Fatalf("request enqueue=(%v,%v)", queued, err)
	}
	if queued, err := repo.EnqueueIfEligible(ctx, accepted); err != nil || !queued {
		t.Fatalf("accepted enqueue=(%v,%v)", queued, err)
	}
	now := time.Now().UTC()
	request.Address = "bob@example.test"
	if allowed, err := repo.CanDeliver(ctx, request, now); err != nil || !allowed {
		t.Fatalf("pending request eligibility=(%v,%v), want allowed", allowed, err)
	}
	accepted.Address = "alice@example.test"
	if allowed, err := repo.CanDeliver(ctx, accepted, now); err != nil || allowed {
		t.Fatalf("premature acceptance eligibility=(%v,%v), want suppressed", allowed, err)
	}
	if _, err := db.Conn.ExecContext(ctx, `UPDATE friendships SET status='accepted' WHERE id='friendship-1'`); err != nil {
		t.Fatal(err)
	}
	if allowed, err := repo.CanDeliver(ctx, request, now); err != nil || allowed {
		t.Fatalf("resolved request eligibility=(%v,%v), want suppressed", allowed, err)
	}
	if allowed, err := repo.CanDeliver(ctx, accepted, now); err != nil || !allowed {
		t.Fatalf("accepted friendship eligibility=(%v,%v), want allowed", allowed, err)
	}
	if _, err := db.Conn.ExecContext(ctx, `INSERT INTO friendships(id,user_id,friend_id,status) VALUES('reverse-block','bob','alice','blocked')`); err != nil {
		t.Fatal(err)
	}
	if allowed, err := repo.CanDeliver(ctx, accepted, now); err != nil || allowed {
		t.Fatalf("blocked accepted friendship eligibility=(%v,%v), want suppressed", allowed, err)
	}
	if _, err := db.Conn.ExecContext(ctx, `DELETE FROM friendships WHERE id='friendship-1'`); err != nil {
		t.Fatal(err)
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM email_delivery_jobs WHERE friendship_id='friendship-1'`); got != 0 {
		t.Fatalf("deleted friendship left %d queued event jobs", got)
	}
}

func TestEmailDeliveryLeaseRecoveryFencesStaleWorkersAndBoundsCrashes(t *testing.T) {
	db := newTestDB(t)
	repo := NewSQLiteEmailDeliveryRepo(db.Conn)
	ctx := context.Background()
	execSeed(t, db, []seedStmt{{q: `INSERT INTO users(id,username,password_hash,email,email_verified_at) VALUES('lease','lease','x','lease@example.test',1)`}})
	queued := &models.EmailDeliveryJob{UserID: "lease", Category: models.EmailCategorySocial, DedupeKey: "lease-test", Subject: "subject", BodyHTML: "<p>body</p>"}
	if ok, err := repo.EnqueueIfEligible(ctx, queued); err != nil || !ok {
		t.Fatalf("enqueue = %v, %v", ok, err)
	}
	firstAt := time.Now().UTC().Truncate(time.Second)
	if _, err := db.Conn.ExecContext(ctx, `UPDATE email_delivery_jobs SET next_attempt_at=? WHERE id=?`, emailTime(firstAt), queued.ID); err != nil {
		t.Fatalf("make lease test job due: %v", err)
	}
	first, err := repo.ClaimDue(ctx, firstAt, 1)
	if err != nil || len(first) != 1 || first[0].ClaimToken == "" || first[0].Attempts != 1 {
		t.Fatalf("first claim = %#v, %v", first, err)
	}
	if first[0].ClaimToken == queued.ClaimToken {
		t.Fatal("claim token should not be present on the enqueued job")
	}
	// Simulate a process crash by advancing past the lease expiry.
	secondAt := firstAt.Add(emailDeliveryLease + time.Second)
	second, err := repo.ClaimDue(ctx, secondAt, 1)
	if err != nil || len(second) != 1 || second[0].ClaimToken == first[0].ClaimToken || second[0].Attempts != 2 {
		t.Fatalf("reclaimed job = %#v, %v", second, err)
	}
	if err = repo.MarkDelivered(ctx, first[0].ID, first[0].ClaimToken, secondAt); !errors.Is(err, ErrStaleEmailDeliveryClaim) {
		t.Fatalf("stale completion error = %v", err)
	}
	if err = repo.Retry(ctx, first[0].ID, first[0].ClaimToken, "stale failure", secondAt.Add(time.Minute), 5); !errors.Is(err, ErrStaleEmailDeliveryClaim) {
		t.Fatalf("stale retry error = %v", err)
	}
	var status, token string
	var attempts int
	if err = db.Conn.QueryRowContext(ctx, `SELECT status,claim_token,attempts FROM email_delivery_jobs WHERE id=?`, first[0].ID).Scan(&status, &token, &attempts); err != nil {
		t.Fatal(err)
	}
	if status != "delivering" || token != second[0].ClaimToken || attempts != 2 {
		t.Fatalf("stale worker changed current claim: status=%s token=%s attempts=%d", status, token, attempts)
	}
	if err = repo.MarkDelivered(ctx, second[0].ID, second[0].ClaimToken, secondAt.Add(time.Minute)); err != nil {
		t.Fatalf("current completion: %v", err)
	}

	// An old pre-migration delivering row with no lease is recovered and
	// eventually canceled once its fifth claim expires.
	legacy := &models.EmailDeliveryJob{UserID: "lease", Category: models.EmailCategorySocial, DedupeKey: "legacy-lease", Subject: "subject", BodyHTML: "<p>body</p>"}
	if ok, err := repo.EnqueueIfEligible(ctx, legacy); err != nil || !ok {
		t.Fatalf("legacy enqueue = %v, %v", ok, err)
	}
	if _, err = db.Conn.ExecContext(ctx, `UPDATE email_delivery_jobs SET status='delivering',attempts=4,claim_token=NULL,lease_expires_at=NULL,next_attempt_at=? WHERE id=?`, emailTime(firstAt), legacy.ID); err != nil {
		t.Fatal(err)
	}
	fifth, err := repo.ClaimDue(ctx, firstAt, 1)
	if err != nil || len(fifth) != 1 || fifth[0].ID != legacy.ID || fifth[0].Attempts != 5 {
		t.Fatalf("legacy fifth claim = %#v, %v", fifth, err)
	}
	if _, err = repo.ClaimDue(ctx, firstAt.Add(emailDeliveryLease+time.Second), 1); err != nil {
		t.Fatal(err)
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM email_delivery_jobs WHERE id=? AND status='cancelled' AND attempts=5`, legacy.ID); got != 1 {
		t.Fatalf("expired fifth claim not terminally canceled: rows=%d", got)
	}
}

func TestEmailDeliveryFailsClosedForMalformedConsentAndIneligibleAccounts(t *testing.T) {
	db := newTestDB(t)
	repo := NewSQLiteEmailDeliveryRepo(db.Conn)
	ctx := context.Background()
	execSeed(t, db, []seedStmt{
		{q: `INSERT INTO users(id,username,password_hash,email,email_verified_at,is_bot,owner_user_id) VALUES
			('eligible','eligible','x','eligible@example.test',1,0,NULL),
			('partial-preferences','partial-preferences','x','partial@example.test',1,0,NULL),
			('bot','bot','!disabled!','bot@example.test',1,1,'eligible'),
			('disabled','disabled','x','disabled@example.test',1,0,NULL),
			('deleted','deleted','x','deleted@example.test',1,0,NULL),
			('opted-out','opted-out','x','out@example.test',1,0,NULL),
			('malformed-json','malformed-json','x','bad-json@example.test',1,0,NULL),
			('wrong-root','wrong-root','x','bad-root@example.test',1,0,NULL),
			('wrong-namespace','wrong-namespace','x','bad-namespace@example.test',1,0,NULL),
			('wrong-category','wrong-category','x','bad-category@example.test',1,0,NULL),
			('wrong-global','wrong-global','x','bad-global@example.test',1,0,NULL)`},
		{q: `INSERT INTO user_preferences(user_id,data) VALUES
			('partial-preferences','{"email_preferences":{"communication":false}}'),
			('opted-out','{"email_preferences":{"marketingUnsubscribed":true}}'),
			('malformed-json','not-json'),
			('wrong-root','[]'),
			('wrong-namespace','{"email_preferences":[]}'),
			('wrong-category','{"email_preferences":{"social":"true"}}'),
			('wrong-global','{"email_preferences":{"marketingUnsubscribed":null}}')`},
		{q: `INSERT INTO account_lifecycle(user_id,disabled_at) VALUES('disabled',100)`},
		{q: `UPDATE users SET deleted_at=100 WHERE id='deleted'`},
	})
	job := func(user string) *models.EmailDeliveryJob {
		return &models.EmailDeliveryJob{UserID: user, Category: models.EmailCategorySocial, DedupeKey: "friend-1", Subject: "Friend update", BodyHTML: "<p>Safe body</p>"}
	}
	blocked := []string{"bot", "disabled", "deleted", "opted-out", "malformed-json", "wrong-root", "wrong-namespace", "wrong-category", "wrong-global"}
	for _, user := range blocked {
		t.Run(user, func(t *testing.T) {
			if queued, err := repo.EnqueueIfEligible(ctx, job(user)); err != nil || queued {
				t.Fatalf("enqueue = %v, %v; want blocked", queued, err)
			}
			if allowed, err := repo.CanDeliver(ctx, &models.EmailDeliveryJob{UserID: user, Category: models.EmailCategorySocial, Address: user + "@example.test"}, time.Now()); err != nil || allowed {
				t.Fatalf("CanDeliver = %v, %v; want blocked", allowed, err)
			}
		})
	}
	if allowed, err := repo.CanDeliver(ctx, &models.EmailDeliveryJob{UserID: "eligible", Category: models.EmailCategorySocial, Address: "eligible@example.test"}, time.Now()); err != nil || !allowed {
		t.Fatalf("missing category preference should remain enabled by default: %v, %v", allowed, err)
	}
	if queued, err := repo.EnqueueIfEligible(ctx, job("eligible")); err != nil || !queued {
		t.Fatalf("default-enabled enqueue = %v, %v", queued, err)
	}
	if allowed, err := repo.CanDeliver(ctx, &models.EmailDeliveryJob{UserID: "partial-preferences", Category: models.EmailCategorySocial, Address: "partial@example.test"}, time.Now()); err != nil || !allowed {
		t.Fatalf("missing category setting should remain enabled by default: %v, %v", allowed, err)
	}
	if queued, err := repo.EnqueueIfEligible(ctx, job("partial-preferences")); err != nil || !queued {
		t.Fatalf("missing category setting enqueue = %v, %v", queued, err)
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM email_delivery_jobs`); got != 2 {
		t.Fatalf("ineligible accounts queued jobs: got %d jobs, want only the two eligible accounts", got)
	}
}

func TestRecommendationsEmailRequiresPersonalizationConsentAtEnqueueAndDelivery(t *testing.T) {
	db := newTestDB(t)
	repo := NewSQLiteEmailDeliveryRepo(db.Conn)
	ctx := context.Background()
	execSeed(t, db, []seedStmt{
		{q: `INSERT INTO users(id,username,password_hash,email,email_verified_at) VALUES
			('consent-off','consent-off','x','off@example.test',1),
			('consent-missing','consent-missing','x','missing@example.test',1),
			('no-preferences-row','no-preferences-row','x','no-row@example.test',1),
			('consent-malformed','consent-malformed','x','malformed@example.test',1),
			('consent-on','consent-on','x','on@example.test',1),
			('category-default','category-default','x','default@example.test',1)`},
		{q: `INSERT INTO user_preferences(user_id,data) VALUES
			('consent-off','{"email_preferences":{"recommendations":true},"privacy":{"experiencePersonalization":false}}'),
			('consent-missing','{"email_preferences":{"recommendations":true}}'),
			('consent-malformed','{"email_preferences":{"recommendations":true},"privacy":{"experiencePersonalization":"true"}}'),
			('consent-on','{"email_preferences":{"recommendations":true},"privacy":{"experiencePersonalization":true}}'),
			('category-default','{"privacy":{"experiencePersonalization":true}}')`},
	})
	makeJob := func(user string) *models.EmailDeliveryJob {
		return &models.EmailDeliveryJob{UserID: user, Category: models.EmailCategoryRecommendations,
			DedupeKey: "campaign-1", Subject: "Try this", BodyHTML: "<p>Suggestion</p>"}
	}
	for _, user := range []string{"consent-off", "consent-missing", "no-preferences-row", "consent-malformed"} {
		if queued, err := repo.EnqueueIfEligible(ctx, makeJob(user)); err != nil || queued {
			t.Errorf("recommendations enqueue for %s = %v, %v; want denied", user, queued, err)
		}
	}
	for _, user := range []string{"consent-on", "category-default"} {
		if queued, err := repo.EnqueueIfEligible(ctx, makeJob(user)); err != nil || !queued {
			t.Fatalf("recommendations enqueue for %s = %v, %v; want enabled", user, queued, err)
		}
	}
	var job models.EmailDeliveryJob
	if err := db.Conn.QueryRowContext(ctx, `SELECT id,user_id,category,dedupe_key,subject,body_html FROM email_delivery_jobs WHERE user_id='consent-on'`).Scan(&job.ID, &job.UserID, &job.Category, &job.DedupeKey, &job.Subject, &job.BodyHTML); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.ExecContext(ctx, `UPDATE user_preferences SET data='{"email_preferences":{"recommendations":true},"privacy":{"experiencePersonalization":false}}' WHERE user_id='consent-on'`); err != nil {
		t.Fatal(err)
	}
	if allowed, err := repo.CanDeliver(ctx, &job, time.Now().UTC()); err != nil || allowed {
		t.Fatalf("delivery after personalization consent revocation = %v, %v; want denied", allowed, err)
	}
}
