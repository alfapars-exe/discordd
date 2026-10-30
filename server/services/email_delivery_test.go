package services

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg/email"
	"github.com/argeinfina/hichat/repository"
)

type emailQueueFake struct {
	attempts           map[string]*models.EmailDeliveryAttempt
	jobs               []models.EmailDeliveryJob
	delivered, retried int
	retryReasons       []string
	claimTokens        []string
	retryErr, markErr  error
	eligibility        func() (bool, error)
}

func (f *emailQueueFake) EnqueueIfEligible(context.Context, *models.EmailDeliveryJob) (bool, error) {
	return true, nil
}
func (f *emailQueueFake) ClaimDue(context.Context, time.Time, int) ([]models.EmailDeliveryJob, error) {
	j := f.jobs
	f.jobs = nil
	return j, nil
}
func (f *emailQueueFake) CanDeliver(context.Context, *models.EmailDeliveryJob, time.Time) (bool, error) {
	if f.eligibility != nil {
		return f.eligibility()
	}
	return true, nil
}
func (f *emailQueueFake) MarkDelivered(_ context.Context, _, claimToken string, _ time.Time) error {
	f.delivered++
	f.claimTokens = append(f.claimTokens, claimToken)
	return f.markErr
}
func (f *emailQueueFake) Retry(_ context.Context, _, claimToken, reason string, _ time.Time, _ int) error {
	f.retried++
	f.claimTokens = append(f.claimTokens, claimToken)
	f.retryReasons = append(f.retryReasons, reason)
	return f.retryErr
}

type categorySenderFake struct{ fail map[string]bool }

func (f categorySenderFake) SendCategoryEmail(_ context.Context, to, _, _ string) error {
	if f.fail[to] {
		return errors.New("temporary")
	}
	return nil
}

type recordingCategorySender struct {
	sentTo, subject, body string
	sends                 int
	err                   error
}

type deadlineCategorySender struct{ deadline time.Time }

func (f *deadlineCategorySender) SendCategoryEmail(ctx context.Context, _, _, _ string) error {
	f.deadline, _ = ctx.Deadline()
	return nil
}

func (f *recordingCategorySender) SendCategoryEmail(_ context.Context, to, subject, body string) error {
	f.sends++
	f.sentTo, f.subject, f.body = to, subject, body
	return f.err
}

type emailUnsubscribeFake struct {
	token, userID, category, expectedAddress string
	issuedAt                                 time.Time
	err                                      error
	calls                                    int
	onIssue                                  func()
}

func (f *emailUnsubscribeFake) Issue(context.Context, string, string, time.Time) (string, error) {
	return "", errors.New("unexpected Issue call; address binding is required")
}

func (f *emailUnsubscribeFake) IssueForAddress(_ context.Context, userID, category, expectedAddress string, now time.Time) (string, error) {
	f.calls++
	f.userID, f.category, f.expectedAddress, f.issuedAt = userID, category, expectedAddress, now
	if f.onIssue != nil {
		f.onIssue()
	}
	return f.token, f.err
}

func (*emailUnsubscribeFake) Inspect(context.Context, string, time.Time) (repository.EmailUnsubscribeTokenState, error) {
	return repository.EmailUnsubscribeTokenState{}, errors.New("not used")
}

func (*emailUnsubscribeFake) Consume(context.Context, string, time.Time) error {
	return errors.New("not used")
}

func TestEmailDeliveryBatchAcknowledgesSuccessAndRetriesFailure(t *testing.T) {
	repo := &emailQueueFake{jobs: []models.EmailDeliveryJob{{ID: "a", Address: "ok@test", Attempts: 1, ClaimToken: "claim-a"}, {ID: "b", Address: "fail@test", Attempts: 1, ClaimToken: "claim-b"}}}
	svc := NewEmailDeliveryService(repo, categorySenderFake{fail: map[string]bool{"fail@test": true}})
	done, err := svc.DeliverBatch(context.Background(), time.Now())
	if err != nil || done != 1 || repo.delivered != 1 || repo.retried != 1 {
		t.Fatalf("done=%d delivered=%d retried=%d err=%v", done, repo.delivered, repo.retried, err)
	}
	seenClaims := map[string]bool{}
	for _, claim := range repo.claimTokens {
		seenClaims[claim] = true
	}
	if len(repo.claimTokens) != 2 || !seenClaims["claim-a"] || !seenClaims["claim-b"] {
		t.Fatalf("claim tokens were not propagated to retry/ack calls: %v", repo.claimTokens)
	}
}

