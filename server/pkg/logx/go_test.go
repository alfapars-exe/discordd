package logx

import (
	"bytes"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"
)

// syncBuffer is a bytes.Buffer safe for concurrent Write (from logx.Go's
// goroutine) and read (from the test). A plain bytes.Buffer races here because
// Go recovers and logs in the background goroutine while the test polls buf.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// captureSlog swaps the default slog handler with one that records into a
// concurrency-safe buffer, mirroring pkg.captureSlog's pattern for
// pkg.ErrorCtx tests.
func captureSlog(t *testing.T) (*syncBuffer, func()) {
	t.Helper()
	buf := &syncBuffer{}
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(buf, &slog.HandlerOptions{Level: slog.LevelError})))
	return buf, func() { slog.SetDefault(prev) }
}

// TestGo_recoversPanicWithoutCrashing verifies a panicking fn does not take
// down the test process — if Go's recover failed, this whole binary would
// crash instead of reporting a test failure.
func TestGo_recoversPanicWithoutCrashing(t *testing.T) {
	buf, restore := captureSlog(t)
	defer restore()
	var wg sync.WaitGroup
	wg.Add(1)

	Go("test.panicker", func() {
		defer wg.Done()
		panic("boom")
	})

	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()

	select {
	case <-done:
		// fn's defer precedes the outer recovery. Wait for recovery logging too,
		// so this goroutine cannot write into the next test's default logger.
		waitForPanicLog(t, buf, "test.panicker", "boom")
	case <-time.After(2 * time.Second):
		t.Fatal("goroutine did not complete — panic recovery may have hung or crashed")
	}
}

// TestGo_logsComponentAndPanicValue verifies the recovered panic is surfaced
// via slog (reaching Sentry through pkg/logx/sentry.go's >= Error forwarding)
// with the component name and stack trace attached.
func TestGo_logsComponentAndPanicValue(t *testing.T) {
	buf, restore := captureSlog(t)
	defer restore()

	var wg sync.WaitGroup
	wg.Add(1)
	Go("test.component", func() {
		defer wg.Done()
		panic("kaboom")
	})
	wg.Wait()

	logLine := waitForPanicLog(t, buf, "test.component", "kaboom")
	if !strings.Contains(logLine, `"component":"test.component"`) {
		t.Errorf("log missing component: %s", logLine)
	}
	if !strings.Contains(logLine, "kaboom") {
		t.Errorf("log missing panic value: %s", logLine)
	}
	if !strings.Contains(logLine, `"stack"`) {
		t.Errorf("log missing stack trace: %s", logLine)
	}
}

func waitForPanicLog(t *testing.T, buf *syncBuffer, component, panicValue string) string {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		line := buf.String()
		if strings.Contains(line, `"component":"`+component+`"`) && strings.Contains(line, `"panic":"`+panicValue+`"`) {
			return line
		}
		if time.Now().After(deadline) {
			t.Fatalf("recovery log did not complete for %s: %s", component, line)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestGo_recoveryLogIsNotSatisfiedByAnotherGoroutine(t *testing.T) {
	buf, restore := captureSlog(t)
	defer restore()
	slog.Error("goroutine panic recovered", "component", "another.component", "panic", "another panic")
	Go("test.current", func() { panic("current panic") })
	line := waitForPanicLog(t, buf, "test.current", "current panic")
	if !strings.Contains(line, `"component":"test.current"`) || !strings.Contains(line, `"stack"`) {
		t.Fatalf("expected the current goroutine's completed recovery record: %s", line)
	}
}

// TestGo_noPanic_runsNormally verifies the non-panicking path just runs fn.
func TestGo_noPanic_runsNormally(t *testing.T) {
	done := make(chan struct{})
	Go("test.normal", func() {
		close(done)
	})

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("fn did not run")
	}
}
