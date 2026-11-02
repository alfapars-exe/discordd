package handlers

import (
	"bytes"
	"context"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/services"
)

type dmMultipartService struct {
	services.DMService
	sends, broadcasts int
	forbidden         bool
	failSend          bool
}

func (s *dmMultipartService) GetMessages(context.Context, string, string, string, int) (*models.DMMessagePage, error) {
	if s.forbidden {
		return nil, pkg.ErrForbidden
	}
	return &models.DMMessagePage{}, nil
}
func (s *dmMultipartService) SendMessage(_ context.Context, _, _ string, req *models.CreateDMMessageRequest) (*models.DMMessage, error) {
	s.sends++
	if s.failSend {
		return nil, pkg.ErrInternal
	}
	if err := req.Validate(); err != nil {
		return nil, err
	}
	return &models.DMMessage{Attachments: req.StagedAttachments}, nil
}

func TestDMIdempotentMultipartRetainsBytesWhenCommitOutcomeIsUnknown(t *testing.T) {
	service := &dmMultipartService{failSend: true}
	upload := &dmMultipartStager{}
	handler := NewDMHandler(service, upload, 1024, nil, nil)
	body := new(bytes.Buffer)
	form := multipart.NewWriter(body)
	_ = form.WriteField("client_message_id", "multipart-request-0001")
	_ = form.WriteField("content", "hello")
	part, err := form.CreateFormFile("files", "file.txt")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write([]byte("abc"))
	_ = form.Close()
	request := withUser(httptest.NewRequest(http.MethodPost, "/", body), &models.User{ID: "alice"})
	request.SetPathValue("channelId", "dm")
	request.Header.Set("Content-Type", form.FormDataContentType())
	out := httptest.NewRecorder()
	handler.SendIdempotentMessage(out, request)
	if out.Code != 500 || upload.stages != 1 || upload.discarded != 0 || service.broadcasts != 0 {
		t.Fatalf("ambiguous outcome: status=%d stages=%d discarded=%d broadcasts=%d", out.Code, upload.stages, upload.discarded, service.broadcasts)
	}
}
func (s *dmMultipartService) BroadcastCreate(*models.DMMessage) { s.broadcasts++ }

type dmMultipartStager struct {
	services.DMUploadService
	stages, discarded int
	fail              bool
	uploads           int
}

func (s *dmMultipartStager) Upload(context.Context, string, multipart.File, *multipart.FileHeader, bool) (*models.DMAttachment, error) {
	s.uploads++
	return &models.DMAttachment{ID: "legacy"}, nil
}

func TestDMIdempotentMultipartKeepsLegacyIgnoredFormKeyContract(t *testing.T) {
	service := &dmMultipartService{}
	upload := &dmMultipartStager{}
	handler := NewDMHandler(service, upload, 1024, nil, nil)
	body := new(bytes.Buffer)
	form := multipart.NewWriter(body)
	_ = form.WriteField("client_message_id", "legacy-field")
	_ = form.WriteField("content", "hello")
	part, err := form.CreateFormFile("files", "file.txt")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write([]byte("abc"))
	_ = form.Close()
	request := withUser(httptest.NewRequest(http.MethodPost, "/", body), &models.User{ID: "alice"})
	request.SetPathValue("channelId", "dm")
	request.Header.Set("Content-Type", form.FormDataContentType())
	out := httptest.NewRecorder()
	handler.SendMessage(out, request)
	if out.Code != 201 || upload.uploads != 1 || upload.stages != 0 || service.sends != 1 {
		t.Fatalf("legacy status=%d uploads=%d stages=%d sends=%d", out.Code, upload.uploads, upload.stages, service.sends)
	}
}

func (s *dmMultipartStager) Stage(context.Context, multipart.File, *multipart.FileHeader, bool) (*models.DMAttachment, *models.DMUploadDigest, error) {
	s.stages++
	if s.fail && s.stages == 2 {
		return nil, nil, pkg.ErrBadRequest
	}
	return &models.DMAttachment{Filename: "file.txt"}, &models.DMUploadDigest{Filename: "file.txt", Size: 3, SHA256: "fixture"}, nil
}
func (s *dmMultipartStager) Discard(*models.DMAttachment) { s.discarded++ }
func TestDMIdempotentMultipartStagesBeforeSendAndRefusesPartialCommit(t *testing.T) {
	for _, tc := range []struct {
		name                             string
		fail, forbidden                  bool
		status, sends, stages, discarded int
	}{{"complete", false, false, 201, 1, 2, 2}, {"second-file-fails", true, false, 400, 0, 2, 1}, {"not-member", false, true, 403, 0, 0, 0}} {
		t.Run(tc.name, func(t *testing.T) {
			service := &dmMultipartService{forbidden: tc.forbidden}
			upload := &dmMultipartStager{fail: tc.fail}
			handler := NewDMHandler(service, upload, 1024, nil, nil)
			body := new(bytes.Buffer)
			form := multipart.NewWriter(body)
			_ = form.WriteField("client_message_id", "multipart-request-0001")
			_ = form.WriteField("content", "hello")
			for range 2 {
				part, err := form.CreateFormFile("files", "file.txt")
				if err != nil {
					t.Fatal(err)
				}
				_, _ = part.Write([]byte("abc"))
			}
			_ = form.Close()
			request := withUser(httptest.NewRequest(http.MethodPost, "/", body), &models.User{ID: "alice"})
			request.SetPathValue("channelId", "dm")
			request.Header.Set("Content-Type", form.FormDataContentType())
			out := httptest.NewRecorder()
			handler.SendIdempotentMessage(out, request)
			if out.Code != tc.status || service.sends != tc.sends || upload.stages != tc.stages || upload.discarded != tc.discarded || service.broadcasts != tc.sends {
				t.Fatalf("status=%d sends=%d stages=%d discarded=%d broadcasts=%d", out.Code, service.sends, upload.stages, upload.discarded, service.broadcasts)
			}
		})
	}
}
