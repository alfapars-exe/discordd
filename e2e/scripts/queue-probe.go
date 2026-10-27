// queue-probe is an E2E-only, read-only observer for the disposable SQLite
// database. It lets the UI test distinguish "suppression processed" from
// "notification has not been delivered yet" without adding a production API.
package main

import (
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
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
	uriPath := filepath.ToSlash(dbPath)
	if filepath.VolumeName(dbPath) != "" {
		uriPath = "/" + uriPath
	}
	dsn := (&url.URL{Scheme: "file", Path: uriPath}).String() + "?mode=ro&_pragma=busy_timeout(5000)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		fmt.Fprintln(os.Stderr, "cannot open disposable E2E database")
		os.Exit(1)
	}
	defer db.Close()
	var messages, pending int
	err = db.QueryRow(`SELECT COUNT(*),COALESCE(SUM(CASE WHEN EXISTS(
		SELECT 1 FROM channel_message_notification_jobs j WHERE j.message_id=m.id
	) THEN 1 ELSE 0 END),0) FROM messages m
		WHERE COALESCE(m.content,'')=?`, os.Args[2]).Scan(&messages, &pending)
	if err != nil {
		fmt.Fprintf(os.Stderr, "cannot inspect disposable E2E notification queue: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("%d %d\n", messages, pending)
}
