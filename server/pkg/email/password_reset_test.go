package email

import (
	"context"
	"encoding/json"
	"github.com/resend/resend-go/v3"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestPasswordResetMailDelivery(t *testing.T) {
	for _, ack := range []string{`{"id":"accepted"}`, `{}`} {
		t.Run(ack, func(t *testing.T) {
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var mail resend.SendEmailRequest
				if err := json.NewDecoder(r.Body).Decode(&mail); err != nil {
					t.Error(err)
				}
				const link = "https://chat.example/app/reset-password?token=proof"
				if len(mail.To) != 1 || mail.To[0] != "reader@example.invalid" || strings.Count(mail.Html, `href="`+link+`"`) != 2 {
					t.Error("wrong recovery recipient or link")
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(ack))
			}))
			defer provider.Close()
			client := resend.NewCustomClient(provider.Client(), "fixture")
			client.BaseURL, _ = url.Parse(provider.URL + "/")
			sender := &resendSender{client: client, appURL: "https://chat.example/app/", fromEmail: "sender@example.invalid"}
			err := sender.SendPasswordReset(context.Background(), "reader@example.invalid", "proof")
			if (err == nil) != (ack != "{}") {
				t.Fatalf("unexpected delivery result: %v", err)
			}
		})
	}
}
