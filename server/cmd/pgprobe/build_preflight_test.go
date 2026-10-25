package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestBuildPreflightSecretMountConfiguration(t *testing.T) {
	for _, name := range []string{"HICHAT_POSTGRES_URL", "HICHAT_PG_CA_PEM", "HICHAT_PG_CERT_PEM", "HICHAT_PG_KEY_PEM"} {
		t.Setenv(name, "")
	}
	directory := t.TempDir()
	if enabled, err := prepareBuildPreflight(directory); enabled || err != nil {
		t.Fatalf("unconfigured self-host build: enabled=%v err=%v", enabled, err)
	}
	values := map[string]string{
		"DATABASE_URL":       "postgres://test-user:test-only@localhost/db?sslmode=verify-full\n",
		"HICHAT_PG_CA_PEM":   "test-only-ca\n",
		"HICHAT_PG_CERT_PEM": "test-only-cert\n",
		"HICHAT_PG_KEY_PEM":  "test-only-key\n",
	}
	for name, value := range values {
		if err := os.WriteFile(filepath.Join(directory, name), []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if enabled, err := prepareBuildPreflight(directory); !enabled || err != nil {
		t.Fatalf("configured preflight: enabled=%v err=%v", enabled, err)
	}
	if os.Getenv("HICHAT_POSTGRES_URL") != "postgres://test-user:test-only@localhost/db?sslmode=verify-full" || os.Getenv("HICHAT_PG_KEY_PEM") != values["HICHAT_PG_KEY_PEM"] {
		t.Fatal("build secret values were not passed to the probe process correctly")
	}
	if err := os.Remove(filepath.Join(directory, "HICHAT_PG_KEY_PEM")); err != nil {
		t.Fatal(err)
	}
	if enabled, err := prepareBuildPreflight(directory); enabled || err == nil {
		t.Fatal("partial PostgreSQL secret configuration must not report success")
	}
}
