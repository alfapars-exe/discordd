// pgprobe checks PostgreSQL from the exact runtime/network where it is invoked.
// Set HICHAT_POSTGRES_URL through a secret; never pass credentials on argv.
package main

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/argeinfina/hichat/database"
)

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	db, err := database.OpenPostgres(ctx, os.Getenv("HICHAT_POSTGRES_URL"))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer db.Close()
	var tls bool
	var protocol, clientDN string
	err = db.QueryRowContext(ctx, "SELECT ssl, version, client_dn FROM pg_stat_ssl WHERE pid = pg_backend_pid()").Scan(&tls, &protocol, &clientDN)
	if err != nil || !tls || clientDN == "" {
		fmt.Fprintln(os.Stderr, "client certificate TLS acceptance failed")
		os.Exit(1)
	}
	fmt.Printf("PostgreSQL 18 SQL connection verified; TLS=%s; client certificate accepted\n", protocol)
}