func TestEmailDeliveryConversationSummaryUsesOnlyUnreadCountAndRetainsUnsubscribe(t *testing.T) {
	queue := &emailQueueFake{jobs: []models.EmailDeliveryJob{{ID: "job", UserID: "owner", Category: models.EmailCategoryCommunication, Address: "owner@example.test", DMMessageID: "private-message-id", DMUnreadCount: 12, BodyHTML: "<p>Generic queued notice</p>"}}}
	sender := &recordingCategorySender{}
	unsub := &emailUnsubscribeFake{token: "proof"}
	service := NewEmailDeliveryService(queue, sender, WithEmailUnsubscribe(unsub, "https://app.example.test"))
	done, err := service.DeliverBatch(context.Background(), time.Now().UTC())
	if err != nil || done != 1 || sender.sends != 1 {
		t.Fatalf("done=%d sends=%d err=%v", done, sender.sends, err)
	}
	if !strings.Contains(sender.body, "12 unread messages") || !strings.Contains(sender.body, "https://app.example.test/api/email/unsubscribe?token=proof") {
		t.Fatalf("missing summary/footer: %s", sender.body)
	}
	for _, private := range []string{"private-message-id", "Generic queued notice", "ciphertext", "alice"} {
		if strings.Contains(sender.body, private) {
			t.Fatalf("summary contains private or stale text: %s", private)
		}
	}
}

func TestEmailDeliveryRechecksEligibilityAfterIssuingUnsubscribeProof(t *testing.T) {
	for _, unavailable := range []bool{false, true} {
		t.Run(fmt.Sprint("unavailable=", unavailable), func(t *testing.T) {
			issued := false
			queue := &emailQueueFake{jobs: []models.EmailDeliveryJob{{ID: "job", UserID: "user", Category: models.EmailCategorySocial, Address: "user@example.test"}}}
			queue.eligibility = func() (bool, error) {
				if !issued {
					return true, nil
				}
				if unavailable {
					return false, errors.New("private database detail")
				}
				return false, nil
			}
			unsub := &emailUnsubscribeFake{token: "proof", onIssue: func() { issued = true }}
			sender := &recordingCategorySender{}
			service := NewEmailDeliveryService(queue, sender, WithEmailUnsubscribe(unsub, "https://app.example.test"))
			done, err := service.DeliverBatch(context.Background(), time.Now().UTC())
			if err != nil || done != 0 || sender.sends != 0 || queue.retried != 1 || queue.delivered != 0 {
				t.Fatalf("done=%d sends=%d retried=%d delivered=%d err=%v", done, sender.sends, queue.retried, queue.delivered, err)
			}
			if strings.Contains(strings.Join(queue.retryReasons, " "), "private") {
				t.Fatal("eligibility error leaked")
			}
		})
	}
}

