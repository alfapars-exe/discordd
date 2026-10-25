package services

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

type reportRepoStub struct {
	created        *models.Report
	pendingMessage bool
}

func (s *reportRepoStub) Create(_ context.Context, report *models.Report) error {
	s.created = report
	return nil
}
func (*reportRepoStub) GetByID(context.Context, string) (*models.Report, error) { return nil, nil }
func (*reportRepoStub) ListPending(context.Context, int, int) ([]models.ReportWithUsers, int, error) {
	return nil, 0, nil
}
func (*reportRepoStub) ListAll(context.Context, int, int) ([]models.ReportWithUsers, int, error) {
	return nil, 0, nil
}
func (*reportRepoStub) UpdateStatus(context.Context, string, models.ReportStatus, string) error {
	return nil
}
func (*reportRepoStub) HasPendingReport(context.Context, string, string) (bool, error) {
	return false, nil
}
func (s *reportRepoStub) HasPendingMessageReport(context.Context, string, string) (bool, error) {
	return s.pendingMessage, nil
}
func (*reportRepoStub) CreateAttachment(context.Context, *models.ReportAttachment) error { return nil }
func (*reportRepoStub) GetAttachmentsByReportID(context.Context, string) ([]models.ReportAttachment, error) {
	return nil, nil
}
func (*reportRepoStub) GetAttachmentByFileURL(context.Context, string) (*models.ReportAttachment, error) {
	return nil, nil
}

type reportUserLookupStub struct{}

func (reportUserLookupStub) GetByID(_ context.Context, id string) (*models.User, error) {
	return &models.User{ID: id, Username: id}, nil
}

type reportChannelReaderStub struct {
	page *models.MessagePage
	err  error
}

func (s reportChannelReaderStub) GetAround(context.Context, string, string, string, string, int) (*models.MessagePage, error) {
	return s.page, s.err
}

func TestMessageReportRequiresAuthorizedMatchingSource(t *testing.T) {
	repo := &reportRepoStub{}
	reader := reportChannelReaderStub{page: &models.MessagePage{Messages: []models.Message{{ID: "m1", UserID: "target"}}}}
	svc := NewReportService(repo, reportUserLookupStub{}, reader, nil, nil)
	evidence := "decrypted evidence"
	req := &models.CreateReportRequest{
		Reason: "harassment", Description: "This message is abusive",
		SourceKind: "channel", SourceServerID: "s1", SourceChannelID: "c1", SourceMessageID: "m1",
		EvidenceConsent: true, EvidenceContent: &evidence,
	}

	report, err := svc.CreateReport(context.Background(), "reporter", "target", req)
	if err != nil {
		t.Fatalf("CreateReport: %v", err)
	}
	if repo.created != report || report.SourceMessageID == nil || *report.SourceMessageID != "m1" {
		t.Fatalf("message context was not persisted: %+v", report)
	}
	if !report.EvidenceShared || report.EvidenceContent == nil || *report.EvidenceContent != evidence {
		t.Fatalf("consented evidence was not persisted: %+v", report)
	}

	reader.page.Messages[0].UserID = "someone-else"
	if _, err := svc.CreateReport(context.Background(), "reporter", "target", req); !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatalf("author mismatch err = %v, want bad request", err)
	}

	reader.page = nil
	svc = NewReportService(repo, reportUserLookupStub{}, reportChannelReaderStub{err: pkg.ErrForbidden}, nil, nil)
	if _, err := svc.CreateReport(context.Background(), "reporter", "target", req); !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("inaccessible source err = %v, want forbidden", err)
	}
}

func TestEncryptedEvidenceNeedsExplicitConsent(t *testing.T) {
	evidence := "secret"
	req := &models.CreateReportRequest{
		Reason: "spam", Description: "This is unwanted spam",
		SourceKind: "dm", SourceChannelID: "d1", SourceMessageID: "m1",
		EvidenceContent: &evidence,
	}
	if err := req.Validate(); err == nil {
		t.Fatal("evidence without explicit consent was accepted")
	}
}

type reportGroupReaderStub struct {
	member  bool
	message *models.GroupDMMessage
	err     error
}

func (s reportGroupReaderStub) IsMember(context.Context, string, string) (bool, error) {
	return s.member, s.err
}
func (s reportGroupReaderStub) GetMessage(context.Context, string, string) (*models.GroupDMMessage, error) {
	return s.message, s.err
}

func TestGroupMessageReportAuthorizationAndConsent(t *testing.T) {
	for _, test := range []struct {
		name    string
		member  bool
		author  string
		message bool
		consent bool
		want    error
	}{
		{"metadata-only", true, "target", true, false, nil},
		{"consented", true, "target", true, true, nil},
		{"removed-member", false, "target", true, false, pkg.ErrForbidden},
		{"missing-message", true, "target", false, false, pkg.ErrForbidden},
		{"wrong-author", true, "other", true, false, pkg.ErrBadRequest},
	} {
		t.Run(test.name, func(t *testing.T) {
			repo := &reportRepoStub{}
			reader := reportGroupReaderStub{member: test.member}
			if test.message {
				reader.message = &models.GroupDMMessage{ID: "message", GroupID: "group", UserID: test.author}
			}
			svc := NewReportService(repo, reportUserLookupStub{}, nil, nil, reader)
			req := &models.CreateReportRequest{Reason: "spam", Description: "Unwanted group message", SourceKind: "group", SourceChannelID: "group", SourceMessageID: "message", EvidenceConsent: test.consent}
			if test.consent {
				evidence := "explicitly shared decrypted content"
				req.EvidenceContent = &evidence
			}
			report, err := svc.CreateReport(context.Background(), "reporter", "target", req)
			if !errors.Is(err, test.want) {
				t.Fatalf("error: %v want %v", err, test.want)
			}
			if test.want != nil {
				if repo.created != nil {
					t.Fatal("unauthorized report persisted")
				}
				return
			}
			if report.SourceKind == nil || *report.SourceKind != "group" || report.EvidenceShared != test.consent || (report.EvidenceContent != nil) != test.consent {
				t.Fatalf("invalid report: %+v", report)
			}
		})
	}
}
