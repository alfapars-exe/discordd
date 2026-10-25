package services

import (
	"context"
	"errors"
	"fmt"
	"html"
	"net"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg/email"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/repository"
)

const (
	emailDeliveryBatchTimeout = 45 * time.Second
	emailDeliverySendTimeout  = 10 * time.Second
)

var emailDeliveryLogger = logx.Component("service.email_delivery")

type EmailDeliveryService struct {
	repo                   repository.EmailDeliveryRepository
	sender                 email.CategorySender
	emailUnsubscribeRepo   repository.EmailUnsubscribeRepository
	emailUnsubscribeAppURL string
	emailUnsubscribeOn     bool
}

// EmailDeliveryOption configures optional behavior on an email delivery service.
type EmailDeliveryOption func(*EmailDeliveryService)

// WithEmailUnsubscribe adds a per-delivery, category-scoped unsubscribe link.
// Invalid or incomplete configuration fails closed when delivery is attempted.
func WithEmailUnsubscribe(repo repository.EmailUnsubscribeRepository, appURL string) EmailDeliveryOption {
	return func(service *EmailDeliveryService) {
		service.emailUnsubscribeOn = true
		service.emailUnsubscribeRepo = repo
		service.emailUnsubscribeAppURL = appURL
	}
}

func NewEmailDeliveryService(repo repository.EmailDeliveryRepository, sender email.CategorySender, options ...EmailDeliveryOption) *EmailDeliveryService {
	service := &EmailDeliveryService{repo: repo, sender: sender}
	for _, option := range options {
		if option != nil {
			option(service)
		}
	}
	return service
}
func (s *EmailDeliveryService) Enqueue(ctx context.Context, userID, category, dedupeKey, subject, body string) (bool, error) {
	if s == nil || s.repo == nil {
		return false, fmt.Errorf("email delivery unavailable")
	}
	return s.repo.EnqueueIfEligible(ctx, &models.EmailDeliveryJob{UserID: userID, Category: category, DedupeKey: dedupeKey, Subject: subject, BodyHTML: body})
}

// EmailEnqueueOptions carries only bounded event timing/context. DMMessageID is
// used by the repository to recheck unread state immediately before delivery;
// it is never rendered into the email.
type EmailEnqueueOptions struct {
	NotBefore       time.Time
	ExpiresAt       time.Time
	DMMessageID     string
	FriendshipID    string
	FriendshipEvent string
}

// EnqueueWithOptions is an optional extension for delayed, event-backed email
// notices. Existing Enqueue callers retain their immediate/default behavior.
func (s *EmailDeliveryService) EnqueueWithOptions(ctx context.Context, userID, category, dedupeKey, subject, body string, options EmailEnqueueOptions) (bool, error) {
	if s == nil || s.repo == nil {
		return false, fmt.Errorf("email delivery unavailable")
	}
	job := &models.EmailDeliveryJob{UserID: userID, Category: category, DedupeKey: dedupeKey, Subject: subject, BodyHTML: body, DMMessageID: options.DMMessageID, FriendshipID: options.FriendshipID, FriendshipEvent: options.FriendshipEvent}
	if !options.NotBefore.IsZero() {
		job.NotBefore = options.NotBefore.UTC().Format(time.RFC3339Nano)
	}
	if !options.ExpiresAt.IsZero() {
		job.ExpiresAt = options.ExpiresAt.UTC().Format(time.RFC3339Nano)
	}
	return s.repo.EnqueueIfEligible(ctx, job)
}
func (s *EmailDeliveryService) DeliverBatch(ctx context.Context, now time.Time) (int, error) {
	if s == nil || s.repo == nil || s.sender == nil {
		return 0, nil
	}
	jobs, err := s.repo.ClaimDue(ctx, now, 25)
	if err != nil {
		return 0, errors.New("email delivery claim failed")
	}
	done := 0
	var batchErr error
	for _, j := range jobs {
		// Campaign jobs can expire after ClaimDue selected them but before this
		// worker reaches the send. Enforce expiry against wall time here as well
		// as in the repository's claim/send eligibility checks.
		if emailDeliveryJobExpired(j, time.Now().UTC()) {
			if retryErr := s.repo.Retry(ctx, j.ID, j.ClaimToken, "email campaign expired", now, 1); retryErr != nil {
				batchErr = errors.Join(batchErr, errors.New("email delivery cancellation persistence failed"))
			}
			continue
		}
		allowed, eligibilityErr := s.repo.CanDeliver(ctx, &j, now)
		if eligibilityErr != nil {
			if retryErr := s.repo.Retry(ctx, j.ID, j.ClaimToken, "recipient eligibility unavailable", now.Add(time.Minute), 5); retryErr != nil {
				batchErr = errors.Join(batchErr, errors.New("email delivery retry persistence failed"))
			}
			continue
		}
		if !allowed {
			if retryErr := s.repo.Retry(ctx, j.ID, j.ClaimToken, "recipient is no longer eligible", now, 1); retryErr != nil {
				batchErr = errors.Join(batchErr, errors.New("email delivery cancellation persistence failed"))
			}
			continue
		}
		body := j.BodyHTML
		if s.emailUnsubscribeOn {
			link, linkErr := s.issueEmailUnsubscribeLink(ctx, j.UserID, j.Category, j.Address, now)
			if linkErr != nil {
				// Do not persist or log token/repository/configuration details.
				if retryErr := s.repo.Retry(ctx, j.ID, j.ClaimToken, "email unsubscribe link unavailable", now.Add(time.Minute), 5); retryErr != nil {
					batchErr = errors.Join(batchErr, errors.New("email delivery retry persistence failed"))
				}
				continue
			}
			body += emailUnsubscribeFooter(link)
		}
		// Issuing the one-time unsubscribe proof can itself take time. Do not
		// start an external send if the campaign expired while it was issued.
		if emailDeliveryJobExpired(j, time.Now().UTC()) {
			if retryErr := s.repo.Retry(ctx, j.ID, j.ClaimToken, "email campaign expired", now, 1); retryErr != nil {
				batchErr = errors.Join(batchErr, errors.New("email delivery cancellation persistence failed"))
			}
			continue
		}
		// Address proofs may involve a database round trip. Recheck the event,
		// address and consent after that work, immediately before external send.
		allowed, eligibilityErr = s.repo.CanDeliver(ctx, &j, time.Now().UTC())
		if eligibilityErr != nil || !allowed {
			reason, retryAt, attempts := "recipient is no longer eligible", now, 1
			if eligibilityErr != nil {
				reason, retryAt, attempts = "recipient eligibility unavailable", now.Add(time.Minute), 5
			}
			if retryErr := s.repo.Retry(ctx, j.ID, j.ClaimToken, reason, retryAt, attempts); retryErr != nil {
				batchErr = errors.Join(batchErr, errors.New("email delivery eligibility persistence failed"))
			}
			continue
		}
		if j.DMMessageID != "" && j.DMUnreadCount > 0 {
			// Summarize metadata only. Never decrypt or include sender identities,
			// conversation names, message snippets or ciphertext in an email.
			count := j.DMUnreadCount
			j.Subject = "Your unread HiChat conversation summary"
			footer := ""
			if s.emailUnsubscribeOn {
				// Keep the already generated, address-bound footer when replacing
				// the generic queued body with the current metadata summary.
				footer = strings.TrimPrefix(body, j.BodyHTML)
			}
			body = fmt.Sprintf("<p>You have %d unread messages in a HiChat conversation. Open HiChat to read them.</p>", count) + footer
		}
		sendCtx, cancelSend := context.WithTimeout(ctx, emailDeliverySendTimeout)
		sendErr := s.sender.SendCategoryEmail(sendCtx, j.Address, j.Subject, body)
		cancelSend()
		if sendErr != nil {
			backoff := time.Duration(1<<min(j.Attempts, 6)) * time.Minute
			// Provider errors may include recipient, body, headers, or proof tokens.
			// Keep persisted errors and returned batch diagnostics content-free.
			if retryErr := s.repo.Retry(ctx, j.ID, j.ClaimToken, "email delivery failed", now.Add(backoff), 5); retryErr != nil {
				batchErr = errors.Join(batchErr, errors.New("email delivery retry persistence failed"))
			}
			continue
		}
		if err = s.repo.MarkDelivered(ctx, j.ID, j.ClaimToken, now); err != nil {
			return done, errors.Join(batchErr, errors.New("email delivery acknowledgment failed"))
		}
		done++
	}
	return done, batchErr
}

