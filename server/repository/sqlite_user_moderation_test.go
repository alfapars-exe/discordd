package repository

import (
	"context"
	"database/sql"
	"testing"

	"github.com/argeinfina/hichat/models"
)

// TestHardDeleteUser_ReportsFeedbackBadges — P3.2: reports/feedback/badge
// rows that referenced the deleted user must not survive as dangling
// references. Reports and feedback the deleted user wrote are removed
// outright; reports.resolved_by (nullable) is cleared to NULL when the
// deleted user resolved someone else's report rather than being
// reassigned; badges/user_badges, which must outlive the account, are
// reassigned to the admin performing the deletion instead of being deleted.
func TestHardDeleteUser_ReportsFeedbackBadges(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()

	userRepo := NewSQLiteUserRepo(db.Conn)
	reportRepo := NewSQLiteReportRepo(db.Conn)
	feedbackRepo := NewSQLiteFeedbackRepo(db.Conn)
	badgeRepo := NewSQLiteBadgeRepo(db.Conn)

	admin := &models.User{Username: "admin-reassign", Status: "online"}
	if err := userRepo.Create(ctx, admin); err != nil {
		t.Fatalf("create admin: %v", err)
	}
	victim := &models.User{Username: "victim", Status: "online"}
	if err := userRepo.Create(ctx, victim); err != nil {
		t.Fatalf("create victim: %v", err)
	}
	bystander := &models.User{Username: "bystander", Status: "online"}
	if err := userRepo.Create(ctx, bystander); err != nil {
		t.Fatalf("create bystander: %v", err)
	}

	// Report the victim filed against someone else — deleted outright.
	reportByVictim := &models.Report{
		ID: "report-by-victim", ReporterID: victim.ID, ReportedUserID: bystander.ID,
		Reason: models.ReportReasonOther, Description: "x",
	}
	if err := reportRepo.Create(ctx, reportByVictim); err != nil {
		t.Fatalf("create report by victim: %v", err)
	}
	// Report the victim resolved for two other users — the report itself
	// survives, but resolved_by must be cleared.
	reportResolvedByVictim := &models.Report{
		ID: "report-resolved-by-victim", ReporterID: bystander.ID, ReportedUserID: bystander.ID,
		Reason: models.ReportReasonOther, Description: "y",
	}
	if err := reportRepo.Create(ctx, reportResolvedByVictim); err != nil {
		t.Fatalf("create report resolved by victim: %v", err)
	}
	if err := reportRepo.UpdateStatus(ctx, reportResolvedByVictim.ID, models.ReportStatusResolved, victim.ID); err != nil {
		t.Fatalf("resolve report: %v", err)
	}

	// Feedback ticket the victim filed — deleted outright (CASCADE removes
	// its replies/attachments).
	ticket := &models.FeedbackTicket{
		ID: "ticket-victim", UserID: victim.ID, Type: models.FeedbackTypeBug,
		Subject: "s", Content: "c", Status: models.FeedbackStatusOpen,
	}
	if err := feedbackRepo.CreateTicket(ctx, ticket); err != nil {
		t.Fatalf("create ticket: %v", err)
	}
	// Reply the victim left on someone else's ticket — the ticket survives,
	// the reply doesn't (feedback_replies.user_id has no CASCADE from users).
	otherTicket := &models.FeedbackTicket{
		ID: "ticket-other", UserID: bystander.ID, Type: models.FeedbackTypeBug,
		Subject: "s2", Content: "c2", Status: models.FeedbackStatusOpen,
	}
	if err := feedbackRepo.CreateTicket(ctx, otherTicket); err != nil {
		t.Fatalf("create other ticket: %v", err)
	}
	reply := &models.FeedbackReply{ID: "reply-victim", TicketID: otherTicket.ID, UserID: victim.ID, Content: "reply"}
	if err := feedbackRepo.CreateReply(ctx, reply); err != nil {
		t.Fatalf("create reply: %v", err)
	}

	// Badge the victim created, and a grant the victim made to someone else
	// — both must survive, reassigned to the admin.
	badge := &models.Badge{ID: "badge-1", Name: "Founder", IconType: "builtin", Color1: "#000", CreatedBy: victim.ID}
	if err := badgeRepo.Create(ctx, badge); err != nil {
		t.Fatalf("create badge: %v", err)
	}
	grant := &models.UserBadge{ID: "grant-1", UserID: bystander.ID, BadgeID: badge.ID, AssignedBy: victim.ID}
	if err := badgeRepo.Assign(ctx, grant); err != nil {
		t.Fatalf("assign badge: %v", err)
	}

	if err := userRepo.HardDeleteUser(ctx, victim.ID, admin.ID); err != nil {
		t.Fatalf("HardDeleteUser: %v", err)
	}

	if got := countRows(t, db, `SELECT COUNT(*) FROM reports WHERE reporter_id = ? OR reported_user_id = ?`, victim.ID, victim.ID); got != 0 {
		t.Errorf("report the deleted user filed/was accused in survived, got %d rows", got)
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM reports WHERE id = ?`, reportResolvedByVictim.ID); got != 1 {
		t.Errorf("report resolved by the deleted user should survive, got %d rows", got)
	}
	var resolvedBy sql.NullString
	if err := db.Conn.QueryRowContext(ctx, `SELECT resolved_by FROM reports WHERE id = ?`, reportResolvedByVictim.ID).Scan(&resolvedBy); err != nil {
		t.Fatalf("read resolved_by: %v", err)
	}
	if resolvedBy.Valid {
		t.Errorf("resolved_by = %q, want NULL after the resolver was deleted", resolvedBy.String)
	}

	if got := countRows(t, db, `SELECT COUNT(*) FROM feedback_tickets WHERE user_id = ?`, victim.ID); got != 0 {
		t.Errorf("feedback ticket filed by deleted user survived")
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM feedback_replies WHERE user_id = ?`, victim.ID); got != 0 {
		t.Errorf("feedback reply left by deleted user survived")
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM feedback_tickets WHERE id = ?`, otherTicket.ID); got != 1 {
		t.Errorf("other user's ticket should survive the deletion")
	}

	gotBadge, err := badgeRepo.GetByID(ctx, badge.ID)
	if err != nil {
		t.Fatalf("get badge: %v", err)
	}
	if gotBadge == nil {
		t.Fatal("badge created by deleted user should survive")
	}
	if gotBadge.CreatedBy != admin.ID {
		t.Errorf("badge created_by = %q, want reassigned to admin %q", gotBadge.CreatedBy, admin.ID)
	}

	badges, err := badgeRepo.GetUserBadges(ctx, bystander.ID)
	if err != nil {
		t.Fatalf("get user badges: %v", err)
	}
	if len(badges) != 1 || badges[0].AssignedBy != admin.ID {
		t.Errorf("user_badges assigned_by not reassigned to admin: %+v", badges)
	}

	if got := countRows(t, db, `SELECT COUNT(*) FROM users WHERE id = ?`, victim.ID); got != 0 {
		t.Error("victim user row survived HardDeleteUser")
	}

	// Belt-and-braces: the deleted ID must not be referenced anywhere.
	for _, q := range []string{
		`SELECT COUNT(*) FROM reports WHERE resolved_by = ?`,
		`SELECT COUNT(*) FROM badges WHERE created_by = ?`,
		`SELECT COUNT(*) FROM user_badges WHERE assigned_by = ?`,
	} {
		if got := countRows(t, db, q, victim.ID); got != 0 {
			t.Errorf("query %q still references the deleted user id, got %d rows", q, got)
		}
	}
}
