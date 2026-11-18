package main

import (
	"os"
	"strings"
	"testing"
)

func TestHubRuntimeCompositionPrecedesCallbacksAndRun(t *testing.T) {
	data, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	source := string(data)
	bound := strings.Index(source, "if err := hub.ConfigureRuntime(")
	if bound < 0 || strings.Count(source, "hub.ConfigureRuntime(") != 1 {
		t.Fatal("production requires one validated Hub runtime composition")
	}
	for _, next := range []string{"registerHubCallbacks(hub,", "logx.Go(\"ws.hub_run\", hub.Run)"} {
		pos := strings.Index(source, next)
		if pos < bound {
			t.Fatalf("Hub runtime must be validated before %s", next)
		}
	}
}
