package main

import (
	"bytes"
	"os"
	"reflect"
	"runtime/pprof"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/pkg/ratelimit"
	"github.com/argeinfina/hichat/testutil"
)

func limiterWorkerCount(t *testing.T) int {
	t.Helper()
	var stacks bytes.Buffer
	if err := pprof.Lookup("goroutine").WriteTo(&stacks, 2); err != nil {
		t.Fatal(err)
	}
	return bytes.Count(stacks.Bytes(), []byte("created by github.com/argeinfina/hichat/pkg/ratelimit.New"))
}

func TestRateLimiterBundleOwnsEveryDeclaredWorker(t *testing.T) {
	var bundle RateLimiters
	owner, ok := any(&bundle).(interface{ Stop() })
	if !ok {
		t.Fatal("rate limiter bundle has no shutdown owner")
	}
	before := limiterWorkerCount(t)
	fields := reflect.ValueOf(&bundle).Elem()
	for i := 0; i < fields.NumField(); i++ {
		field := fields.Field(i)
		var value any
		switch field.Type() {
		case reflect.TypeOf((*ratelimit.LoginRateLimiter)(nil)):
			value = ratelimit.NewLoginRateLimiter(1, time.Hour)
		case reflect.TypeOf((*ratelimit.MessageRateLimiter)(nil)):
			value = ratelimit.NewMessageRateLimiter(1, time.Hour, 0)
		default:
			t.Fatalf("unclassified limiter field %s", fields.Type().Field(i).Name)
		}
		t.Cleanup(value.(interface{ Stop() }).Stop)
		field.Set(reflect.ValueOf(value))
	}
	if got := limiterWorkerCount(t); got != before+fields.NumField() {
		t.Fatalf("fixture started %d workers, want %d", got-before, fields.NumField())
	}
	owner.Stop()
	requireLimiterWorkerCount(t, before)
	owner.Stop()
	empty := &RateLimiters{}
	any(empty).(interface{ Stop() }).Stop()
	var absent *RateLimiters
	any(absent).(interface{ Stop() }).Stop()
}

func TestMainOwnsRateLimiterShutdownAfterAcquisition(t *testing.T) {
	data, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	source := string(data)
	acquisition := strings.Index(source, "svcs, limiters, metricsCollector := initServices(")
	cleanup := "defer limiters.Stop()"
	if acquisition < 0 || strings.Index(source, cleanup) < acquisition || strings.Count(source, cleanup) != 1 {
		t.Fatal("main lacks one owned rate limiter cleanup after acquisition")
	}
}

func requireLimiterWorkerCount(t *testing.T, want int) {
	t.Helper()
	testutil.AssertWorkerCount(t, want, func() int { return limiterWorkerCount(t) })
}
