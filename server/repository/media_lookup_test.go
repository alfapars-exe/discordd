// Repository-level tests for the /api/uploads/<name> -> owner reads added
// ahead of the media access authorization fail-closed pass (see
// services/media_access_service.go): ReportRepository and
// FeedbackRepository's GetAttachmentByFileURL, plus the new
// MediaAssetRepository.IsPublicAsset "is this path a positively known
// public asset" query. DB harness: testdb_test.go.
package repository

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

// ─── ReportRepository.GetAttachmentByFileURL ───

func TestReportRepo_GetAttachmentByFileURL_found(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()
	userRepo := NewSQLiteUserRepo(db.Conn)
	reportRepo := NewSQLiteReportRepo(db.Conn)

	reporter := &models.User{Username: "reporter-a", Status: "online"}
	if err := userRepo.Create(ctx, reporter); err != nil {
		t.Fatalf("create reporter: %v", err)
	}
	target := &models.User{Username: "target-a", Status: "online"}
	if err := userRepo.Create(ctx, target); err != nil {
		t.Fatalf("create target: %v", err)
	}

	report := &models.Report{
		ID:             "report-1",
		ReporterID:     reporter.ID,
		ReportedUserID: target.ID,
		Reason:         "spam",
		Description:    "evidence attached",
	}
	if err := reportRepo.Create(ctx, report); err != nil {
		t.Fatalf("create report: %v", err)
	}

	att := &models.ReportAttachment{
		ReportID: report.ID,
		Filename: "evidence.png",
		FileURL:  "/api/uploads/rep_evidence.png",
	}
	if err := reportRepo.CreateAttachment(ctx, att); err != nil {
		t.Fatalf("create report attachment: %v", err)
	}

	got, err := reportRepo.GetAttachmentByFileURL(ctx, att.FileURL)
	if err != nil {
		t.Fatalf("GetAttachmentByFileURL: %v", err)
	}
	if got.ID != att.ID || got.ReportID != report.ID {
		t.Errorf("got %+v, want id=%s report_id=%s", got, att.ID, report.ID)
	}
}

func TestReportRepo_GetAttachmentByFileURL_notFound(t *testing.T) {
	db := newTestDB(t)
	reportRepo := NewSQLiteReportRepo(db.Conn)

	_, err := reportRepo.GetAttachmentByFileURL(context.Background(), "/api/uploads/does-not-exist.png")
	if !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("err = %v, want pkg.ErrNotFound", err)
	}
}

// ─── FeedbackRepository.GetAttachmentByFileURL ───

func TestFeedbackRepo_GetAttachmentByFileURL_found(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()
	userRepo := NewSQLiteUserRepo(db.Conn)
	feedbackRepo := NewSQLiteFeedbackRepo(db.Conn)

	user := &models.User{Username: "feedback-user", Status: "online"}
	if err := userRepo.Create(ctx, user); err != nil {
		t.Fatalf("create user: %v", err)
	}

	ticket := &models.FeedbackTicket{
		ID:      "ticket-1",
		UserID:  user.ID,
		Type:    models.FeedbackTypeBug,
		Subject: "s",
		Content: "c",
		Status:  models.FeedbackStatusOpen,
	}
	if err := feedbackRepo.CreateTicket(ctx, ticket); err != nil {
		t.Fatalf("create ticket: %v", err)
	}

	att := &models.FeedbackAttachment{
		ID:       "fatt-1",
		TicketID: ticket.ID,
		Filename: "evidence.png",
		FileURL:  "/api/uploads/fb_evidence.png",
	}
	if err := feedbackRepo.CreateAttachment(ctx, att); err != nil {
		t.Fatalf("create feedback attachment: %v", err)
	}

	got, err := feedbackRepo.GetAttachmentByFileURL(ctx, att.FileURL)
	if err != nil {
		t.Fatalf("GetAttachmentByFileURL: %v", err)
	}
	if got.ID != att.ID || got.TicketID != ticket.ID {
		t.Errorf("got %+v, want id=%s ticket_id=%s", got, att.ID, ticket.ID)
	}
}

