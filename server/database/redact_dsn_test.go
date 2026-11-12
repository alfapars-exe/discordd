package database

import (
	"strings"
	"testing"
)

func TestBackupDSNRedaction(t *testing.T) {
	for _, dsn := range []string{
		"postgres://user:private-one@db/app?PassWord=private-two&SSLPASSWORD=private-three&mode=ro",
		"libsql://db/app?AuthToken=private-one&authToken=private-two&mode=ro",
		"vacuum failed: libsql://db/app?AUTHTOKEN=private-one&mode=ro",
	} {
		got := RedactDSN(dsn)
		if strings.Contains(got, "private-") || !strings.Contains(got, "mode=ro") {
			t.Errorf("redacted DSN = %q", got)
		}
	}
}
