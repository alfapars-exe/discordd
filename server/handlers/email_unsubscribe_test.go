package handlers

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/repository"
)

type emailUnsubscribeRepoFake struct {
	state        repository.EmailUnsubscribeTokenState
	inspectErr   error
	consumeErr   error
	inspectCalls int
	consumeCalls int
	inspectToken string
	consumeToken string
}

func (f *emailUnsubscribeRepoFake) Issue(context.Context, string, string, time.Time) (string, error) {
	return "", nil
}

func (f *emailUnsubscribeRepoFake) IssueForAddress(context.Context, string, string, string, time.Time) (string, error) {
	return "", nil
}

func (f *emailUnsubscribeRepoFake) Inspect(_ context.Context, token string, _ time.Time) (repository.EmailUnsubscribeTokenState, error) {
	f.inspectCalls++
	f.inspectToken = token
	return f.state, f.inspectErr
}

func (f *emailUnsubscribeRepoFake) Consume(_ context.Context, token string, _ time.Time) error {
	f.consumeCalls++
	f.consumeToken = token
	return f.consumeErr
}

const validUnsubscribeToken = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

func TestEmailUnsubscribeGetOnlyInspectsAndRendersConfirmation(t *testing.T) {
	repo := &emailUnsubscribeRepoFake{state: repository.EmailUnsubscribeTokenState{Category: "social"}}
	h := NewEmailUnsubscribeHandler(repo, nil)
	r := httptest.NewRequest(http.MethodGet, "/api/email/unsubscribe?token="+validUnsubscribeToken, nil)
	w := httptest.NewRecorder()
	h.Confirm(w, r)
	if w.Code != http.StatusOK || repo.inspectCalls != 1 || repo.consumeCalls != 0 {
		t.Fatalf("GET status=%d inspect=%d consume=%d", w.Code, repo.inspectCalls, repo.consumeCalls)
	}
	body := w.Body.String()
	if !strings.Contains(body, "Confirm that you want to unsubscribe from social emails") || !strings.Contains(body, `name="token" value="`+validUnsubscribeToken+`"`) {
		t.Fatalf("confirmation page missing expected content: %s", body)
	}
	if strings.Contains(body, `action="/api/email/unsubscribe?token=`) {
		t.Fatal("token was included in confirmation form action")
	}
	if repo.inspectToken != validUnsubscribeToken {
		t.Fatalf("Inspect token=%q", repo.inspectToken)
	}
	assertEmailUnsubscribeHeaders(t, w)
}

func TestEmailUnsubscribeGetConsumedHasNoConfirmationForm(t *testing.T) {
	repo := &emailUnsubscribeRepoFake{state: repository.EmailUnsubscribeTokenState{Category: "social", Consumed: true}}
	w := httptest.NewRecorder()
	NewEmailUnsubscribeHandler(repo, nil).Confirm(w, httptest.NewRequest(http.MethodGet, "/api/email/unsubscribe?token="+validUnsubscribeToken, nil))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "already been used") || strings.Contains(w.Body.String(), "<form") {
		t.Fatalf("consumed page status=%d body=%s", w.Code, w.Body.String())
	}
	if repo.consumeCalls != 0 {
		t.Fatal("GET mutated token")
	}
}

func TestEmailUnsubscribeGetRejectsDuplicateQueryTokens(t *testing.T) {
	repo := &emailUnsubscribeRepoFake{}
	w := httptest.NewRecorder()
	target := "/api/email/unsubscribe?token=" + validUnsubscribeToken + "&token=" + validUnsubscribeToken
	NewEmailUnsubscribeHandler(repo, nil).Confirm(w, httptest.NewRequest(http.MethodGet, target, nil))
	if w.Code != http.StatusBadRequest || repo.inspectCalls != 0 {
		t.Fatalf("duplicate query status=%d inspect=%d", w.Code, repo.inspectCalls)
	}
}

func TestEmailUnsubscribePostRequiresOneBoundedFormTokenAndIsIdempotent(t *testing.T) {
	repo := &emailUnsubscribeRepoFake{}
	h := NewEmailUnsubscribeHandler(repo, nil)
	values := url.Values{"token": {validUnsubscribeToken}}
	r := httptest.NewRequest(http.MethodPost, "/api/email/unsubscribe", strings.NewReader(values.Encode()))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	w := httptest.NewRecorder()
	h.Unsubscribe(w, r)
	if w.Code != http.StatusOK || repo.consumeCalls != 1 || repo.consumeToken != validUnsubscribeToken || !strings.Contains(w.Body.String(), "preference has been updated") {
		t.Fatalf("POST status=%d calls=%d token=%q body=%s", w.Code, repo.consumeCalls, repo.consumeToken, w.Body.String())
	}
	assertEmailUnsubscribeHeaders(t, w)

	// A repeated valid POST is accepted by the repository's idempotent consume
	// contract and has the same generic success page.
	w = httptest.NewRecorder()
	h.Unsubscribe(w, httptest.NewRequest(http.MethodPost, "/api/email/unsubscribe", strings.NewReader(values.Encode())))
	if w.Code != http.StatusBadRequest {
		t.Fatal("POST without form content type should fail")
	}
	r = httptest.NewRequest(http.MethodPost, "/api/email/unsubscribe", strings.NewReader(values.Encode()))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	w = httptest.NewRecorder()
	h.Unsubscribe(w, r)
	if w.Code != http.StatusOK || repo.consumeCalls != 2 {
		t.Fatalf("repeat POST status=%d calls=%d", w.Code, repo.consumeCalls)
	}
}