func TestEmailDeliveryAddsEscapedPerCategoryFooterWithoutMutatingQueuedJob(t *testing.T) {
	now := time.Date(2026, 10, 24, 10, 30, 0, 0, time.UTC)
	job := models.EmailDeliveryJob{ID: "job-1", UserID: "user-1", Category: models.EmailCategorySocial, Address: "user@example.test", Subject: "Friend update", BodyHTML: "<p>Hello</p>"}
	queue := &emailQueueFake{jobs: []models.EmailDeliveryJob{job}}
	unsub := &emailUnsubscribeFake{token: `proof&"><script>`}
	sender := &recordingCategorySender{}
	service := NewEmailDeliveryService(queue, sender, WithEmailUnsubscribe(unsub, "https://app.example.test/subpath/settings"))

	done, err := service.DeliverBatch(context.Background(), now)
	if err != nil || done != 1 || sender.sends != 1 || queue.delivered != 1 || queue.retried != 0 {
		t.Fatalf("done=%d sends=%d delivered=%d retried=%d err=%v", done, sender.sends, queue.delivered, queue.retried, err)
	}
	if unsub.calls != 1 || unsub.userID != job.UserID || unsub.category != job.Category || unsub.expectedAddress != job.Address || !unsub.issuedAt.Equal(now) {
		t.Fatalf("IssueForAddress args: calls=%d user=%q category=%q address=%q at=%v", unsub.calls, unsub.userID, unsub.category, unsub.expectedAddress, unsub.issuedAt)
	}
	if !strings.Contains(sender.body, `<p>Hello</p>`) || !strings.Contains(sender.body, `href="https://app.example.test/api/email/unsubscribe?token=proof%26%22%3E%3Cscript%3E"`) {
		t.Fatalf("email body missing escaped root unsubscribe link: %s", sender.body)
	}
	if strings.Contains(sender.body, `href="https://app.example.test/subpath`) || strings.Contains(sender.body, `<script>`) {
		t.Fatalf("subpath or unescaped token leaked into email body: %s", sender.body)
	}
	if job.BodyHTML != "<p>Hello</p>" {
		t.Fatalf("queued payload mutated: %q", job.BodyHTML)
	}
}

func TestEmailDeliveryDoesNotSendExpiredClaimedCampaign(t *testing.T) {
	queue := &emailQueueFake{jobs: []models.EmailDeliveryJob{{
		ID: "expired-campaign-job", UserID: "user-1", Category: models.EmailCategoryAnnouncements,
		Address: "user@example.test", BodyHTML: "<p>Expired</p>", ExpiresAt: time.Now().UTC().Add(-time.Second).Format(time.RFC3339Nano),
	}}}
	sender := &recordingCategorySender{}
	unsub := &emailUnsubscribeFake{token: "unused"}
	service := NewEmailDeliveryService(queue, sender, WithEmailUnsubscribe(unsub, "https://app.example.test"))

	done, err := service.DeliverBatch(context.Background(), time.Now().UTC())
	if err != nil || done != 0 || sender.sends != 0 || unsub.calls != 0 || queue.retried != 1 || queue.delivered != 0 {
		t.Fatalf("done=%d sends=%d unsubscribe issues=%d retries=%d delivered=%d err=%v", done, sender.sends, unsub.calls, queue.retried, queue.delivered, err)
	}
	if len(queue.retryReasons) != 1 || queue.retryReasons[0] != "email campaign expired" {
		t.Fatalf("expired campaign cancellation reason = %v", queue.retryReasons)
	}
}

func TestEmailUnsubscribeAppURLAcceptsOnlyHTTPSOrLoopbackHTTP(t *testing.T) {
	tests := []struct {
		name, input, want string
		valid             bool
	}{
		{name: "https app subpath is replaced", input: "https://app.example.test/app/settings", want: "https://app.example.test/api/email/unsubscribe", valid: true},
		{name: "loopback hostname", input: "http://localhost:8080/nested", want: "http://localhost:8080/api/email/unsubscribe", valid: true},
		{name: "loopback IPv4", input: "http://127.0.0.1:8080", want: "http://127.0.0.1:8080/api/email/unsubscribe", valid: true},
		{name: "loopback IPv6", input: "http://[::1]:8080", want: "http://[::1]:8080/api/email/unsubscribe", valid: true},
		{name: "plain external HTTP", input: "http://app.example.test", valid: false},
		{name: "credentials", input: "https://user:pass@app.example.test", valid: false},
		{name: "query", input: "https://app.example.test?token=old", valid: false},
		{name: "empty query", input: "https://app.example.test?", valid: false},
		{name: "fragment", input: "https://app.example.test/#fragment", valid: false},
		{name: "non-HTTP scheme", input: "ftp://app.example.test", valid: false},
		{name: "relative URL", input: "/app", valid: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := emailUnsubscribeBaseURL(test.input)
			if test.valid && (err != nil || got != test.want) {
				t.Fatalf("base URL = %q, %v; want %q", got, err, test.want)
			}
			if !test.valid && err == nil {
				t.Fatalf("invalid URL accepted: %q", test.input)
			}
		})
	}
}

