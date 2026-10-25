package services

import (
	"context"
	"fmt"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"

	"github.com/google/uuid"
)

// ReportService handles user reporting and admin report management.
type ReportService interface {
	CreateReport(ctx context.Context, reporterID, targetID string, req *models.CreateReportRequest) (*models.Report, error)
	ListReports(ctx context.Context, status string, limit, offset int) ([]models.ReportWithUsers, int, error)
	UpdateReportStatus(ctx context.Context, reportID string, status models.ReportStatus, adminID string) error
}

type reportTargetLookup interface {
	GetByID(ctx context.Context, id string) (*models.User, error)
}

type reportChannelMessageReader interface {
	GetAround(ctx context.Context, serverID, channelID, userID, anchorID string, limit int) (*models.MessagePage, error)
}

type reportDMMessageReader interface {
	GetMessagesAround(ctx context.Context, userID, channelID, anchorID string, limit int) (*models.DMMessagePage, error)
}

type reportGroupMessageReader interface {
	IsMember(context.Context, string, string) (bool, error)
	GetMessage(context.Context, string, string) (*models.GroupDMMessage, error)
}

type reportService struct {
	reportRepo repository.ReportRepository
	userRepo   reportTargetLookup
	messages   reportChannelMessageReader
	dms        reportDMMessageReader
	groups     reportGroupMessageReader
}

func NewReportService(
	reportRepo repository.ReportRepository,
	userRepo reportTargetLookup,
	messages reportChannelMessageReader,
	dms reportDMMessageReader,
	groups reportGroupMessageReader,
) ReportService {
	return &reportService{
		reportRepo: reportRepo,
		userRepo:   userRepo,
		messages:   messages,
		dms:        dms,
		groups:     groups,
	}
}

func (s *reportService) CreateReport(ctx context.Context, reporterID, targetID string, req *models.CreateReportRequest) (*models.Report, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, pkg.ErrText(err))
	}

	if reporterID == targetID {
		return nil, fmt.Errorf("%w: cannot report yourself", pkg.ErrBadRequest)
	}

	if _, err := s.userRepo.GetByID(ctx, targetID); err != nil {
		return nil, fmt.Errorf("%w: user not found", pkg.ErrNotFound)
	}

	if req.SourceMessageID != "" {
		var sourceAuthorID string
		switch req.SourceKind {
		case "channel":
			page, err := s.messages.GetAround(ctx, req.SourceServerID, req.SourceChannelID, reporterID, req.SourceMessageID, 1)
			if err != nil || page == nil || len(page.Messages) != 1 || page.Messages[0].ID != req.SourceMessageID {
				return nil, fmt.Errorf("%w: message is unavailable", pkg.ErrForbidden)
			}
			sourceAuthorID = page.Messages[0].UserID
		case "dm":
			page, err := s.dms.GetMessagesAround(ctx, reporterID, req.SourceChannelID, req.SourceMessageID, 1)
			if err != nil || page == nil || len(page.Messages) != 1 || page.Messages[0].ID != req.SourceMessageID {
				return nil, fmt.Errorf("%w: message is unavailable", pkg.ErrForbidden)
			}
			sourceAuthorID = page.Messages[0].UserID
		case "group":
			if s.groups == nil {
				return nil, pkg.ErrForbidden
			}
			member, err := s.groups.IsMember(ctx, req.SourceChannelID, reporterID)
			if err != nil || !member {
				return nil, fmt.Errorf("%w: message is unavailable", pkg.ErrForbidden)
			}
			message, err := s.groups.GetMessage(ctx, req.SourceChannelID, req.SourceMessageID)
			if err != nil || message == nil || message.ID != req.SourceMessageID {
				return nil, fmt.Errorf("%w: message is unavailable", pkg.ErrForbidden)
			}
			sourceAuthorID = message.UserID
		}
		if sourceAuthorID != targetID {
			return nil, fmt.Errorf("%w: reported user did not author this message", pkg.ErrBadRequest)
		}
	}

	// Duplicate check — prevent multiple pending reports for the same pair
	var hasPending bool
	var err error
	if req.SourceMessageID != "" {
		hasPending, err = s.reportRepo.HasPendingMessageReport(ctx, reporterID, req.SourceMessageID)
	} else {
		hasPending, err = s.reportRepo.HasPendingReport(ctx, reporterID, targetID)
	}
	if err != nil {
		return nil, fmt.Errorf("failed to check pending report: %w", err)
	}
	if hasPending {
		return nil, fmt.Errorf("%w: you already have a pending report for this user", pkg.ErrAlreadyExists)
	}

	report := &models.Report{
		ID:             uuid.New().String(),
		ReporterID:     reporterID,
		ReportedUserID: targetID,
		Reason:         models.ReportReason(req.Reason),
		Description:    req.Description,
		Status:         models.ReportStatusPending,
		EvidenceShared: req.EvidenceConsent,
	}
	if req.SourceMessageID != "" {
		report.SourceKind = &req.SourceKind
		report.SourceChannelID = &req.SourceChannelID
		report.SourceMessageID = &req.SourceMessageID
		if req.SourceServerID != "" {
			report.SourceServerID = &req.SourceServerID
		}
		if req.EvidenceConsent {
			report.EvidenceContent = req.EvidenceContent
		}
	}

	if err := s.reportRepo.Create(ctx, report); err != nil {
		return nil, fmt.Errorf("failed to create report: %w", err)
	}

	return report, nil
}

// ListReports returns reports with attachments. Filters by status if provided.
// N+1 query for attachments — acceptable since admin panel has limited report count (max 100).
func (s *reportService) ListReports(ctx context.Context, status string, limit, offset int) ([]models.ReportWithUsers, int, error) {
	var reports []models.ReportWithUsers
	var total int
	var err error

	if status == string(models.ReportStatusPending) {
		reports, total, err = s.reportRepo.ListPending(ctx, limit, offset)
	} else {
		reports, total, err = s.reportRepo.ListAll(ctx, limit, offset)
	}

	if err != nil {
		return nil, 0, fmt.Errorf("failed to list reports: %w", err)
	}

	// Populate attachments for each report
	for i := range reports {
		attachments, attErr := s.reportRepo.GetAttachmentsByReportID(ctx, reports[i].ID)
		if attErr != nil {
			reports[i].Attachments = []models.ReportAttachment{}
			continue
		}
		reports[i].Attachments = attachments
	}

	return reports, total, nil
}

func (s *reportService) UpdateReportStatus(ctx context.Context, reportID string, status models.ReportStatus, adminID string) error {
	if err := s.reportRepo.UpdateStatus(ctx, reportID, status, adminID); err != nil {
		return fmt.Errorf("failed to update report status: %w", err)
	}
	return nil
}