func TestEmailUnsubscribePostRejectsQueryOnlyDuplicateAndOversizedTokens(t *testing.T) {
	repo := &emailUnsubscribeRepoFake{}
	h := NewEmailUnsubscribeHandler(repo, nil)
	post := func(target, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, target, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		w := httptest.NewRecorder()
		h.Unsubscribe(w, r)
		return w
	}
	if w := post("/api/email/unsubscribe?token="+validUnsubscribeToken, ""); w.Code != http.StatusBadRequest {
		t.Fatalf("query-only token status=%d", w.Code)
	}
	if w := post("/api/email/unsubscribe", "token="+validUnsubscribeToken+"&token="+validUnsubscribeToken); w.Code != http.StatusBadRequest {
		t.Fatalf("duplicate token status=%d", w.Code)
	}
	if w := post("/api/email/unsubscribe", "token="+validUnsubscribeToken+"&extra="+strings.Repeat("a", int(maxEmailUnsubscribeFormBytes))); w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized body status=%d", w.Code)
	}
	if repo.consumeCalls != 0 {
		t.Fatalf("invalid forms called consume %d times", repo.consumeCalls)
	}
}

func TestEmailUnsubscribeInvalidAndInternalErrorsAreGeneric(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		want int
	}{
		{name: "invalid", err: repository.ErrEmailUnsubscribeInvalid, want: http.StatusBadRequest},
		{name: "internal", err: errors.New("database failure for user hidden@example.test"), want: http.StatusServiceUnavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repo := &emailUnsubscribeRepoFake{inspectErr: tc.err}
			w := httptest.NewRecorder()
			NewEmailUnsubscribeHandler(repo, nil).Confirm(w, httptest.NewRequest(http.MethodGet, "/api/email/unsubscribe?token="+validUnsubscribeToken, nil))
			if w.Code != tc.want || strings.Contains(w.Body.String(), "hidden@example.test") || strings.Contains(w.Body.String(), "database failure") {
				t.Fatalf("status=%d body=%q", w.Code, w.Body.String())
			}
			assertEmailUnsubscribeHeaders(t, w)
		})
	}
	for _, tc := range []struct {
		name string
		err  error
		want int
	}{
		{name: "invalid", err: repository.ErrEmailUnsubscribeInvalid, want: http.StatusBadRequest},
		{name: "internal", err: errors.New("database failure for user hidden@example.test"), want: http.StatusServiceUnavailable},
	} {
		t.Run("post_"+tc.name, func(t *testing.T) {
			repo := &emailUnsubscribeRepoFake{consumeErr: tc.err}
			r := httptest.NewRequest(http.MethodPost, "/api/email/unsubscribe", strings.NewReader("token="+validUnsubscribeToken))
			r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
			w := httptest.NewRecorder()
			NewEmailUnsubscribeHandler(repo, nil).Unsubscribe(w, r)
			if w.Code != tc.want || strings.Contains(w.Body.String(), "hidden@example.test") || strings.Contains(w.Body.String(), "database failure") {
				t.Fatalf("status=%d body=%q", w.Code, w.Body.String())
			}
			assertEmailUnsubscribeHeaders(t, w)
		})
	}
}

func TestEmailUnsubscribeEscapesCategoryAndSetsHeaders(t *testing.T) {
	repo := &emailUnsubscribeRepoFake{state: repository.EmailUnsubscribeTokenState{Category: `<script>alert(1)</script>`}}
	w := httptest.NewRecorder()
	NewEmailUnsubscribeHandler(repo, nil).Confirm(w, httptest.NewRequest(http.MethodGet, "/api/email/unsubscribe?token="+validUnsubscribeToken, nil))
	if w.Code != http.StatusOK || strings.Contains(w.Body.String(), "<script>") || !strings.Contains(w.Body.String(), "&lt;script&gt;") {
		t.Fatalf("category was not escaped: %s", w.Body.String())
	}
	assertEmailUnsubscribeHeaders(t, w)
}

func assertEmailUnsubscribeHeaders(t *testing.T, w *httptest.ResponseRecorder) {
	t.Helper()
	for key, want := range map[string]string{
		"Cache-Control":           "no-store",
		"Referrer-Policy":         "no-referrer",
		"Content-Security-Policy": "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
		"X-Content-Type-Options":  "nosniff",
		"X-Frame-Options":         "DENY",
	} {
		if got := w.Header().Get(key); got != want {
			t.Errorf("%s=%q want %q", key, got, want)
		}
	}
}
