package main

import (
	"bytes"
	"context"
	_ "embed" // Embeds the fixed diagnostic script into the server binary.
	"encoding/json"
	"io"
	"math"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Temporary, fixed-target diagnostics for the Space runtime, never a request
// endpoint or a readiness dependency. Remove together with the bootstrap hook.
//
//go:embed music_network_probe.py
var musicNetworkProbeScript string

var musicNetworkProbeOnce sync.Once
var musicProbeVersionPattern = regexp.MustCompile(`^[A-Za-z0-9.+_ ()/-]{1,96}$`)

type musicProbeOutput struct {
	buf      bytes.Buffer
	overflow bool
}

func (b *musicProbeOutput) Len() int      { return b.buf.Len() }
func (b *musicProbeOutput) Bytes() []byte { return b.buf.Bytes() }

func (b *musicProbeOutput) Write(p []byte) (int, error) {
	if len(p) > (16<<10)-b.Len() {
		b.overflow = true
		return 0, io.ErrShortBuffer
	}
	return b.buf.Write(p)
}

type musicProbeReport struct {
	Inventory struct {
		Python       string            `json:"python"`
		OpenSSL      string            `json:"openssl"`
		YTDLP        string            `json:"yt_dlp"`
		Handlers     []string          `json:"handlers"`
		Packages     map[string]string `json:"packages"`
		ProxyPresent bool              `json:"proxy_present"`
	} `json:"inventory"`
	Probes []musicProbeResult `json:"probes"`
}

type musicProbeResult struct {
	Target   string  `json:"target"`
	Family   string  `json:"family"`
	Outcome  string  `json:"outcome"`
	ExitCode int     `json:"exit_code"`
	HTTPCode int     `json:"http_code"`
	DNS      float64 `json:"dns_ms"`
	TCP      float64 `json:"tcp_ms"`
	TLS      float64 `json:"tls_ms"`
	Total    float64 `json:"total_ms"`
}

func startMusicNetworkProbe() {
	if !isHFSpace() {
		return
	}
	musicNetworkProbeOnce.Do(func() { go runMusicNetworkProbe() })
}

func runMusicNetworkProbe() {
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/usr/bin/python3", "-") // #nosec G204 -- fixed executable/arguments and trusted embedded script; no shell or request input
	cmd.Stdin = strings.NewReader(musicNetworkProbeScript)
	output := &musicProbeOutput{}
	cmd.Stdout, cmd.Stderr = output, io.Discard
	cmd.WaitDelay = 500 * time.Millisecond
	err := cmd.Run()
	if err != nil || output.overflow {
		bootLogger.Warn("temporary music network probe incomplete", "deadline", ctx.Err() != nil, "output_limit", output.overflow)
		return
	}
	var report musicProbeReport
	if json.Unmarshal(output.Bytes(), &report) != nil {
		bootLogger.Warn("temporary music network probe invalid output")
		return
	}
	var handlers []string
	for _, handler := range report.Inventory.Handlers {
		switch handler {
		case "Urllib", "Requests", "CurlCFFI", "Websockets":
			handlers = append(handlers, handler)
		}
	}
	bootLogger.Info("temporary music network inventory",
		"python", musicProbeSafeVersion(report.Inventory.Python),
		"openssl", musicProbeSafeVersion(report.Inventory.OpenSSL),
		"yt_dlp", musicProbeSafeVersion(report.Inventory.YTDLP),
		"handlers", handlers, "proxy_present", report.Inventory.ProxyPresent)
	for _, name := range []string{"requests", "urllib3", "curl_cffi", "certifi"} {
		bootLogger.Info("temporary music network package", "package", name, "version", musicProbeSafeVersion(report.Inventory.Packages[name]))
	}
	seen := make(map[string]bool)
	for _, result := range report.Probes {
		key := result.Target + "/" + result.Family
		if !result.valid() || seen[key] {
			continue
		}
		seen[key] = true
		bootLogger.Info("temporary music network probe",
			"target", result.Target, "family", result.Family, "outcome", result.Outcome,
			"exit_code", result.ExitCode, "http_code", result.HTTPCode,
			"dns_ms", result.DNS, "tcp_ms", result.TCP, "tls_ms", result.TLS, "total_ms", result.Total)
	}
}

func musicProbeSafeVersion(value string) string {
	if !musicProbeVersionPattern.MatchString(value) {
		return "unavailable"
	}
	return value
}

func (r musicProbeResult) valid() bool {
	if r.Target != "youtube" && r.Target != "google" && r.Target != "huggingface" {
		return false
	}
	if r.Family != "default" && r.Family != "ipv4" {
		return false
	}
	if r.Outcome != "complete" && r.Outcome != "timeout" && r.Outcome != "unavailable" {
		return false
	}
	if r.ExitCode < 0 || r.ExitCode > 255 || r.HTTPCode < 0 || r.HTTPCode > 599 {
		return false
	}
	for _, value := range []float64{r.DNS, r.TCP, r.TLS, r.Total} {
		if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || value > 30000 {
			return false
		}
	}
	return true
}
