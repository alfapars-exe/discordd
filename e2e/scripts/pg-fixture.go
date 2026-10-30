// E2E-only database lifecycle. Never accepts a remote host or an arbitrary
// database name; each application run receives its own PostgreSQL database.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/argeinfina/hichat/database"
	"github.com/jackc/pgx/v5"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

func main() {
	if err := runFixture(); err != nil {
		fmt.Fprintln(os.Stderr, "E2E PostgreSQL fixture failed:", err)
		os.Exit(1)
	}
}
func runFixture() error {
	if len(os.Args) != 4 {
		return fmt.Errorf("expected create/drop, run directory and run identity")
	}
	action, dir, id := os.Args[1], os.Args[2], os.Args[3]
	if !regexp.MustCompile(`^run-\d+-\d+-[a-f0-9]{16}$`).MatchString(id) || filepath.Base(dir) != id {
		return fmt.Errorf("invalid run identity")
	}
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("invalid run directory")
	}
	control, err := url.Parse(os.Getenv("HICHAT_E2E_POSTGRES_DSN"))
	if err != nil || control.Hostname() != "127.0.0.1" || control.Path != "/hichat_e2e_control" {
		return fmt.Errorf("requires explicit loopback hichat_e2e_control database")
	}
	for _, name := range []string{"HICHAT_PG_CA_PEM", "HICHAT_PG_CERT_PEM", "HICHAT_PG_KEY_PEM"} {
		os.Unsetenv(name)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	db, err := database.OpenPostgres(ctx, control.String())
	if err != nil {
		return fmt.Errorf("cannot connect to verified local fixture")
	}
	defer db.Close()
	name := "hichat_e2e_" + strings.ReplaceAll(id, "-", "_")
	if len(name) > 63 {
		return fmt.Errorf("run database name too long")
	}
	// PostgreSQL identifiers cannot be bound. Quote the regex-validated local run identifier.
	quotedName := pgx.Identifier{name}.Sanitize()
	createQuery := fmt.Sprintf("CREATE DATABASE %s", quotedName)
	dropQuery := fmt.Sprintf("DROP DATABASE IF EXISTS %s WITH (FORCE)", quotedName)
	descriptor := filepath.Join(dir, "hichat-e2e-postgres.json")
	if action == "drop" {
		_, err = db.ExecContext(ctx, dropQuery)
		return err
	}
	if action != "create" {
		return fmt.Errorf("unknown action")
	}
	if _, err = db.ExecContext(ctx, createQuery); err != nil {
		return fmt.Errorf("cannot create unique run database")
	}
	runURL := *control
	runURL.Path = "/" + name
	encoded, _ := json.Marshal(map[string]string{"url": runURL.String(), "run_id": id})
	file, err := os.OpenFile(descriptor, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		_, _ = db.ExecContext(ctx, dropQuery)
		return fmt.Errorf("cannot create run descriptor")
	}
	_, err = file.Write(encoded)
	closeErr := file.Close()
	if err != nil {
		return err
	}
	return closeErr
}
