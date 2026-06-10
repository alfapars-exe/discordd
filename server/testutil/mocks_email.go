package testutil

import (
	"context"
)

// ─── EmailSender mock ───

type MockEmailSender struct {
	SendPasswordResetFn             func(ctx context.Context, toEmail, token string) error
	SendPlatformBanNotificationFn   func(ctx context.Context, toEmail, reason string) error
	SendAccountDeleteNotificationFn func(ctx context.Context, toEmail, reason string) error
	SendServerDeleteNotificationFn  func(ctx context.Context, toEmail, serverName, reason string) error
	SendDiagnosticsReportFn         func(ctx context.Context, toEmail, reporter, description, filename string, attachment []byte) error
}

func (m *MockEmailSender) SendPasswordReset(ctx context.Context, toEmail, token string) error {
	if m.SendPasswordResetFn != nil {
		return m.SendPasswordResetFn(ctx, toEmail, token)
	}
	return nil
}
func (m *MockEmailSender) SendPlatformBanNotification(ctx context.Context, toEmail, reason string) error {
	if m.SendPlatformBanNotificationFn != nil {
		return m.SendPlatformBanNotificationFn(ctx, toEmail, reason)
	}
	return nil
}
func (m *MockEmailSender) SendAccountDeleteNotification(ctx context.Context, toEmail, reason string) error {
	if m.SendAccountDeleteNotificationFn != nil {
		return m.SendAccountDeleteNotificationFn(ctx, toEmail, reason)
	}
	return nil
}
func (m *MockEmailSender) SendServerDeleteNotification(ctx context.Context, toEmail, serverName, reason string) error {
	if m.SendServerDeleteNotificationFn != nil {
		return m.SendServerDeleteNotificationFn(ctx, toEmail, serverName, reason)
	}
	return nil
}
func (m *MockEmailSender) SendDiagnosticsReport(ctx context.Context, toEmail, reporter, description, filename string, attachment []byte) error {
	if m.SendDiagnosticsReportFn != nil {
		return m.SendDiagnosticsReportFn(ctx, toEmail, reporter, description, filename, attachment)
	}
	return nil
}
