package main

import (
	"bytes"
	"context"
	cryptorand "crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	crypt "github.com/argeinfina/hichat/pkg/crypto"
	"github.com/argeinfina/hichat/ws"
	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"golang.org/x/crypto/bcrypt"
)

const activeProcessPassword = "ActiveSignalFixture-123!"
const activeProcessKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

// Exercise a separately built production server, rather than invoking main
// inside the test executable. Published installer/device acceptance is separate.
func TestActiveVoiceProcessPostgresSignal(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("requires POSIX SIGTERM and disposable PostgreSQL")
	}
	runActiveVoiceProcessSignal(t)
}

func seedActiveVoiceProcess(t *testing.T, db *sql.DB) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := database.MigratePostgres(ctx, db); err != nil {
		t.Fatal("active fixture migration failed")
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(activeProcessPassword), bcrypt.DefaultCost)
	if err != nil {
		t.Fatal("fixture password setup failed")
	}
	key, _ := hex.DecodeString(activeProcessKey)
	apiKey, err := crypt.Encrypt("active-fixture-key", key)
	if err != nil {
		t.Fatal("fixture credential setup failed")
	}
	secret, err := crypt.Encrypt("active-fixture-secret", key)
	if err != nil {
		t.Fatal("fixture credential setup failed")
	}
	queries := []struct {
		q    string
		args []any
	}{
		{`INSERT INTO users(id,username,password_hash) VALUES('active-user','active_signal_user',$1)`, []any{string(hash)}},
		{`INSERT INTO livekit_instances(id,url,api_key,api_secret,is_platform_managed) VALUES('active-instance','http://127.0.0.1:9',$1,$2,1)`, []any{apiKey, secret}},
		{`INSERT INTO servers(id,name,owner_id,livekit_instance_id) VALUES('active-server','Active signal','active-user','active-instance')`, nil},
		{`INSERT INTO server_members(server_id,user_id) VALUES('active-server','active-user')`, nil},
		{`INSERT INTO channels(id,name,type,server_id) VALUES('active-voice','voice','voice','active-server')`, nil},
		{`INSERT INTO roles(id,name,permissions,is_owner,server_id) VALUES('active-role','Owner',$1,1,'active-server')`, []any{int64(models.PermAll)}},
		{`INSERT INTO user_roles(user_id,role_id,server_id) VALUES('active-user','active-role','active-server')`, nil},
	}
	for _, q := range queries {
		if _, err = db.ExecContext(ctx, q.q, q.args...); err != nil {
			t.Fatal("active fixture seed failed")
		}
	}
}

func startActiveVoiceProcess(t *testing.T, dsn string, port int) (*exec.Cmd, <-chan struct{}, *error, string) {
	t.Helper()
	dir := t.TempDir()
	logPath := filepath.Join(dir, "server.log")
	log, err := os.Create(logPath)
	if err != nil {
		t.Fatal("process log unavailable")
	}
	binary := os.Getenv("HICHAT_ACTIVE_VOICE_SERVER_BINARY")
	info, err := os.Stat(binary)
	if !filepath.IsAbs(binary) || err != nil || !info.Mode().IsRegular() {
		log.Close()
		t.Fatal("absolute production server binary required; build with go build before running native process acceptance")
	}
	child := exec.Command(binary)
	child.Dir = dir
	// Do not inherit HF/cloud/SMTP credentials or production service switches.
	child.Env = []string{"PATH=" + os.Getenv("PATH"), "TMPDIR=" + dir, "DATABASE_URL=" + dsn, "SERVER_HOST=127.0.0.1", fmt.Sprintf("SERVER_PORT=%d", port), "JWT_SECRET=isolated-active-process-fixture-secret-not-production", "ENCRYPTION_KEY=" + activeProcessKey, "ENVIRONMENT=development", "LOG_LEVEL=info", "LOG_FORMAT=text", "UPLOAD_DIR=" + filepath.Join(dir, "uploads"), "DATA_EXPORT_DIR=" + filepath.Join(dir, "exports")}
	child.Stdout = log
	child.Stderr = log
	if err = child.Start(); err != nil {
		log.Close()
		t.Fatal("server child could not start")
	}
	done := make(chan struct{})
	var result error
	go func() { result = child.Wait(); close(done) }()
	t.Cleanup(func() {
		select {
		case <-done:
		default:
			_ = child.Process.Kill()
			<-done
		}
		log.Close()
	})
	return child, done, &result, logPath
}

func waitActiveVoiceHealth(t *testing.T, baseURL string, done <-chan struct{}) {
	t.Helper()
	deadline := time.NewTimer(20 * time.Second)
	defer deadline.Stop()
	client := http.Client{Timeout: 500 * time.Millisecond}
	for {
		response, err := client.Get(baseURL + "/api/health")
		if err == nil {
			response.Body.Close()
			if response.StatusCode == http.StatusOK {
				return
			}
		}
		select {
		case <-done:
			t.Fatal("server exited before health")
		case <-deadline.C:
			t.Fatal("server health deadline exceeded")
		case <-time.After(50 * time.Millisecond):
		}
	}
}

