package handlers

import (
	"github.com/argeinfina/hichat/models"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDMIdempotentEndpointRejectsUnsafeRequestsBeforeService(t *testing.T) {
	h := NewDMHandler(nil, nil, 0, nil, nil)
	for _, tc := range []struct{ body, contentType string }{{`{"content":"missing key"}`, "application/json"}, {"", "multipart/form-data; boundary=fixture"}} {
		req := withUser(httptest.NewRequest(http.MethodPost, "/", strings.NewReader(tc.body)), &models.User{ID: "alice"})
		req.Header.Set("Content-Type", tc.contentType)
		req.SetPathValue("channelId", "dm")
		out := httptest.NewRecorder()
		h.SendIdempotentMessage(out, req)
		if out.Code != http.StatusBadRequest {
			t.Fatalf("unsafe request status=%d", out.Code)
		}
	}
}
