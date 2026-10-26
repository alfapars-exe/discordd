package database

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// go-libsql releases autocommit Hrana streams between statements. A pinned
// database/sql connection therefore cannot retain foreign_keys=OFF until BEGIN.
// This migration alone uses an explicit Hrana baton, retaining one server-side
// connection across PRAGMAs, the transaction, verification, and rollback.
type threadHranaSession struct {
	endpoint, token, baton string
	encryptionKey          string
	client                 *http.Client
}

type threadHranaValue struct {
	Type  string `json:"type"`
	Value string `json:"value,omitempty"`
}

type threadHranaResult struct {
	Rows [][]threadHranaValue `json:"rows"`
}

func newThreadHranaSession(dsn string) (*threadHranaSession, error) {
	u, err := url.Parse(dsn)
	if err != nil || u.Host == "" || u.User != nil {
		return nil, fmt.Errorf("thread migration requires a valid remote libSQL URL")
	}
	encryptionKey := u.Query().Get("remoteEncryptionKey")
	token := u.Query().Get("authToken")
	switch u.Scheme {
	case "libsql", "wss":
		u.Scheme = "https"
	case "ws":
		u.Scheme = "http"
	case "http", "https":
	default:
		return nil, fmt.Errorf("thread migration requires an HTTP-compatible libSQL URL")
	}
	u.RawQuery, u.Fragment = "", ""
	u.Path = strings.TrimRight(u.Path, "/") + "/v2/pipeline"
	return &threadHranaSession{endpoint: u.String(), token: token, encryptionKey: encryptionKey, client: &http.Client{
		Timeout:       30 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
	}}, nil
}

