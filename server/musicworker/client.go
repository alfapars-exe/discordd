package musicworker

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"time"
)

// Execute sends a narrowly scoped request through the server's private Unix
// socket. Closing ctx or a failed output write closes the response body, which
// cancels the broker job and the remote subprocess.
func Execute(ctx context.Context, socketPath string, request Request, output io.Writer) error {
	transport := &http.Transport{
		Proxy:                  nil,
		DisableKeepAlives:      true,
		MaxResponseHeaderBytes: controlBytes,
		ResponseHeaderTimeout:  45 * time.Second,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "unix", socketPath)
		},
	}
	defer transport.CloseIdleConnections()
	return executeHTTP(ctx, &http.Client{Transport: transport}, "http://music-worker/run", request, output)
}

func executeHTTP(ctx context.Context, client *http.Client, endpoint string, request Request, output io.Writer) error {
	if err := request.validate(); err != nil {
		return err
	}
	payload, err := json.Marshal(request)
	if err != nil {
		return &Error{Code: "invalid_request"}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return &Error{Code: "network"}
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return &Error{Code: "network"}
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		var result Error
		if json.NewDecoder(io.LimitReader(resp.Body, 1024)).Decode(&result) != nil {
			return &Error{Code: "network"}
		}
		return &Error{Code: safeCode(result.Code)}
	}
	reader := io.Reader(resp.Body)
	if request.Operation != OperationAudio {
		reader = io.LimitReader(resp.Body, MaxMetadataBytes+1)
	}
	written, err := io.Copy(output, reader)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return &Error{Code: "network"}
	}
	if request.Operation != OperationAudio && written > MaxMetadataBytes {
		return &Error{Code: "output_limit"}
	}
	if code := resp.Trailer.Get(jobErrorTrailer); code != "" {
		return &Error{Code: safeCode(code)}
	}
	return nil
}
