package musicjs

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const testToken = "fixture-only-compute-token-0123456789abcdef"

func testClient(t *testing.T, server *httptest.Server) *Client {
	t.Helper()
	client, err := NewClient(server.URL, testToken)
	if err != nil {
		t.Fatal(err)
	}
	client.http.Transport = server.Client().Transport
	return client
}
func privateDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "hjs-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}
func await(t *testing.T, ch <-chan struct{}) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(3 * time.Second):
		t.Fatal("operation did not complete")
	}
}

func TestClientUsesFixedHTTPSAndNeverRedirectsOrUsesProxy(t *testing.T) {
	for _, endpoint := range []string{"http://example.com", "https://user:secret@example.com", "https://example.com/elsewhere", "https://example.com?secret=x"} {
		if _, err := NewClient(endpoint, testToken); err == nil {
			t.Fatal("invalid endpoint accepted")
		}
	}
	client, err := NewClient("https://example.com", testToken)
	if err != nil {
		t.Fatal(err)
	}
	if client.http.Transport.(*http.Transport).Proxy != nil || client.http.Timeout != 35*time.Second {
		t.Fatal("proxy or unbounded remote timeout")
	}
	var followed atomic.Bool
	destination := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { followed.Store(true); w.WriteHeader(http.StatusOK) }))
	defer destination.Close()
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL, http.StatusTemporaryRedirect)
	}))
	defer server.Close()
	request, _ := ParseRequest([]byte(fixtureJSON))
	_, err = testClient(t, server).solve(context.Background(), []byte(fixtureJSON), request)
	if err == nil || followed.Load() {
		t.Fatal("remote redirect followed")
	}
}

func TestBridgeSendsOnlyDataAndKeepsTokenInParent(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/solve" || r.Header.Get("Authorization") != "Bearer "+testToken || r.Header.Get(ProtocolHeader) != Protocol {
			t.Error("wrong solver request contract")
		}
		data, _ := io.ReadAll(r.Body)
		if string(data) != fixtureJSON || bytes.Contains(data, []byte(testToken)) {
			t.Error("bridge changed data or disclosed credential in body")
		}
		_, _ = io.WriteString(w, fixtureResult)
	}))
	defer server.Close()
	bridge, err := StartBridge(context.Background(), privateDir(t), testClient(t, server))
	if err != nil {
		t.Fatal(err)
	}
	defer bridge.Close()
	if runtime.GOOS != "windows" {
		info, err := os.Stat(bridge.Path)
		if err != nil || info.Mode().Perm() != 0600 {
			t.Fatal("socket is not private")
		}
	}
	var output bytes.Buffer
	if err := Execute(context.Background(), bridge.Path, []byte(fixtureJSON), &output); err != nil || output.String() != fixtureResult {
		t.Fatalf("bridge roundtrip failed: %v", err)
	}
	if bridge.Failure() != nil {
		t.Fatal("successful request recorded failure")
	}
	bridge.Close()
	if _, err := os.Stat(bridge.Path); !os.IsNotExist(err) {
		t.Fatal("job socket survived close")
	}
}

func TestBridgeParentAndCallerCancellationReachRemoteCompute(t *testing.T) {
	for _, cancelParent := range []bool{true, false} {
		t.Run(fmt.Sprint(cancelParent), func(t *testing.T) {
			entered, canceled := make(chan struct{}), make(chan struct{})
			server := httptest.NewTLSServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
				_, _ = io.Copy(io.Discard, r.Body)
				close(entered)
				<-r.Context().Done()
				close(canceled)
			}))
			defer server.Close()
			parent, stopParent := context.WithCancel(context.Background())
			defer stopParent()
			caller, stopCaller := context.WithCancel(context.Background())
			defer stopCaller()
			bridge, err := StartBridge(parent, privateDir(t), testClient(t, server))
			if err != nil {
				t.Fatal(err)
			}
			defer bridge.Close()
			done := make(chan error, 1)
			go func() { done <- Execute(caller, bridge.Path, []byte(fixtureJSON), io.Discard) }()
			await(t, entered)
			if cancelParent {
				stopParent()
			} else {
				stopCaller()
			}
			await(t, canceled)
			select {
			case err := <-done:
				if err == nil {
					t.Fatal("canceled solve succeeded")
				}
			case <-time.After(3 * time.Second):
				t.Fatal("canceled caller stuck")
			}
		})
	}
}

func TestRemoteFailuresAreBoundedAndSanitized(t *testing.T) {
	for _, tc := range []struct {
		status     int
		body, code string
	}{{401, `{"error":"unauthorized"}`, "unauthorized"}, {429, `{"error":"busy"}`, "busy"}, {504, `{"error":"timeout"}`, "timeout"}, {500, `{"error":"secret-value"}`, "network"}, {200, strings.Repeat("x", MaxOutputBytes+1), "output_limit"}} {
		t.Run(tc.code, func(t *testing.T) {
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, tc.body)
			}))
			defer server.Close()
			request, _ := ParseRequest([]byte(fixtureJSON))
			_, err := testClient(t, server).solve(context.Background(), []byte(fixtureJSON), request)
			if ErrorCode(err) != tc.code || strings.Contains(err.Error(), "secret") {
				t.Fatalf("wrong or unsafe compute error: %v", err)
			}
		})
	}
}

func TestPrivateBridgeRejectsOversizedBodyBeforeRemote(t *testing.T) {
	var called atomic.Bool
	server := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called.Store(true) }))
	defer server.Close()
	bridge, err := StartBridge(context.Background(), privateDir(t), testClient(t, server))
	if err != nil {
		t.Fatal(err)
	}
	defer bridge.Close()
	request := httptest.NewRequest(http.MethodPost, "http://private/solve", bytes.NewReader(make([]byte, MaxInputBytes+1)))
	response := httptest.NewRecorder()
	bridge.handle(response, request)
	if called.Load() || response.Code == http.StatusOK || ErrorCode(bridge.Failure()) != "payload_too_large" {
		t.Fatal("oversized body reached remote service")
	}
}

func TestCompiledShimRelaysPinnedEnvelopeThroughPrivateBridge(t *testing.T) {
	if testing.Short() {
		t.Skip("compiled shim integration")
	}
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		if string(data) != fixtureJSON || r.Header.Get("Authorization") != "Bearer "+testToken {
			t.Error("compiled shim contract changed")
		}
		_, _ = io.WriteString(w, fixtureResult)
	}))
	defer server.Close()
	bridge, err := StartBridge(context.Background(), privateDir(t), testClient(t, server))
	if err != nil {
		t.Fatal(err)
	}
	defer bridge.Close()
	bin := filepath.Join(t.TempDir(), "hichat-js-exec")
	if runtime.GOOS == "windows" {
		bin += ".exe"
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	build := exec.CommandContext(ctx, "go", "build", "-o", bin, "../cmd/hichat-js-exec")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build shim: %v %s", err, output)
	}
	cmd := exec.CommandContext(ctx, bin, denoRunArgs...)
	cmd.Env = []string{SocketEnvironment + "=" + bridge.Path}
	if runtime.GOOS == "windows" {
		cmd.Env = append(cmd.Env, "SystemRoot="+os.Getenv("SystemRoot"))
	}
	cmd.Stdin = bytes.NewReader(fixtureEnvelope(t, []byte(fixtureJSON)))
	var output, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &output, &stderr
	if err := cmd.Run(); err != nil || output.String() != fixtureResult || stderr.Len() != 0 {
		t.Fatalf("compiled shim failed: %v %s", err, stderr.String())
	}
}
