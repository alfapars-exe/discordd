package musicworker

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestWorkerKeepsCompletedStreamOpenUntilBrokerDrains(t *testing.T) {
	result := make(chan struct{})
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := workerUpgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		var msg wireMessage
		if conn.ReadJSON(&msg) != nil || msg.Type != "result" {
			return
		}
		close(result)
		<-release // Proxy has accepted the terminal frame, but downstream is paused.
	}))
	defer server.Close()
	defer close(release)
	_, endpoint, err := workerURLs(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		runJob(ctx, endpoint, testToken, "session", wireMessage{ID: "job", Request: &Request{Operation: OperationAudio, Input: "url"}}, func(context.Context, Request, io.Writer) error { return nil })
		close(done)
	}()
	select {
	case <-result:
	case <-time.After(time.Second):
		t.Fatal("terminal result missing")
	}
	select {
	case <-done:
		t.Fatal("worker closed before broker drained terminal result")
	case <-time.After(100 * time.Millisecond):
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("cancellation did not release completed stream")
	}
}