func postActiveVoiceJSON(t *testing.T, endpoint, token string, payload any, target any) {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal("fixture request encoding failed")
	}
	request, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		t.Fatal("fixture request invalid")
	}
	request.Header.Set("Content-Type", "application/json")
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	client := http.Client{Timeout: 5 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal("fixture API request failed")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("fixture API rejected request: status=%d", response.StatusCode)
	}
	if json.NewDecoder(response.Body).Decode(target) != nil {
		t.Fatal("fixture API response invalid")
	}
}

func joinActiveVoiceProcess(t *testing.T, baseURL string) *websocket.Conn {
	t.Helper()
	var auth struct {
		Data struct {
			AccessToken string `json:"access_token"`
		} `json:"data"`
	}
	postActiveVoiceJSON(t, baseURL+"/api/auth/login", "", map[string]string{"username": "active_signal_user", "password": activeProcessPassword}, &auth)
	if auth.Data.AccessToken == "" {
		t.Fatal("normal login omitted access token")
	}
	var ticket struct {
		Data struct {
			Ticket string `json:"ticket"`
		} `json:"data"`
	}
	postActiveVoiceJSON(t, baseURL+"/api/auth/ws-ticket", auth.Data.AccessToken, map[string]string{}, &ticket)
	if ticket.Data.Ticket == "" {
		t.Fatal("one-shot WS ticket missing")
	}
	endpoint := "ws" + strings.TrimPrefix(baseURL, "http") + "/ws?ticket=" + url.QueryEscape(ticket.Data.Ticket)
	conn, _, err := websocket.DefaultDialer.Dial(endpoint, nil)
	if err != nil {
		t.Fatal("normal WS ticket handshake failed")
	}
	t.Cleanup(func() { conn.Close() })
	conn.SetReadDeadline(time.Now().Add(45 * time.Second))
	readActiveVoiceEvent(t, conn, "ready")
	if conn.WriteJSON(ws.Event{Op: ws.OpVoiceJoin, Data: ws.VoiceJoinData{ChannelID: "active-voice"}}) != nil {
		t.Fatal("voice join send failed")
	}
	readActiveVoiceEvent(t, conn, "voice_state_update")
	return conn
}

func readActiveVoiceEvent(t *testing.T, conn *websocket.Conn, op string) {
	t.Helper()
	for {
		var event struct {
			Op   string `json:"op"`
			Data struct {
				UserID    string `json:"user_id"`
				ChannelID string `json:"channel_id"`
				Action    string `json:"action"`
			} `json:"d"`
		}
		if conn.ReadJSON(&event) != nil {
			t.Fatalf("expected voice lifecycle event missing: op=%s", op)
		}
		if event.Op != op {
			continue
		}
		if op == "voice_state_update" && (event.Data.UserID != "active-user" || event.Data.ChannelID != "active-voice" || event.Data.Action != "join") {
			continue
		}
		return
	}
}

func assertActiveVoiceProcessCredit(t *testing.T, db *sql.DB) {
	t.Helper()
	var used, credits, pending, applied, seconds int64
	err := db.QueryRow(`SELECT COALESCE((SELECT SUM(used_seconds) FROM livekit_monthly_usage WHERE instance_id='active-instance'),0),COUNT(*),COUNT(*) FILTER(WHERE applied_at IS NULL),COUNT(applied_at),COALESCE(SUM(seconds),0) FROM voice_usage_credits WHERE instance_id='active-instance'`).Scan(&used, &credits, &pending, &applied, &seconds)
	if err != nil {
		t.Fatal("post-signal credit status unavailable")
	}
	if credits != 1 || pending != 0 || applied != 1 || used < 2 || used != seconds {
		t.Fatalf("post-signal accounting mismatch: credits=%d pending=%d applied=%d usage=%d ledger=%d", credits, pending, applied, used, seconds)
	}
	t.Logf("ACTIVE_VOICE_SIGNAL_RESULT credits=%d pending=%d applied=%d usage=%d ledger=%d", credits, pending, applied, used, seconds)
}

