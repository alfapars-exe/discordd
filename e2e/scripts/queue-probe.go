// queue-probe is an E2E-only, read-only observer for disposable PostgreSQL
// database. It lets the UI test distinguish "suppression processed" from
// "notification has not been delivered yet" without adding a production API.
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/argeinfina/hichat/database"
)

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: queue-probe <disposable-db-path> <message-marker>")
		os.Exit(2)
	}
	dbPath, err := filepath.Abs(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, "invalid E2E database path")
		os.Exit(2)
	}
	var descriptor struct {
		URL   string `json:"url"`
		RunID string `json:"run_id"`
	}
	data, err := os.ReadFile(dbPath)
	if err != nil || json.Unmarshal(data, &descriptor) != nil {
		fmt.Fprintln(os.Stderr, "invalid E2E descriptor")
		os.Exit(2)
	}
	u, err := url.Parse(descriptor.URL)
	if err != nil || u.Hostname() != "127.0.0.1" || !regexp.MustCompile(`^run-\d+-\d+-[a-f0-9]{16}$`).MatchString(descriptor.RunID) || filepath.Base(filepath.Dir(dbPath)) != descriptor.RunID || u.Path != "/hichat_e2e_"+strings.ReplaceAll(descriptor.RunID, "-", "_") {
		fmt.Fprintln(os.Stderr, "invalid E2E database identity")
		os.Exit(2)
	}
	for _, name := range []string{"HICHAT_PG_CA_PEM", "HICHAT_PG_CERT_PEM", "HICHAT_PG_KEY_PEM"} {
		os.Unsetenv(name)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	db, err := database.OpenPostgres(ctx, descriptor.URL)
	if err != nil {
		fmt.Fprintln(os.Stderr, "cannot open disposable E2E database")
		os.Exit(1)
	}
	defer db.Close()
	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		fmt.Fprintln(os.Stderr, "cannot begin read-only E2E observation")
		os.Exit(1)
	}
	defer tx.Rollback()
	var messages, pending int
	err = tx.QueryRowContext(ctx, `SELECT COUNT(*),COALESCE(SUM(CASE WHEN EXISTS(
		SELECT 1 FROM channel_message_notification_jobs j WHERE j.message_id=m.id
	) THEN 1 ELSE 0 END),0) FROM messages m
		WHERE COALESCE(m.content,'')=?`, os.Args[2]).Scan(&messages, &pending)
	if err != nil {
		fmt.Fprintf(os.Stderr, "cannot inspect disposable E2E notification queue: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("%d %d\n", messages, pending)
}
