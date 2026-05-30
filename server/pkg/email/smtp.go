package email

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"mime"
	"net/smtp"
)

// SMTPConfig — minimal config to send one email with an attachment via SMTP.
// Used for the diagnostics-report path (Gmail). Distinct from the Resend-based
// EmailSender above, which is HTTP and has no attachment support.
type SMTPConfig struct {
	Host string
	Port int
	User string
	Pass string
	From string
	To   string
}

// b64lines wraps base64 at 76 chars per line (RFC 2045).
func b64lines(b []byte) string {
	enc := base64.StdEncoding.EncodeToString(b)
	var out bytes.Buffer
	for i := 0; i < len(enc); i += 76 {
		end := i + 76
		if end > len(enc) {
			end = len(enc)
		}
		out.WriteString(enc[i:end])
		out.WriteString("\r\n")
	}
	return out.String()
}

// SendDiagnosticsReport emails a diagnostics bundle to the admin via SMTP.
// net/smtp.SendMail upgrades to STARTTLS automatically when the server (e.g.
// Gmail smtp.gmail.com:587) advertises it, then authenticates and sends. The
// attachment is the gzipped bundle. A failed send is non-fatal for the caller
// — the report also archives via the feedback channel.
func SendDiagnosticsReport(c SMTPConfig, reporter, description, filename string, attachment []byte) error {
	from := c.From
	if from == "" {
		from = fmt.Sprintf("kariyerplatformu <%s>", c.User)
	}
	subject := fmt.Sprintf("[HiChat Tanılama] %s", reporter)
	body := fmt.Sprintf(
		"Yeni tanılama raporu.\r\n\r\nBildiren: %s\r\n\r\nAçıklama:\r\n%s\r\n\r\n(Log paketi ektedir.)\r\n",
		reporter, description,
	)

	const boundary = "hichat-diag-7f3a91c2"
	var msg bytes.Buffer
	fmt.Fprintf(&msg, "From: %s\r\n", from)
	fmt.Fprintf(&msg, "To: %s\r\n", c.To)
	fmt.Fprintf(&msg, "Subject: %s\r\n", mime.QEncoding.Encode("utf-8", subject))
	msg.WriteString("MIME-Version: 1.0\r\n")
	fmt.Fprintf(&msg, "Content-Type: multipart/mixed; boundary=\"%s\"\r\n\r\n", boundary)

	// Text part — base64 so UTF-8 survives 7-bit-only relays.
	fmt.Fprintf(&msg, "--%s\r\n", boundary)
	msg.WriteString("Content-Type: text/plain; charset=\"utf-8\"\r\n")
	msg.WriteString("Content-Transfer-Encoding: base64\r\n\r\n")
	msg.WriteString(b64lines([]byte(body)))

	// Attachment part — the gzipped diagnostics bundle.
	fmt.Fprintf(&msg, "--%s\r\n", boundary)
	fmt.Fprintf(&msg, "Content-Type: application/gzip; name=\"%s\"\r\n", filename)
	msg.WriteString("Content-Transfer-Encoding: base64\r\n")
	fmt.Fprintf(&msg, "Content-Disposition: attachment; filename=\"%s\"\r\n\r\n", filename)
	msg.WriteString(b64lines(attachment))
	fmt.Fprintf(&msg, "--%s--\r\n", boundary)

	addr := fmt.Sprintf("%s:%d", c.Host, c.Port)
	auth := smtp.PlainAuth("", c.User, c.Pass, c.Host)
	if err := smtp.SendMail(addr, auth, c.User, []string{c.To}, msg.Bytes()); err != nil {
		return fmt.Errorf("smtp send: %w", err)
	}
	return nil
}
