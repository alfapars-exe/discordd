package handlers

import (
	"context"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/testutil"
)

func TestDiagnosticsStopJoinsAcceptedEmail(t *testing.T) {
	entered, canceled, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	sender := &testutil.MockEmailSender{SendDiagnosticsReportFn: func(ctx context.Context, _, _, _, _ string, _ []byte) error {
		calls.Add(1)
		close(entered)
		<-ctx.Done()
		close(canceled)
		<-release
		return ctx.Err()
	}}
	h := NewDiagnosticsHandler(sender, "admin@example.com", &stubAppLog{}, 1<<20)
	owner, ok := any(h).(interface{ Stop() })
	if !ok {
		t.Fatal("diagnostics has no worker shutdown owner")
	}
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }); owner.Stop() })
	h.Report(httptest.NewRecorder(), newDiagnosticsRequest(t))
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("email did not start")
	}
	done := make(chan struct{})
	go func() { owner.Stop(); close(done) }()
	select {
	case <-canceled:
	case <-time.After(2 * time.Second):
		t.Fatal("Stop did not cancel accepted email")
	}
	secondDone := make(chan struct{})
	go func() { owner.Stop(); close(secondDone) }()
	select {
	case <-done:
		t.Fatal("Stop returned before email exit")
	case <-secondDone:
		t.Fatal("concurrent Stop returned before email exit")
	case <-time.After(25 * time.Millisecond):
	}
	once.Do(func() { close(release) })
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Stop did not join email")
	}
	select {
	case <-secondDone:
	case <-time.After(2 * time.Second):
		t.Fatal("concurrent Stop did not join email")
	}
	h.Report(httptest.NewRecorder(), newDiagnosticsRequest(t))
	owner.Stop()
	if calls.Load() != 1 {
		t.Fatalf("email admitted after stop: %d", calls.Load())
	}
}

type diagnosticsBlockedCompletionLog struct {
	*stubAppLog
	entered chan struct{}
	release chan struct{}
}

func (l *diagnosticsBlockedCompletionLog) Log(ctx context.Context, level models.LogLevel, category models.LogCategory, actor, server *string, message string, metadata map[string]string) {
	close(l.entered)
	<-l.release
	l.stubAppLog.Log(ctx, level, category, actor, server, message, metadata)
}

func TestDiagnosticsStopJoinsCompletionLog(t *testing.T) {
	entered := make(chan struct{})
	logs := &diagnosticsBlockedCompletionLog{stubAppLog: &stubAppLog{}, entered: make(chan struct{}), release: make(chan struct{})}
	sender := &testutil.MockEmailSender{SendDiagnosticsReportFn: func(ctx context.Context, _, _, _, _ string, _ []byte) error {
		close(entered)
		<-ctx.Done()
		return ctx.Err()
	}}
	h := NewDiagnosticsHandler(sender, "admin@example.com", logs, 1<<20)
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(logs.release) }); h.Stop() })
	h.Report(httptest.NewRecorder(), newDiagnosticsRequest(t))
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("email did not start")
	}
	done := make(chan struct{})
	go func() { h.Stop(); close(done) }()
	select {
	case <-logs.entered:
	case <-time.After(2 * time.Second):
		t.Fatal("completion log did not start")
	}
	select {
	case <-done:
		t.Fatal("Stop escaped completion logging")
	case <-time.After(25 * time.Millisecond):
	}
	once.Do(func() { close(logs.release) })
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("completion log did not join")
	}
	if logs.count("diagnostics_email_failed") != 1 {
		t.Fatal("cancellation completion was not logged exactly once")
	}
}