func TestEmailDeliveryInvalidUnsubscribeURLFailsClosedAndRetriesGenerically(t *testing.T) {
	queue := &emailQueueFake{jobs: []models.EmailDeliveryJob{{ID: "job-2", UserID: "user-2", Category: models.EmailCategorySocial, Address: "user@example.test", BodyHTML: "<p>Hi</p>"}}}
	unsub := &emailUnsubscribeFake{token: "unused"}
	sender := &recordingCategorySender{}
	service := NewEmailDeliveryService(queue, sender, WithEmailUnsubscribe(unsub, "http://external.example.test"))

	done, err := service.DeliverBatch(context.Background(), time.Now())
	if err != nil || done != 0 || sender.sends != 0 || queue.retried != 1 || queue.delivered != 0 {
		t.Fatalf("done=%d sends=%d retried=%d delivered=%d err=%v", done, sender.sends, queue.retried, queue.delivered, err)
	}
	if unsub.calls != 0 {
		t.Fatalf("IssueForAddress called with invalid app URL: %d times", unsub.calls)
	}
	if got := queue.retryReasons[0]; got != "email unsubscribe link unavailable" {
		t.Fatalf("retry reason leaked details or changed: %q", got)
	}
}

func TestEmailDeliveryUnsubscribeIssueFailureDoesNotSendAndRetriesGenerically(t *testing.T) {
	queue := &emailQueueFake{jobs: []models.EmailDeliveryJob{{ID: "job-3", UserID: "user-3", Category: models.EmailCategorySocial, Address: "user@example.test", BodyHTML: "<p>Hi</p>"}}}
	unsub := &emailUnsubscribeFake{err: errors.New("database secret detail")}
	sender := &recordingCategorySender{}
	service := NewEmailDeliveryService(queue, sender, WithEmailUnsubscribe(unsub, "https://app.example.test"))

	done, err := service.DeliverBatch(context.Background(), time.Now())
	if err != nil || done != 0 || sender.sends != 0 || queue.retried != 1 || queue.delivered != 0 {
		t.Fatalf("done=%d sends=%d retried=%d delivered=%d err=%v", done, sender.sends, queue.retried, queue.delivered, err)
	}
	if unsub.calls != 1 || queue.retryReasons[0] != "email unsubscribe link unavailable" || strings.Contains(queue.retryReasons[0], "secret") {
		t.Fatalf("unsubscribe failure was not retried generically: calls=%d reasons=%v", unsub.calls, queue.retryReasons)
	}
}

func TestEmailDeliveryTransportErrorCannotPersistUnsubscribeProof(t *testing.T) {
	queue := &emailQueueFake{jobs: []models.EmailDeliveryJob{{ID: "job-4", UserID: "user-4", Category: models.EmailCategorySocial, Address: "user@example.test", BodyHTML: "<p>Hi</p>"}}}
	const token = "secret-proof"
	unsub := &emailUnsubscribeFake{token: token}
	sender := &recordingCategorySender{err: errors.New("transport failed after serializing proof: " + token)}
	service := NewEmailDeliveryService(queue, sender, WithEmailUnsubscribe(unsub, "https://app.example.test"))

	done, err := service.DeliverBatch(context.Background(), time.Now())
	if err != nil || done != 0 || sender.sends != 1 || queue.retried != 1 || queue.delivered != 0 {
		t.Fatalf("done=%d sends=%d retried=%d delivered=%d err=%v", done, sender.sends, queue.retried, queue.delivered, err)
	}
	if queue.retryReasons[0] != "email delivery failed" || strings.Contains(queue.retryReasons[0], token) {
		t.Fatalf("transport error exposed unsubscribe proof in retry metadata: %q", queue.retryReasons[0])
	}
}

