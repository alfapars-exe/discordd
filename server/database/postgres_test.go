package database

import (
	"context"
	"strings"
	"testing"
)

func TestPostgresRejectsUnverifiedTLSWithoutExposingCredentials(t *testing.T) {
	for _, dsn := range []string{
		"postgres://user:secret@localhost/db?sslmode=disable",
		"postgres://user:secret@localhost/db?sslmode=require",
		"postgres://user:secret@localhost/db?sslmode=verify-full",
		"postgres://user:secret@localhost/db?sslmode=verify-full&sslrootcert=missing&sslcert=missing&sslkey=missing",
	} {
		db, err := OpenPostgres(context.Background(), dsn)
		if err == nil || db != nil {
			t.Fatal("unsafe or incomplete TLS configuration accepted")
		}
		if strings.Contains(err.Error(), "secret") {
			t.Fatal("credential leaked through connection error")
		}
	}
}
