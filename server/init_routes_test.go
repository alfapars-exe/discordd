package main

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// recordingRegistrar captures the ordered set of patterns passed to
// Handle/HandleFunc so a test can snapshot the full route table without a real
// *http.ServeMux. Go 1.22 patterns embed the method ("POST /api/..."), so the
// pattern string alone pins method + path + registration order.
type recordingRegistrar struct{ patterns []string }

func (r *recordingRegistrar) Handle(pattern string, _ http.Handler) {
	r.patterns = append(r.patterns, pattern)
}

func (r *recordingRegistrar) HandleFunc(pattern string, _ func(http.ResponseWriter, *http.Request)) {
	r.patterns = append(r.patterns, pattern)
}

// captureRoutes runs initRoutes against a recording registrar with nil
// dependencies. Registration only *takes* method values on the (nil) handler
// pointers in &Handlers{} — it never invokes them — and every middleware
// constructor initRoutes calls is nil-safe, so no dependency wiring is needed
// to enumerate the route table.
func captureRoutes() []string {
	rec := &recordingRegistrar{}
	initRoutes(rec, &Handlers{}, nil, nil, nil, nil, nil, nil)
	return rec.patterns
}

// TestInitRoutesGolden is the golden route-set net. The captured pattern list
// must match testdata/routes.golden exactly, locking the route table (method +
// path + order) so a later split of initRoutes into per-domain helpers is
// provably behaviour-diff-free. Regenerate the golden after an *intended*
// route change with: UPDATE_ROUTES_GOLDEN=1 go test -run TestInitRoutesGolden .
func TestInitRoutesGolden(t *testing.T) {
	got := strings.Join(captureRoutes(), "\n") + "\n"
	golden := filepath.Join("testdata", "routes.golden")

	if os.Getenv("UPDATE_ROUTES_GOLDEN") != "" {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatalf("mkdir testdata: %v", err)
		}
		if err := os.WriteFile(golden, []byte(got), 0o644); err != nil {
			t.Fatalf("write golden: %v", err)
		}
		t.Logf("wrote %d routes to %s", len(captureRoutes()), golden)
		return
	}

	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatalf("read golden (first run `UPDATE_ROUTES_GOLDEN=1 go test -run TestInitRoutesGolden .`): %v", err)
	}
	if got != string(want) {
		t.Errorf("route set drifted from testdata/routes.golden.\n"+
			"If the change is intentional, regenerate with "+
			"`UPDATE_ROUTES_GOLDEN=1 go test -run TestInitRoutesGolden .`.\n"+
			"--- got (%d routes) ---\n%s", len(captureRoutes()), got)
	}
}

// TestInitRoutesNoDuplicates guards against two handlers claiming the same
// pattern. A real *http.ServeMux panics on that at registration time, but the
// recording registrar does not, so assert uniqueness explicitly.
func TestInitRoutesNoDuplicates(t *testing.T) {
	patterns := captureRoutes()
	seen := make(map[string]bool, len(patterns))
	for _, p := range patterns {
		if seen[p] {
			t.Errorf("duplicate route pattern registered: %q", p)
		}
		seen[p] = true
	}
}
