package main

import (
	"io"
	"math"
	"strings"
	"testing"
)

func TestMusicProbeOutputBound(t *testing.T) {
	var output musicProbeOutput
	// io.Copy must use our capped Write, not embedded bytes.Buffer.ReadFrom.
	if _, ok := any(&output).(io.ReaderFrom); ok {
		t.Fatal("embedded ReaderFrom bypasses diagnostic output cap")
	}
	if _, err := output.Write([]byte(strings.Repeat("x", 16<<10))); err != nil {
		t.Fatal(err)
	}
	if _, err := output.Write([]byte("x")); err == nil || !output.overflow || output.Len() != 16<<10 {
		t.Fatal("diagnostic output exceeded its bound")
	}
}

func TestMusicProbeRejectsUnsafeFields(t *testing.T) {
	for _, value := range []string{"https://host/?token=secret", "version\nforged", strings.Repeat("x", 97)} {
		if musicProbeSafeVersion(value) != "unavailable" {
			t.Fatalf("unsafe inventory value accepted: %q", value)
		}
	}
	valid := musicProbeResult{Target: "youtube", Family: "ipv4", Outcome: "complete", HTTPCode: 204, TLS: 42}
	if !valid.valid() {
		t.Fatal("valid fixed-target probe rejected")
	}
	for _, mutate := range []func(*musicProbeResult){
		func(r *musicProbeResult) { r.Target = "https://secret.invalid" },
		func(r *musicProbeResult) { r.Family = "environment" },
		func(r *musicProbeResult) { r.Outcome = "raw error token=secret" },
		func(r *musicProbeResult) { r.TLS = math.Inf(1) },
		func(r *musicProbeResult) { r.TCP = -1 },
	} {
		item := valid
		mutate(&item)
		if item.valid() {
			t.Fatal("unsafe probe result accepted")
		}
	}
}
