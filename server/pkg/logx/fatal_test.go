package logx

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/config"
)

func TestFatalProcessHelper(t *testing.T) {
	mode := os.Getenv("HICHAT_TEST_FATAL_MODE")
	if mode == "" {
		return
	}
	if mode != "before-init" {
		Init(config.LoggingConfig{Level: "error", Format: mode})
	}
	Fatal("boot-test", "fatal startup test", errors.New("permission denied; libsql://example?authToken=do-not-print&database=test"))
}

func TestFatalExitsWithVisibleRedactedError(t *testing.T) {
	for _, mode := range []string{"json", "text", "before-init"} {
		t.Run(mode, func(t *testing.T) {
			cmd := exec.Command(os.Args[0], "-test.run=^TestFatalProcessHelper$")
			cmd.Env = append(os.Environ(), "HICHAT_TEST_FATAL_MODE="+mode)
			output, err := cmd.CombinedOutput()
			var exit *exec.ExitError
			if !errors.As(err, &exit) || exit.ExitCode() != 1 {
				t.Fatalf("exit=%v output=%s", err, output)
			}
			text := string(output)
			if !strings.Contains(text, "fatal startup test") || !strings.Contains(text, "permission denied") || !strings.Contains(text, "boot-test") || strings.Contains(text, "do-not-print") {
				t.Fatalf("missing/redaction failure: %s", output)
			}
			if mode == "json" {
				var record map[string]any
				if err := json.Unmarshal(output, &record); err != nil {
					t.Fatal(err)
				}
				if record["level"] != "ERROR" || record["component"] != "boot-test" {
					t.Fatalf("wrong fatal record: %s", output)
				}
			} else if !strings.Contains(text, "ERROR") {
				t.Fatalf("not error severity: %s", output)
			}
		})
	}
}
