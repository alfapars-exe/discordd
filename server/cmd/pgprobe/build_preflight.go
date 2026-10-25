package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/argeinfina/hichat/database"
)

// BuildKit secret mounts never become image ENV/ARG values or command arguments.
// The same OpenPostgres path used at runtime performs the read-only TLS probe.
func prepareBuildPreflight(directory string) (bool, error) {
	names := []string{"DATABASE_URL", "HICHAT_PG_CA_PEM", "HICHAT_PG_CERT_PEM", "HICHAT_PG_KEY_PEM"}
	values := make(map[string]string, len(names))
	for _, name := range names {
		data, err := os.ReadFile(filepath.Join(directory, name))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return false, errors.New("cannot read PostgreSQL build secret mount")
		}
		values[name] = string(data)
	}
	if len(values) == 0 {
		return false, nil
	}
	dsn := strings.TrimSpace(values["DATABASE_URL"])
	if dsn != "" && !database.IsPostgresDSN(dsn) {
		return false, nil
	}
	if len(values) != len(names) || dsn == "" {
		return false, errors.New("PostgreSQL build preflight requires database URL and all three TLS secret mounts")
	}
	values["HICHAT_POSTGRES_URL"] = dsn
	delete(values, "DATABASE_URL")
	for name, value := range values {
		if value == "" {
			return false, errors.New("empty PostgreSQL build secret mount")
		}
		if err := os.Setenv(name, value); err != nil {
			return false, errors.New("cannot configure PostgreSQL build preflight")
		}
	}
	return true, nil
}