func (s *threadHranaSession) request(ctx context.Context, kind, statement string, args ...string) (threadHranaResult, error) {
	request := map[string]any{"type": kind}
	if kind == "execute" {
		values := make([]threadHranaValue, len(args))
		for i, arg := range args {
			values[i] = threadHranaValue{Type: "text", Value: arg}
		}
		request["stmt"] = map[string]any{"sql": statement, "args": values, "want_rows": true}
	}
	payload, err := json.Marshal(map[string]any{"baton": nilIfEmpty(s.baton), "requests": []any{request}})
	if err != nil {
		return threadHranaResult{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.endpoint, bytes.NewReader(payload))
	if err != nil {
		return threadHranaResult{}, fmt.Errorf("cannot construct thread migration request")
	}
	req.Header.Set("Content-Type", "application/json")
	if s.token != "" {
		req.Header.Set("Authorization", "Bearer "+s.token)
	}
	if s.encryptionKey != "" {
		req.Header.Set("x-turso-encryption-key", s.encryptionKey)
	}
	response, err := s.client.Do(req)
	if err != nil {
		return threadHranaResult{}, fmt.Errorf("thread migration remote request failed")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return threadHranaResult{}, fmt.Errorf("thread migration remote HTTP status %d", response.StatusCode)
	}
	var decoded struct {
		Baton   *string `json:"baton"`
		BaseURL *string `json:"base_url"`
		Results []struct {
			Type     string `json:"type"`
			Response struct {
				Type   string            `json:"type"`
				Result threadHranaResult `json:"result"`
			} `json:"response"`
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		} `json:"results"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 32<<20)).Decode(&decoded); err != nil {
		return threadHranaResult{}, fmt.Errorf("thread migration received invalid remote response")
	}
	if decoded.Baton != nil {
		s.baton = *decoded.Baton
	} else {
		s.baton = ""
	}
	if decoded.BaseURL != nil && *decoded.BaseURL != "" {
		base, err := url.Parse(*decoded.BaseURL)
		current, _ := url.Parse(s.endpoint)
		trusted := err == nil && base.User == nil && base.RawQuery == "" && (base.Host == current.Host && base.Scheme == current.Scheme ||
			base.Scheme == "https" && current.Scheme == "https" && strings.HasSuffix(base.Hostname(), ".turso.io") && strings.HasSuffix(current.Hostname(), ".turso.io"))
		if !trusted {
			return threadHranaResult{}, fmt.Errorf("thread migration received an untrusted remote stream URL")
		}
		base.Path = strings.TrimRight(base.Path, "/") + "/v2/pipeline"
		s.endpoint = base.String()
	}
	if len(decoded.Results) != 1 || decoded.Results[0].Type != "ok" || decoded.Results[0].Response.Type != kind {
		return threadHranaResult{}, fmt.Errorf("thread migration remote statement failed")
	}
	if kind == "execute" && s.baton == "" {
		return threadHranaResult{}, fmt.Errorf("thread migration remote stream was not retained")
	}
	return decoded.Results[0].Response.Result, nil
}

func nilIfEmpty(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func (db *DB) applyRemoteThreadChannelTypeMigration(filename, content string) error {
	s, err := newThreadHranaSession(db.remoteMigrationDSN)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	// Closing a Hrana stream rolls back any uncommitted transaction. Cleanup
	// gets its own deadline even when the migration context has expired.
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if s.baton != "" {
			_, _ = s.request(cleanup, "close", "")
		}
	}()
	if _, err := s.request(ctx, "execute", "PRAGMA foreign_keys=OFF"); err != nil {
		return err
	}
	setting, err := s.request(ctx, "execute", "PRAGMA foreign_keys")
	if err != nil {
		return err
	}
	if len(setting.Rows) != 1 || len(setting.Rows[0]) != 1 || setting.Rows[0][0].Type != "integer" || setting.Rows[0][0].Value != "0" {
		return fmt.Errorf("thread migration remote foreign keys remain enabled")
	}
	if _, err := s.request(ctx, "execute", "BEGIN IMMEDIATE"); err != nil {
		return err
	}
	// runMigrations reads its pending list before taking a write lock. Another
	// process may have completed this migration while this stream waited.
	applied, err := s.request(ctx, "execute", "SELECT filename FROM schema_migrations WHERE filename=?", filename)
	if err != nil {
		return err
	}
	if len(applied.Rows) != 0 {
		_, err = s.request(ctx, "execute", "COMMIT")
		return err
	}
	before, err := s.request(ctx, "execute", "PRAGMA foreign_key_check")
	if err != nil {
		return err
	}
	objects, err := s.request(ctx, "execute", "SELECT name, sql FROM sqlite_master WHERE tbl_name='channels' AND type IN ('index','trigger') AND sql IS NOT NULL")
	if err != nil {
		return err
	}
	for _, statement := range splitStatements(content) {
		if strings.TrimSpace(statement) == "" {
			continue
		}
		if _, err := s.request(ctx, "execute", statement); err != nil {
			return err
		}
	}
	for _, object := range objects.Rows {
		if len(object) != 2 || object[0].Type != "text" || object[1].Type != "text" {
			return fmt.Errorf("thread migration received invalid schema object")
		}
		existing, err := s.request(ctx, "execute", "SELECT name FROM sqlite_master WHERE name=?", object[0].Value)
		if err != nil {
			return err
		}
		if len(existing.Rows) == 0 {
			if _, err := s.request(ctx, "execute", object[1].Value); err != nil {
				return err
			}
		}
	}
	after, err := s.request(ctx, "execute", "PRAGMA foreign_key_check")
	if err != nil {
		return err
	}
	prior := make(map[string]bool, len(before.Rows))
	for _, row := range before.Rows {
		key, _ := json.Marshal(row)
		prior[string(key)] = true
	}
	for _, row := range after.Rows {
		key, _ := json.Marshal(row)
		if !prior[string(key)] {
			return fmt.Errorf("thread migration introduced remote foreign key violation")
		}
	}
	if _, err := s.request(ctx, "execute", "INSERT INTO schema_migrations(filename) VALUES (?)", filename); err != nil {
		return err
	}
	_, err = s.request(ctx, "execute", "COMMIT")
	return err
}
