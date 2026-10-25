package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/services"
)

type partialGroupService struct {
	services.GroupDMService
	sends, broadcasts int
	message           *models.GroupDMMessage
}

func (s *partialGroupService) SendMessage(_ context.Context, group, user string, req *models.CreateGroupDMMessageRequest) (*models.GroupDMMessage, error) {
	s.sends++
	s.message = &models.GroupDMMessage{ID: "saved", GroupID: group, UserID: user, Ciphertext: req.Ciphertext, Attachments: []models.GroupDMAttachment{}}
	return s.message, nil
}
func (s *partialGroupService) BroadcastMessage(_ context.Context, m *models.GroupDMMessage) error {
	s.broadcasts++
	return nil
}

type partialGroupUpload struct {
	services.GroupDMUploadService
	fail    map[int]bool
	indices []int
}

func (s *partialGroupUpload) Upload(_ context.Context, id string, _ multipart.File, header *multipart.FileHeader, index int) (*models.GroupDMAttachment, error) {
	s.indices = append(s.indices, index)
	if s.fail[index] {
		return nil, errors.New("disk unavailable")
	}
	return &models.GroupDMAttachment{ID: header.Filename, GroupMessageID: id, Filename: header.Filename, FileKeyIndex: &index}, nil
}
func TestGroupDMUploadPartialPreservesKeyIndicesAndCommittedMessage(t *testing.T) {
	for _, test := range []struct {
		name         string
		fail         map[int]bool
		status, want int
	}{{"first fails", map[int]bool{0: true}, 207, 1}, {"all fail", map[int]bool{0: true, 1: true}, 207, 0}, {"all succeed", nil, 201, 2}} {
		t.Run(test.name, func(t *testing.T) {
			var body bytes.Buffer
			writer := multipart.NewWriter(&body)
			for key, value := range map[string]string{"ciphertext": "cipher", "sender_device_id": "device", "e2ee_metadata": "{}", "key_epoch": "1"} {
				if err := writer.WriteField(key, value); err != nil {
					t.Fatal(err)
				}
			}
			for _, name := range []string{"encrypted_0.bin", "encrypted_1.bin"} {
				part, err := writer.CreateFormFile("files", name)
				if err != nil {
					t.Fatal(err)
				}
				if _, err = part.Write([]byte("ciphertext bytes")); err != nil {
					t.Fatal(err)
				}
			}
			if err := writer.Close(); err != nil {
				t.Fatal(err)
			}
			service := &partialGroupService{}
			upload := &partialGroupUpload{fail: test.fail}
			handler := &GroupDMHandler{service: service, upload: upload, maxUploadSize: 1 << 20}
			req := httptest.NewRequest(http.MethodPost, "/api/group-dms/group/messages", &body)
			req.Header.Set("Content-Type", writer.FormDataContentType())
			req.SetPathValue("groupId", "group")
			req = req.WithContext(context.WithValue(req.Context(), UserContextKey, &models.User{ID: "sender"}))
			response := httptest.NewRecorder()
			handler.SendMessage(response, req)
			if response.Code != test.status {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			if service.sends != 1 || service.broadcasts != 1 || len(service.message.Attachments) != test.want {
				t.Fatalf("sends=%d broadcasts=%d message=%+v", service.sends, service.broadcasts, service.message)
			}
			if len(upload.indices) != 2 || upload.indices[0] != 0 || upload.indices[1] != 1 {
				t.Fatal(upload.indices)
			}
			if test.want == 1 && (service.message.Attachments[0].FileKeyIndex == nil || *service.message.Attachments[0].FileKeyIndex != 1) {
				t.Fatal("successful second file lost original key index")
			}
			if test.status == 207 {
				var envelope struct {
					Success bool `json:"success"`
					Data    struct {
						Message  models.GroupDMMessage `json:"message"`
						Failures []struct {
							Index int `json:"file_key_index"`
						} `json:"upload_failures"`
					} `json:"data"`
				}
				if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
					t.Fatal(err)
				}
				if !envelope.Success || envelope.Data.Message.ID != "saved" || len(envelope.Data.Failures) != len(test.fail) || envelope.Data.Failures[0].Index != 0 {
					t.Fatalf("partial response=%+v", envelope)
				}
			}
		})
	}
}
