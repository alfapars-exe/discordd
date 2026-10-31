package email

import (
	"context"
	"errors"
	"github.com/argeinfina/hichat/models"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestPreparedCategoryEmailProviderContract(t *testing.T) {
	for _, mismatch := range []bool{false, true} {
		t.Run(map[bool]string{false: "success", true: "mismatch"}[mismatch], func(t *testing.T) {
			var bodies []string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Idempotency-Key") != "stable-key" {
					t.Error("missing stable key")
				}
				b, _ := io.ReadAll(r.Body)
				bodies = append(bodies, string(b))
				w.Header().Set("Content-Type", "application/json")
				if mismatch {
					w.WriteHeader(409)
					io.WriteString(w, `{"name":"invalid_idempotent_request","message":"private payload"}`)
				} else {
					io.WriteString(w, `{"id":"provider-id"}`)
				}
			}))
			defer server.Close()
			sender := NewResendSender("test-only", "from@example.test", "").(*resendSender)
			sender.client.BaseURL, _ = url.Parse(server.URL + "/")
			p := models.EmailDeliveryPayload{From: sender.CategoryFrom(), To: "to@example.test", Subject: "subject", HTML: "final"}
			for range 2 {
				id, err := sender.SendPreparedCategoryEmail(context.Background(), "stable-key", p)
				if mismatch {
					if !errors.Is(err, ErrImmutableEmailPayload) {
						t.Fatalf("expected permanent mismatch, got %v", err)
					}
				} else if err != nil || id != "provider-id" {
					t.Fatalf("receipt %s %v", id, err)
				}
			}
			if len(bodies) != 2 || bodies[0] != bodies[1] {
				t.Fatal("retry changed wire payload")
			}
		})
	}
}