func TestEmailDeliveryRetryPersistenceErrorsAreSanitizedAndReturned(t *testing.T) {
	const secret = "recipient@example.test body-and-token-secret"
	queue := &emailQueueFake{
		jobs:     []models.EmailDeliveryJob{{ID: "job-retry", UserID: "user-1", Category: models.EmailCategorySocial, Address: "recipient@example.test", BodyHTML: "proof"}},
		retryErr: errors.New(secret),
	}
	sender := &recordingCategorySender{err: errors.New(secret)}
	service := NewEmailDeliveryService(queue, sender)

	done, err := service.DeliverBatch(context.Background(), time.Now())
	if done != 0 || err == nil || strings.Contains(err.Error(), "recipient@example.test") || strings.Contains(err.Error(), "token-secret") || strings.Contains(err.Error(), "proof") {
		t.Fatalf("done=%d err=%v; expected a sanitized retry persistence error", done, err)
	}
	if queue.retried != 1 || len(queue.retryReasons) != 1 || queue.retryReasons[0] != "email delivery failed" {
		t.Fatalf("retry metadata was not generic: retries=%d reasons=%v", queue.retried, queue.retryReasons)
	}
}

func TestEmailDeliveryAcknowledgmentErrorIsSanitized(t *testing.T) {
	queue := &emailQueueFake{
		jobs:    []models.EmailDeliveryJob{{ID: "job-ack", UserID: "user-1", Category: models.EmailCategorySocial, Address: "recipient@example.test", BodyHTML: "proof"}},
		markErr: errors.New("database error includes recipient@example.test and proof"),
	}
	service := NewEmailDeliveryService(queue, &recordingCategorySender{})

	done, err := service.DeliverBatch(context.Background(), time.Now())
	if done != 0 || err == nil || strings.Contains(err.Error(), "recipient@example.test") || strings.Contains(err.Error(), "proof") {
		t.Fatalf("done=%d err=%v; expected sanitized acknowledgment error", done, err)
	}
}

func TestEmailDeliveryUsesBoundedSendContext(t *testing.T) {
	queue := &emailQueueFake{jobs: []models.EmailDeliveryJob{{ID: "job-timeout", UserID: "user-1", Category: models.EmailCategorySocial, Address: "recipient@example.test", BodyHTML: "body"}}}
	sender := &deadlineCategorySender{}
	service := NewEmailDeliveryService(queue, sender)
	start := time.Now()

	if _, err := service.DeliverBatch(context.Background(), start); err != nil {
		t.Fatal(err)
	}
	if sender.deadline.IsZero() || sender.deadline.Before(start) || sender.deadline.After(start.Add(emailDeliverySendTimeout+time.Second)) {
		t.Fatalf("send context deadline = %v; expected within %v", sender.deadline, emailDeliverySendTimeout)
	}
}

func (f *emailQueueFake) ReadAttempt(_ context.Context, id string) (*models.EmailDeliveryAttempt, error) {
	return f.attempts[id], nil
}
func (f *emailQueueFake) PrepareAttempt(_ context.Context, j *models.EmailDeliveryJob, p models.EmailDeliveryPayload, now time.Time) (*models.EmailDeliveryAttempt, error) {
	if f.attempts == nil {
		f.attempts = map[string]*models.EmailDeliveryAttempt{}
	}
	a := &models.EmailDeliveryAttempt{Key: "hichat-email/" + j.ID, Payload: p, FirstAttemptMS: now.UnixMilli(), Outcome: "prepared"}
	f.attempts[j.ID] = a
	return a, nil
}
func (f *emailQueueFake) FinishAttempt(ctx context.Context, j *models.EmailDeliveryJob, provider, outcome string, now time.Time) error {
	if outcome == "delivered" {
		if err := f.MarkDelivered(ctx, j.ID, j.ClaimToken, now); err != nil {
			return err
		}
	}
	f.attempts[j.ID].ProviderID = provider
	f.attempts[j.ID].Outcome = outcome
	return nil
}

func (f categorySenderFake) CategoryFrom() string { return "HiChat <from@example.test>" }
func (f categorySenderFake) SendPreparedCategoryEmail(ctx context.Context, key string, p models.EmailDeliveryPayload) (string, error) {
	return "provider-id", f.SendCategoryEmail(ctx, p.To, p.Subject, p.HTML)
}

