package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/models"
)

type emailCampaignHandlerStub struct {
	createdBy string
	request   *models.CreateEmailCampaignRequest
	calls     int
}

func (s *emailCampaignHandlerStub) CreateDraft(_ context.Context, admin string, request *models.CreateEmailCampaignRequest) (*models.EmailCampaign, error) {
	s.calls++
	s.createdBy, s.request = admin, request
	return &models.EmailCampaign{ID: "ec_0123456789abcdef0123456789abcdef", Status: "draft"}, nil
}

func (s *emailCampaignHandlerStub) Preview(context.Context, string) (*models.EmailCampaignPreview, error) {
	s.calls++
	return &models.EmailCampaignPreview{EligibleRecipients: 4}, nil
}

func (s *emailCampaignHandlerStub) Publish(_ context.Context, admin, id string) (*models.EmailCampaign, error) {
	s.calls++
	return &models.EmailCampaign{ID: id, Status: "published", PublishedBy: &admin}, nil
}

func emailCampaignRequest(method, path, body string, authenticated bool) *http.Request {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	if authenticated {
		request = request.WithContext(context.WithValue(request.Context(), UserContextKey, &models.User{ID: "platform-admin"}))
	}
	return request
}

func TestEmailCampaignHandlerRequiresAuthenticatedActorAndStrictDraftJSON(t *testing.T) {
	service := &emailCampaignHandlerStub{}
	handler := NewEmailCampaignHandler(service)

	unauthenticated := httptest.NewRecorder()
	handler.CreateDraft(unauthenticated, emailCampaignRequest(http.MethodPost, "/api/admin/email-campaigns", `{"category":"tips"}`, false))
	if unauthenticated.Code != http.StatusUnauthorized || service.calls != 0 {
		t.Fatalf("unauthenticated create status=%d calls=%d", unauthenticated.Code, service.calls)
	}

	unknownField := httptest.NewRecorder()
	handler.CreateDraft(unknownField, emailCampaignRequest(http.MethodPost, "/api/admin/email-campaigns", `{"category":"tips","unexpected":"value"}`, true))
	if unknownField.Code != http.StatusBadRequest || service.calls != 0 {
		t.Fatalf("unknown-field create status=%d calls=%d", unknownField.Code, service.calls)
	}

	valid := httptest.NewRecorder()
	handler.CreateDraft(valid, emailCampaignRequest(http.MethodPost, "/api/admin/email-campaigns", `{"category":"tips","subject":"Hello","body":"Plain text","expires_at":"2026-11-01T00:00:00Z"}`, true))
	if valid.Code != http.StatusCreated || service.calls != 1 || service.createdBy != "platform-admin" {
		t.Fatalf("valid create status=%d calls=%d actor=%q body=%s", valid.Code, service.calls, service.createdBy, valid.Body.String())
	}
	if service.request == nil || service.request.Body != "Plain text" {
		t.Fatalf("draft request was not decoded: %#v", service.request)
	}

	unicodeBody := strings.Repeat("ğ", models.EmailCampaignMaxBodyRunes)
	largeValidJSON := `{"category":"tips","subject":"Hello","body":"` + unicodeBody + `","expires_at":"2026-11-01T00:00:00Z"}`
	largeValid := httptest.NewRecorder()
	handler.CreateDraft(largeValid, emailCampaignRequest(http.MethodPost, "/api/admin/email-campaigns", largeValidJSON, true))
	if largeValid.Code != http.StatusCreated || service.calls != 2 {
		t.Fatalf("max-rune Unicode create status=%d calls=%d body_bytes=%d", largeValid.Code, service.calls, len(largeValidJSON))
	}

	oversizedBody := strings.Repeat("x", emailCampaignRequestMaxBytes)
	oversizedJSON := `{"category":"tips","subject":"Hello","body":"` + oversizedBody + `","expires_at":"2026-11-01T00:00:00Z"}`
	oversized := httptest.NewRecorder()
	handler.CreateDraft(oversized, emailCampaignRequest(http.MethodPost, "/api/admin/email-campaigns", oversizedJSON, true))
	if oversized.Code != http.StatusRequestEntityTooLarge || service.calls != 2 {
		t.Fatalf("oversized create status=%d calls=%d body_bytes=%d", oversized.Code, service.calls, len(oversizedJSON))
	}
}

func TestEmailCampaignHandlerValidatesCampaignIDBeforeCallingService(t *testing.T) {
	service := &emailCampaignHandlerStub{}
	handler := NewEmailCampaignHandler(service)
	request := emailCampaignRequest(http.MethodGet, "/api/admin/email-campaigns/not-an-id", "", true)
	request.SetPathValue("id", "not-an-id")
	response := httptest.NewRecorder()
	handler.Preview(response, request)
	if response.Code != http.StatusBadRequest || service.calls != 0 {
		t.Fatalf("invalid ID status=%d calls=%d", response.Code, service.calls)
	}
}