func emailDeliveryJobExpired(job models.EmailDeliveryJob, now time.Time) bool {
	if job.ExpiresAt == "" {
		return false
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, job.ExpiresAt)
	return err != nil || !expiresAt.After(now)
}

var errEmailUnsubscribeUnavailable = errors.New("email unsubscribe unavailable")

func (s *EmailDeliveryService) issueEmailUnsubscribeLink(ctx context.Context, userID, category, expectedAddress string, now time.Time) (string, error) {
	if s.emailUnsubscribeRepo == nil {
		return "", errEmailUnsubscribeUnavailable
	}
	baseURL, err := emailUnsubscribeBaseURL(s.emailUnsubscribeAppURL)
	if err != nil {
		return "", errEmailUnsubscribeUnavailable
	}
	token, err := s.emailUnsubscribeRepo.IssueForAddress(ctx, userID, category, expectedAddress, now)
	if err != nil || token == "" || len(token) > 512 {
		return "", errEmailUnsubscribeUnavailable
	}
	return baseURL + "?token=" + url.QueryEscape(token), nil
}

func emailUnsubscribeBaseURL(appURL string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(appURL))
	if err != nil || !u.IsAbs() || u.Opaque != "" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.RawFragment != "" {
		return "", errEmailUnsubscribeUnavailable
	}
	scheme := strings.ToLower(u.Scheme)
	switch scheme {
	case "https":
	case "http":
		host := u.Hostname()
		ip := net.ParseIP(host)
		if !strings.EqualFold(strings.TrimSuffix(host, "."), "localhost") && (ip == nil || !ip.IsLoopback()) {
			return "", errEmailUnsubscribeUnavailable
		}
	default:
		return "", errEmailUnsubscribeUnavailable
	}
	if u.Hostname() == "" {
		return "", errEmailUnsubscribeUnavailable
	}
	// Intentionally discard any configured app subpath and use the API root.
	return scheme + "://" + u.Host + "/api/email/unsubscribe", nil
}

func emailUnsubscribeFooter(link string) string {
	return "\n<hr><p style=\"color:#6b7280;font-size:12px\">You are receiving this email because of your HiChat email preferences. <a href=\"" + html.EscapeString(link) + "\">Unsubscribe from this category</a>.</p>"
}

func (s *EmailDeliveryService) Start(ctx context.Context) func() {
	worker, cancel := context.WithCancel(ctx)
	var once sync.Once
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			batchCtx, cancelBatch := context.WithTimeout(worker, emailDeliveryBatchTimeout)
			done, err := s.DeliverBatch(batchCtx, time.Now())
			cancelBatch()
			if err != nil {
				emailDeliveryLogger.Error("email delivery batch incomplete", "delivered", done, "err", err.Error())
			}
			select {
			case <-worker.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	return func() { once.Do(cancel) }
}
