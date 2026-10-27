package repository

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"io"
	"testing"
)

// Model the database/sql contract where the first RETURNING row is available
// before statement completion (and a later execution error) is observable.
type preferenceCompletionState struct {
	terminalError error
	completed     bool
}

type preferenceCompletionConnector struct{ state *preferenceCompletionState }
type preferenceCompletionDriver struct{}
type preferenceCompletionConn struct{ state *preferenceCompletionState }
type preferenceCompletionRows struct {
	state *preferenceCompletionState
	sent  bool
}

func (c preferenceCompletionConnector) Connect(context.Context) (driver.Conn, error) {
	return &preferenceCompletionConn{state: c.state}, nil
}
func (preferenceCompletionConnector) Driver() driver.Driver { return preferenceCompletionDriver{} }
func (preferenceCompletionDriver) Open(string) (driver.Conn, error) {
	return nil, errors.New("use connector")
}
func (*preferenceCompletionConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("unexpected prepare")
}
func (*preferenceCompletionConn) Close() error { return nil }
func (*preferenceCompletionConn) Begin() (driver.Tx, error) {
	return nil, errors.New("unexpected transaction")
}
func (c *preferenceCompletionConn) QueryContext(context.Context, string, []driver.NamedValue) (driver.Rows, error) {
	return &preferenceCompletionRows{state: c.state}, nil
}
func (*preferenceCompletionRows) Columns() []string {
	return []string{"user_id", "data", "updated_at"}
}
func (*preferenceCompletionRows) Close() error { return nil }
func (r *preferenceCompletionRows) Next(values []driver.Value) error {
	if !r.sent {
		r.sent = true
		values[0], values[1], values[2] = "prefs-user", `{"theme":"dark"}`, "2026-10-27 00:00:00"
		return nil
	}
	if r.state.terminalError != nil {
		return r.state.terminalError
	}
	r.state.completed = true
	return io.EOF
}

func TestPreferencesUpsertAcknowledgesOnlyCompletedReturningStatement(t *testing.T) {
	lateFailure := errors.New("write failed after RETURNING row")
	for _, terminalError := range []error{nil, lateFailure} {
		name := "success"
		if terminalError != nil {
			name = "late execution failure"
		}
		t.Run(name, func(t *testing.T) {
			state := &preferenceCompletionState{terminalError: terminalError}
			db := sql.OpenDB(preferenceCompletionConnector{state: state})
			defer db.Close()
			repo := NewSQLitePreferencesRepo(db)
			got, err := repo.Upsert(context.Background(), "prefs-user", json.RawMessage(`{"theme":"dark"}`))
			if terminalError != nil {
				if !errors.Is(err, lateFailure) || got != nil {
					t.Fatalf("acknowledged an unfinished failed write: got=%v err=%v", got, err)
				}
				return
			}
			if err != nil || got == nil || !state.completed {
				t.Fatalf("success before statement completion: completed=%v got=%v err=%v", state.completed, got, err)
			}
		})
	}
}