func TestFeedbackRepo_GetAttachmentByFileURL_notFound(t *testing.T) {
	db := newTestDB(t)
	feedbackRepo := NewSQLiteFeedbackRepo(db.Conn)

	_, err := feedbackRepo.GetAttachmentByFileURL(context.Background(), "/api/uploads/does-not-exist.png")
	if !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("err = %v, want pkg.ErrNotFound", err)
	}
}

// ─── MediaAssetRepository.IsPublicAsset ───

func TestMediaAssetRepo_IsPublicAsset(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()
	userRepo := NewSQLiteUserRepo(db.Conn)
	serverRepo := NewSQLiteServerRepo(db.Conn)
	mediaRepo := NewSQLiteMediaAssetRepo(db.Conn)

	avatarURL := "/api/uploads/avatar_1.png"
	wallpaperURL := "/api/uploads/wallpaper_1.png"
	user := &models.User{Username: "public-asset-user", Status: "online", AvatarURL: &avatarURL}
	if err := userRepo.Create(ctx, user); err != nil {
		t.Fatalf("create user: %v", err)
	}
	if err := userRepo.UpdateWallpaper(ctx, user.ID, &wallpaperURL); err != nil {
		t.Fatalf("set wallpaper: %v", err)
	}

	iconURL := "/api/uploads/icon_1.png"
	server := &models.Server{Name: "public-asset-server", OwnerID: user.ID, IconURL: &iconURL}
	if err := serverRepo.Create(ctx, server); err != nil {
		t.Fatalf("create server: %v", err)
	}

	cases := []struct {
		name string
		url  string
		want bool
	}{
		{"avatar", avatarURL, true},
		{"wallpaper", wallpaperURL, true},
		{"server icon", iconURL, true},
		{"unknown path", "/api/uploads/nobody_knows_this.png", false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := mediaRepo.IsPublicAsset(ctx, tc.url)
			if err != nil {
				t.Fatalf("IsPublicAsset: %v", err)
			}
			if got != tc.want {
				t.Errorf("IsPublicAsset(%q) = %v, want %v", tc.url, got, tc.want)
			}
		})
	}
}

// TestMediaAssetRepo_IsPublicAsset_messageAttachmentIsNotPublic is the
// negative control the next phase's fail-closed default depends on: a
// private message attachment's file_url must never read back as a public
// asset, or the positive definition would be exactly as leaky as the
// fail-open default it replaces.
func TestMediaAssetRepo_IsPublicAsset_messageAttachmentIsNotPublic(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()
	userRepo := NewSQLiteUserRepo(db.Conn)
	serverRepo := NewSQLiteServerRepo(db.Conn)
	channelRepo := NewSQLiteChannelRepo(db.Conn)
	messageRepo := NewSQLiteMessageRepo(db.Conn)
	attachmentRepo := NewSQLiteAttachmentRepo(db.Conn)
	mediaRepo := NewSQLiteMediaAssetRepo(db.Conn)

	user := &models.User{Username: "private-msg-user", Status: "online"}
	if err := userRepo.Create(ctx, user); err != nil {
		t.Fatalf("create user: %v", err)
	}
	server := &models.Server{Name: "private-msg-server", OwnerID: user.ID}
	if err := serverRepo.Create(ctx, server); err != nil {
		t.Fatalf("create server: %v", err)
	}
	channel := &models.Channel{ServerID: server.ID, Name: "genel", Type: "text"}
	if err := channelRepo.Create(ctx, channel); err != nil {
		t.Fatalf("create channel: %v", err)
	}
	message := &models.Message{ChannelID: channel.ID, UserID: user.ID, Content: strPtr("hello")}
	if err := messageRepo.Create(ctx, message); err != nil {
		t.Fatalf("create message: %v", err)
	}
	att := &models.Attachment{
		MessageID: message.ID,
		Filename:  "private.png",
		FileURL:   "/api/uploads/private_msg.png",
	}
	if err := attachmentRepo.Create(ctx, att); err != nil {
		t.Fatalf("create attachment: %v", err)
	}

	got, err := mediaRepo.IsPublicAsset(ctx, att.FileURL)
	if err != nil {
		t.Fatalf("IsPublicAsset: %v", err)
	}
	if got {
		t.Errorf("IsPublicAsset(%q) = true, want false — a message attachment must never be treated as public", att.FileURL)
	}
}
