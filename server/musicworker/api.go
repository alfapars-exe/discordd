// Package musicworker carries narrowly scoped media jobs over an outbound,
// authenticated worker connection. It never transports executable commands.
package musicworker

import (
	"context"
	"errors"
	"io"
	"strings"
	"time"
)

const (
	OperationMetadata = "metadata"
	OperationSearch   = "search"
	OperationAudio    = "audio"
	ControlPath       = "/api/internal/music-worker/control"
	JobPath           = "/api/internal/music-worker/job"
	MaxMetadataBytes  = 4 << 20
)

// Request is the complete worker instruction set. Input remains untrusted and
// must also pass the runner's provider/URL guard before starting a subprocess.
type Request struct {
	Operation   string `json:"operation"`
	Input       string `json:"input"`
	SeekSeconds int64  `json:"seek_seconds,omitempty"`
}

func (r Request) validate() error {
	if r.Operation != OperationMetadata && r.Operation != OperationSearch && r.Operation != OperationAudio {
		return &Error{Code: "invalid_request"}
	}
	if strings.TrimSpace(r.Input) == "" || len(r.Input) > 4096 || strings.ContainsAny(r.Input, "\x00\r\n") || r.SeekSeconds < 0 || r.SeekSeconds > 7*24*60*60 {
		return &Error{Code: "invalid_request"}
	}
	if r.Operation != OperationAudio && r.SeekSeconds != 0 {
		return &Error{Code: "invalid_request"}
	}
	return nil
}

// Error exposes only a fixed code; provider output and secrets never cross the
// transport. Unknown/untyped runner errors become "unknown".
type Error struct {
	Code string `json:"code"`
}

func (e *Error) Error() string { return "music worker: " + safeCode(e.Code) }

func safeCode(code string) string {
	switch code {
	case "forbidden", "bot_check", "unavailable", "age_restricted", "geo_blocked", "rate_limited", "network", "stalled", "tool_missing", "unknown", "offline", "busy", "canceled", "invalid_request", "output_limit":
		return code
	default:
		return "unknown"
	}
}

func errorCode(err error) string {
	if err == nil {
		return ""
	}
	if errors.Is(err, context.Canceled) {
		return "canceled"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "network"
	}
	var typed *Error
	if errors.As(err, &typed) {
		return safeCode(typed.Code)
	}
	return "unknown"
}

// Runner performs one validated media job and writes its metadata or media to
// output. It must terminate subprocesses when ctx is canceled and propagate
// output write failures. It must not return provider stderr in typed errors.
type Runner func(ctx context.Context, request Request, output io.Writer) error

type WorkerConfig struct {
	// Endpoint is the HF application origin (https://host). ws/http are accepted
	// only for literal loopback addresses to support local integration tests.
	Endpoint string
	Token    string
	// ReconnectDelay defaults to one second and is capped at one minute.
	ReconnectDelay time.Duration
}
