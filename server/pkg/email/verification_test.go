package email

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/resend/resend-go/v3"
)

func TestVerificationLinkUsesSecretFragmentAndSafeOrigin(t *testing.T) {
	link, err := verificationLink("https://chat.example/app/", strings.Repeat("a", 64))
	if err != nil || !strings.HasPrefix(link, "https://chat.example/app/verify-email#token=") || strings.Contains(link, "?token=") {
		t.Fatalf("link %s %v", link, err)
	}
	for _, base := range []string{"javascript:alert(1)", "http://public.example", "https://user:pass@chat.example", "https://chat.example?next=bad", "https://chat.example/#bad", "not a URL"} {
		if _, err := verificationLink(base, "proof"); err == nil {
			t.Fatalf("unsafe configured origin %s", base)
		}
	}
	if _, err := verificationLink("http://127.0.0.1:3131", "proof"); err != nil {
		t.Fatal("local fixture URL refused", err)
	}
}

func TestVerificationSenderRequiresProviderAcknowledgement(t *testing.T) {
	for _, ack := range []string{`{"id":"local-fixture-acceptance"}`, `{}`} {
		t.Run(ack, func(t *testing.T) {
			var mail struct {
				To      []string `json:"to"`
				Html    string   `json:"html"`
				Subject string   `json:"subject"`
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "POST" {
					t.Error("wrong provider method")
				}
				if err := json.NewDecoder(r.Body).Decode(&mail); err != nil {
					t.Error(err)
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(ack))
			}))
			defer server.Close()
			client := resend.NewCustomClient(server.Client(), "test-only-not-a-real-key")
			client.BaseURL, _ = url.Parse(server.URL + "/")
			sender := &resendSender{client: client, fromEmail: "sender@example.invalid", appURL: "https://chat.example"}
			proof := strings.Repeat("a", 64)
			err := sender.SendEmailVerification(context.Background(), "recipient@example.invalid", proof)
			if (err == nil) != (ack != "{}") {
				t.Fatalf("provider acknowledgement %s: %v", ack, err)
			}
			if len(mail.To) != 1 || mail.To[0] != "recipient@example.invalid" || !strings.Contains(mail.Subject, "HiChat") || !strings.Contains(mail.Html, "/verify-email#token="+proof) || strings.Contains(mail.Html, "?token=") {
				t.Fatal("wrong verification mail")
			}
		})
	}
}
