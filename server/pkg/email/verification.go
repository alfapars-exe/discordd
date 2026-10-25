package email

import (
	"context"
	"fmt"
	"html"
	"net/url"
	"strings"

	"github.com/resend/resend-go/v3"
)

type VerificationSender interface {
	SendEmailVerification(context.Context, string, string) error
}

func verificationLink(appURL, token string) (string, error) {
	u, err := url.Parse(appURL)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("invalid verification app URL")
	}
	if u.Scheme != "https" && (u.Scheme != "http" || (u.Hostname() != "localhost" && u.Hostname() != "127.0.0.1" && u.Hostname() != "::1")) {
		return "", fmt.Errorf("verification app URL requires HTTPS")
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/verify-email"
	u.RawPath = ""
	u.Fragment = "token=" + token
	return u.String(), nil
}
func (s *resendSender) SendEmailVerification(ctx context.Context, to, token string) error {
	link, err := verificationLink(s.appURL, token)
	if err != nil {
		return err
	}
	safe := html.EscapeString(link)
	body := fmt.Sprintf(`<!doctype html><html><head><meta charset="utf-8"></head><body><h1>HiChat</h1><h2>Verify your email address / E-posta adresini doğrula</h2><p>This single-use link expires in 20 minutes. / Bu tek kullanımlık bağlantı 20 dakika sonra sona erer.</p><p><a href="%s">Verify email / E-postayı doğrula</a></p><p>If you did not request this, ignore it. / Bu isteği sen yapmadıysan yok say.</p></body></html>`, safe)
	response, err := s.client.Emails.SendWithContext(ctx, &resend.SendEmailRequest{From: fmt.Sprintf("HiChat <%s>", s.fromEmail), To: []string{to}, Subject: "Verify email / E-posta doğrulama — HiChat", Html: body})
	if err != nil || response == nil || response.Id == "" {
		return fmt.Errorf("verification delivery was not confirmed")
	}
	return nil
}