func (f *recordingCategorySender) CategoryFrom() string { return "HiChat <from@example.test>" }
func (f *recordingCategorySender) SendPreparedCategoryEmail(ctx context.Context, key string, p models.EmailDeliveryPayload) (string, error) {
	return "provider-id", f.SendCategoryEmail(ctx, p.To, p.Subject, p.HTML)
}

func (f *deadlineCategorySender) CategoryFrom() string { return "HiChat <from@example.test>" }
func (f *deadlineCategorySender) SendPreparedCategoryEmail(ctx context.Context, key string, p models.EmailDeliveryPayload) (string, error) {
	return "provider-id", f.SendCategoryEmail(ctx, p.To, p.Subject, p.HTML)
}

func TestEmailDeliveryRetriesFrozenPayloadAfterLostResponseOrAck(t *testing.T) {
	for _, lostAck := range []bool{false, true} {
		t.Run(fmt.Sprint(lostAck), func(t *testing.T) {
			job := models.EmailDeliveryJob{ID: "immutable", UserID: "user", Category: models.EmailCategoryCommunication, Address: "user@example.test", Subject: "original", BodyHTML: "body", DMMessageID: "dm", DMUnreadCount: 2, Attempts: 1}
			q := &emailQueueFake{jobs: []models.EmailDeliveryJob{job}}
			sender := &recordingCategorySender{}
			unsub := &emailUnsubscribeFake{token: "first-proof"}
			if lostAck {
				q.markErr = errors.New("database unavailable")
			} else {
				sender.err = errors.New("response lost")
			}
			svc := NewEmailDeliveryService(q, sender, WithEmailUnsubscribe(unsub, "https://example.test"))
			_, _ = svc.DeliverBatch(context.Background(), time.Now())
			first := *q.attempts[job.ID]
			if first.Outcome != "prepared" {
				t.Fatal("ambiguous attempt retired")
			}
			job.Subject = "changed"
			job.BodyHTML = "changed"
			job.DMUnreadCount = 9
			job.Attempts = 2
			q.jobs = []models.EmailDeliveryJob{job}
			q.markErr = nil
			sender.err = nil
			unsub.token = "second-proof"
			done, err := svc.DeliverBatch(context.Background(), time.Now())
			if err != nil || done != 1 {
				t.Fatalf("retry: %d %v", done, err)
			}
			after := q.attempts[job.ID]
			if after.Payload != first.Payload || after.Key != first.Key || after.FirstAttemptMS != first.FirstAttemptMS || unsub.calls != 1 || sender.body != first.Payload.HTML || after.ProviderID != "provider-id" {
				t.Fatal("retry changed persisted send")
			}
		})
	}
}
func TestEmailDeliveryExpiredIdempotencyAndMismatchNeverRetry(t *testing.T) {
	for _, expired := range []bool{false, true} {
		t.Run(fmt.Sprint(expired), func(t *testing.T) {
			job := models.EmailDeliveryJob{ID: "job", Address: "to@example.test", Attempts: 2}
			attempt := &models.EmailDeliveryAttempt{Key: "key", Outcome: "prepared", Payload: models.EmailDeliveryPayload{To: job.Address}, FirstAttemptMS: time.Now().UnixMilli()}
			if expired {
				attempt.FirstAttemptMS = time.Now().Add(-24 * time.Hour).UnixMilli()
			}
			q := &emailQueueFake{jobs: []models.EmailDeliveryJob{job}, attempts: map[string]*models.EmailDeliveryAttempt{"job": attempt}}
			sender := &recordingCategorySender{err: email.ErrImmutableEmailPayload}
			done, err := NewEmailDeliveryService(q, sender).DeliverBatch(context.Background(), time.Now())
			expected, sends := "failed", 1
			if expired {
				expected, sends = "review", 0
			}
			if err != nil || done != 0 || sender.sends != sends || q.retried != 0 || attempt.Outcome != expected {
				t.Fatalf("outcome %s sends %d err %v", attempt.Outcome, sender.sends, err)
			}
		})
	}
}
