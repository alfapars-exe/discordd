package services

import (
	"context"
	"fmt"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/repository"
	"github.com/google/uuid"
)

var feedbackLogger = logx.Component("service.feedback")

type FeedbackService interface {
	CreateTicket(ctx context.Context, userID string, req *models.CreateFeedbackRequest) (*models.FeedbackTicket, error)
	GetTicketByID(ctx context.Context, id, userID string, isAdmin bool) (*models.FeedbackTicketWithUser, []models.FeedbackReplyWithUser, error)
	ListByUser(ctx context.Context, userID string, limit, offset int) ([]models.FeedbackTicketWithUser, int, error)
	ListAll(ctx context.Context, status, ticketType string, limit, offset int) ([]models.FeedbackTicketWithUser, int, error)
	AddReply(ctx context.Context, ticketID, userID string, isAdmin bool, req *models.CreateFeedbackReplyRequest) (*models.FeedbackReply, error)
	UpdateStatus(ctx context.Context, ticketID string, req *models.UpdateFeedbackStatusRequest) error
	DeleteTicket(ctx context.Context, id, userID string) error
	SetUploadDir(dir string)
}

type feedbackService struct {
	feedbackRepo repository.FeedbackRepository
	// uploadDir enables best-effort disk cleanup on ticket delete (see
	// upload_cleanup.go). Blank disables cleanup — set via SetUploadDir,
	// wired in init_services.go so the constructor signature below stays
	// unchanged.
	uploadDir string
}

func NewFeedbackService(feedbackRepo repository.FeedbackRepository) FeedbackService {
	return &feedbackService{feedbackRepo: feedbackRepo}
}

func (s *feedbackService) SetUploadDir(dir string) {
	s.uploadDir = dir
}

func (s *feedbackService) CreateTicket(ctx context.Context, userID string, req *models.CreateFeedbackRequest) (*models.FeedbackTicket, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	ticket := &models.FeedbackTicket{
		ID:      uuid.New().String(),
		UserID:  userID,
		Type:    models.FeedbackType(req.Type),
		Subject: req.Subject,
		Content: req.Content,
		Status:  models.FeedbackStatusOpen,
	}

	if err := s.feedbackRepo.CreateTicket(ctx, ticket); err != nil {
		return nil, err
	}

	// Re-read to get server-generated timestamps
	created, err := s.feedbackRepo.GetTicketByID(ctx, ticket.ID)
	if err != nil {
		return nil, err
	}
	ticket.CreatedAt = created.CreatedAt
	ticket.UpdatedAt = created.UpdatedAt

	return ticket, nil
}

func (s *feedbackService) GetTicketByID(ctx context.Context, id, userID string, isAdmin bool) (*models.FeedbackTicketWithUser, []models.FeedbackReplyWithUser, error) {
	ticket, err := s.feedbackRepo.GetTicketByID(ctx, id)
	if err != nil {
		return nil, nil, err
	}

	// Non-admin users can only view their own tickets
	if !isAdmin && ticket.UserID != userID {
		return nil, nil, fmt.Errorf("%w: you can only view your own feedback", pkg.ErrForbidden)
	}

	replies, err := s.feedbackRepo.GetRepliesByTicketID(ctx, id)
	if err != nil {
		return nil, nil, err
	}

	allAtts, _ := s.feedbackRepo.GetAttachmentsByTicketID(ctx, id)

	// Separate ticket-level vs reply-level attachments
	for i := range allAtts {
		if allAtts[i].ReplyID == nil {
			ticket.Attachments = append(ticket.Attachments, allAtts[i])
		} else {
			for j := range replies {
				if replies[j].ID == *allAtts[i].ReplyID {
					replies[j].Attachments = append(replies[j].Attachments, allAtts[i])
					break
				}
			}
		}
	}

	return ticket, replies, nil
}

func (s *feedbackService) ListByUser(ctx context.Context, userID string, limit, offset int) ([]models.FeedbackTicketWithUser, int, error) {
	if limit <= 0 || limit > 50 {
		limit = 20
	}
	return s.feedbackRepo.ListByUser(ctx, userID, limit, offset)
}

func (s *feedbackService) ListAll(ctx context.Context, status, ticketType string, limit, offset int) ([]models.FeedbackTicketWithUser, int, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	return s.feedbackRepo.ListAll(ctx, status, ticketType, limit, offset)
}

func (s *feedbackService) AddReply(ctx context.Context, ticketID, userID string, isAdmin bool, req *models.CreateFeedbackReplyRequest) (*models.FeedbackReply, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	// Verify ticket exists and user has access
	ticket, err := s.feedbackRepo.GetTicketByID(ctx, ticketID)
	if err != nil {
		return nil, err
	}
	if !isAdmin && ticket.UserID != userID {
		return nil, fmt.Errorf("%w: you can only reply to your own feedback", pkg.ErrForbidden)
	}

	reply := &models.FeedbackReply{
		ID:       uuid.New().String(),
		TicketID: ticketID,
		UserID:   userID,
		IsAdmin:  isAdmin,
		Content:  req.Content,
	}

	if err := s.feedbackRepo.CreateReply(ctx, reply); err != nil {
		return nil, err
	}

	return reply, nil
}

func (s *feedbackService) DeleteTicket(ctx context.Context, id, userID string) error {
	ticket, err := s.feedbackRepo.GetTicketByID(ctx, id)
	if err != nil {
		return err
	}
	if ticket.UserID != userID {
		return fmt.Errorf("%w: you can only delete your own feedback", pkg.ErrForbidden)
	}

	// Pre-fetch attachment file_urls (ticket-level and reply-level, both
	// returned by this query) for the post-delete disk cleanup below. A
	// fetch failure here is logged and non-fatal — the delete still
	// proceeds, it just can't clean up files it couldn't enumerate.
	attachments, attErr := s.feedbackRepo.GetAttachmentsByTicketID(ctx, id)
	if attErr != nil {
		feedbackLogger.Error("failed to fetch attachments before ticket delete", "ticket_id", id, "err", pkg.ErrText(attErr))
	}

	if err := s.feedbackRepo.DeleteTicket(ctx, id); err != nil {
		return err
	}

	// Only remove files once the DB delete has actually committed — see
	// upload_cleanup.go for why the ordering matters.
	if len(attachments) > 0 {
		fileURLs := make([]string, len(attachments))
		for i, a := range attachments {
			fileURLs[i] = a.FileURL
		}
		removeUploadFilesByURL(s.uploadDir, fileURLs)
	}

	return nil
}

func (s *feedbackService) UpdateStatus(ctx context.Context, ticketID string, req *models.UpdateFeedbackStatusRequest) error {
	if err := req.Validate(); err != nil {
		return fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}
	return s.feedbackRepo.UpdateStatus(ctx, ticketID, models.FeedbackStatus(req.Status))
}