func runActiveVoiceProcessSignal(t *testing.T) {
	t.Helper()
	db := activeVoiceProcessPool(t)
	seedActiveVoiceProcess(t, db)
	cfg, err := pgx.ParseConfig(activeVoiceProcessDSN())
	if err != nil {
		t.Fatal("fixture configuration invalid")
	}
	if err = db.QueryRow("SELECT current_database()").Scan(&cfg.Database); err != nil {
		t.Fatal("fixture identity unavailable")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal("fixture port unavailable")
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	databaseURL, err := url.Parse(activeVoiceProcessDSN())
	if err != nil {
		t.Fatal("fixture URL invalid")
	}
	databaseURL.Path = "/" + cfg.Database
	child, done, childResult, logPath := startActiveVoiceProcess(t, databaseURL.String(), port)
	baseURL := fmt.Sprintf("http://127.0.0.1:%d", port)
	waitActiveVoiceHealth(t, baseURL, done)
	conn := joinActiveVoiceProcess(t, baseURL)
	defer conn.Close()
	disconnected := watchActiveVoiceProcessSocket(t, conn)
	select {
	case <-disconnected:
		t.Fatal("voice socket closed before signal")
	case <-time.After(2100 * time.Millisecond):
	}
	var before int
	if err = db.QueryRow("SELECT COUNT(*) FROM voice_usage_credits WHERE instance_id='active-instance'").Scan(&before); err != nil || before != 0 {
		t.Fatal("fixture session was not active before signal")
	}
	stopActiveVoiceProcess(t, child, done, childResult, logPath)
	assertActiveVoiceProcessCredit(t, db)
	beforeRestart := activeVoiceProcessCreditSnapshot(t, db)
	restarted, restartedDone, restartedResult, restartedLog := startActiveVoiceProcess(t, databaseURL.String(), port)
	waitActiveVoiceHealth(t, baseURL, restartedDone)
	stopActiveVoiceProcess(t, restarted, restartedDone, restartedResult, restartedLog)
	assertActiveVoiceProcessCredit(t, db)
	if afterRestart := activeVoiceProcessCreditSnapshot(t, db); beforeRestart != afterRestart {
		t.Fatal("restart rewrote the applied voice credit")
	}
	t.Log("ACTIVE_VOICE_RESTART_RESULT retained_credit=true")
}

func activeVoiceProcessCreditSnapshot(t *testing.T, db *sql.DB) string {
	t.Helper()
	var snapshot string
	if err := db.QueryRow("SELECT to_jsonb(c)::text FROM voice_usage_credits c WHERE instance_id='active-instance'").Scan(&snapshot); err != nil {
		t.Fatal("applied credit snapshot unavailable")
	}
	return snapshot
}

func stopActiveVoiceProcess(t *testing.T, child *exec.Cmd, done <-chan struct{}, result *error, logPath string) {
	t.Helper()
	if err := child.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal("SIGTERM delivery failed")
	}
	select {
	case <-done:
	case <-time.After(30 * time.Second):
		t.Fatal("active server did not shut down")
	}
	if *result != nil {
		t.Fatal("active server did not exit successfully")
	}
	log, err := os.ReadFile(logPath)
	if err != nil || !bytes.Contains(log, []byte("server stopped gracefully")) {
		t.Fatal("graceful shutdown marker missing")
	}
}

func watchActiveVoiceProcessSocket(t *testing.T, conn *websocket.Conn) <-chan struct{} {
	t.Helper()
	disconnected := make(chan struct{})
	go func() {
		defer close(disconnected)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()
	t.Cleanup(func() { conn.Close(); <-disconnected })
	return disconnected
}

func activeVoiceProcessPool(t *testing.T) *sql.DB {
	t.Helper()
	dsn := activeVoiceProcessDSN()
	if dsn == "" {
		t.Skip("requires disposable loopback PostgreSQL")
	}
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatal("fixture configuration invalid")
	}
	if (cfg.Host != "127.0.0.1" && cfg.Host != "localhost") || (cfg.Database != "hichat_test" && cfg.Database != "hichat_e2e_control") {
		t.Fatal("explicit loopback control database required")
	}
	if cfg.TLSConfig == nil || cfg.TLSConfig.InsecureSkipVerify || len(cfg.Fallbacks) != 0 {
		t.Fatal("verified PostgreSQL TLS without fallback required")
	}
	var identity [16]byte
	if _, err = cryptorand.Read(identity[:]); err != nil {
		t.Fatal("fixture identity unavailable")
	}
	name := "hichat_owner_watch_" + hex.EncodeToString(identity[:])
	quoted := pgx.Identifier{name}.Sanitize()
	// Database identifiers cannot be SQL bind values. Only the generated,
	// pgx-quoted identifier is interpolated into these fixed DDL templates.
	createQuery := fmt.Sprintf("CREATE DATABASE %s", quoted)
	dropQuery := fmt.Sprintf("DROP DATABASE %s WITH (FORCE)", quoted)
	admin := stdlib.OpenDB(*cfg)
	t.Cleanup(func() { admin.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err = admin.ExecContext(ctx, createQuery); err != nil {
		t.Fatal("cannot create owned active-process fixture")
	}
	cfg.Database = name
	pool := stdlib.OpenDB(*cfg)
	pool.SetMaxOpenConns(4)
	t.Cleanup(func() {
		pool.Close()
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := admin.ExecContext(cleanup, dropQuery); err != nil {
			t.Error("cannot drop owned active-process fixture")
		}
	})
	return pool
}

// Prefer the dedicated mutual-TLS fixture in CI; local runs may supply the
// same verified connection through the standard PostgreSQL test variable.
func activeVoiceProcessDSN() string {
	if dsn := os.Getenv("HICHAT_ACTIVE_VOICE_POSTGRES_DSN"); dsn != "" {
		return dsn
	}
	return os.Getenv("HICHAT_TEST_POSTGRES_DSN")
}
