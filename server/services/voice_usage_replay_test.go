package services

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
	"sync"
	"testing"
	"time"
)

type durableVoiceUsageRecorder interface {
	RecordVoiceUsage(context.Context, string, string, int, int, int) error
}

func TestVoiceUsagePostgresReplayTransaction(t *testing.T) {
	db := postgresServerFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := db.ExecContext(ctx, `INSERT INTO livekit_instances(id,url,api_key,api_secret) VALUES('usage-instance','http://127.0.0.1','fixture','fixture')`); err != nil {
		t.Fatal(err)
	}
	repo := repository.NewSQLiteLiveKitRepo(db)
	recorder, ok := repo.(durableVoiceUsageRecorder)
	if !ok {
		t.Fatal("repository has no durable replay-safe usage contract")
	}
	var wg sync.WaitGroup
	failures := make(chan error, 16)
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			failures <- recorder.RecordVoiceUsage(ctx, "session-one", "usage-instance", 2026, 1, 60)
		}()
	}
	wg.Wait()
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatal(err)
		}
	}
	used, err := repo.GetMonthlyUsage(ctx, "usage-instance", 2026, 1)
	if err != nil || used != 60 {
		t.Fatalf("usage=%d error=%v, want60", used, err)
	}
	if err = recorder.RecordVoiceUsage(ctx, "session-one", "usage-instance", 2026, 1, 61); !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("changed replay=%v, want conflict", err)
	}
	if _, err = db.ExecContext(ctx, `CREATE FUNCTION reject_usage_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'usage fixture failure'; END $$`); err != nil {
		t.Fatal(err)
	}
	if _, err = db.ExecContext(ctx, `CREATE TRIGGER reject_usage_fixture BEFORE INSERT OR UPDATE ON livekit_monthly_usage FOR EACH ROW EXECUTE FUNCTION reject_usage_fixture()`); err != nil {
		t.Fatal(err)
	}
	if err = recorder.RecordVoiceUsage(ctx, "session-two", "usage-instance", 2026, 1, 30); err == nil {
		t.Fatal("aggregate failure was accepted")
	}
	var rows int
	if err = db.QueryRowContext(ctx, `SELECT count(*) FROM voice_usage_credits WHERE credit_id='session-two'`).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("partial ledger persisted: rows=%d err=%v", rows, err)
	}
	if _, err = db.ExecContext(ctx, `DROP TRIGGER reject_usage_fixture ON livekit_monthly_usage`); err != nil {
		t.Fatal(err)
	}
	if err = recorder.RecordVoiceUsage(ctx, "session-two", "usage-instance", 2026, 1, 30); err != nil {
		t.Fatal(err)
	}
	used, err = repo.GetMonthlyUsage(ctx, "usage-instance", 2026, 1)
	if err != nil || used != 90 {
		t.Fatalf("usage after retry=%d err=%v, want90", used, err)
	}
	ended := time.Date(2026, time.January, 31, 23, 59, 59, 0, time.UTC)
	service := &voiceService{livekitGetter: repo, usageCredit: NewDurableVoiceUsageCredit(repo)}
	service.creditUsageSession("session-three", "usage-instance", true, ended.Add(-time.Minute), ended)
	service.creditUsageSession("session-three", "usage-instance", true, ended.Add(-time.Minute), ended)
	service.creditUsageSession("session-four", "usage-instance", true, ended.Add(-time.Minute), ended)
	used, err = repo.GetMonthlyUsage(ctx, "usage-instance", 2026, 1)
	if err != nil || used != 210 {
		t.Fatalf("service replay/session separation usage=%d err=%v, want210", used, err)
	}

}

type pendingVoiceUsageQueue interface {
	EnqueueVoiceUsage(context.Context, string, string, int, int, int) error
	ApplyNextVoiceUsage(context.Context) (bool, error)
}

func TestVoiceUsagePostgresPendingRecovery(t *testing.T) {
	db := postgresServerFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := db.ExecContext(ctx, `INSERT INTO livekit_instances(id,url,api_key,api_secret) VALUES('pending-instance','http://127.0.0.1','fixture','fixture')`); err != nil {
		t.Fatal(err)
	}
	repo := repository.NewSQLiteLiveKitRepo(db)
	queue, ok := repo.(pendingVoiceUsageQueue)
	if !ok {
		t.Fatal("repository has no durable pending usage handoff")
	}
	if err := queue.EnqueueVoiceUsage(ctx, "pending-session", "pending-instance", 2026, 1, 60); err != nil {
		t.Fatal(err)
	}
	if err := queue.EnqueueVoiceUsage(ctx, "pending-session", "pending-instance", 2026, 1, 60); err != nil {
		t.Fatal(err)
	}
	if err := queue.EnqueueVoiceUsage(ctx, "pending-session", "pending-instance", 2026, 1, 61); !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("changed pending replay=%v", err)
	}
	used, err := repo.GetMonthlyUsage(ctx, "pending-instance", 2026, 1)
	if err != nil || used != 0 {
		t.Fatalf("enqueue prematurely changed usage: %d %v", used, err)
	}
	assertPendingUsageWriteFailures(t, ctx, db, repo, queue)
	// A fresh repository represents restart: no process-local queue is reused.
	recovered := repository.NewSQLiteLiveKitRepo(db).(pendingVoiceUsageQueue)
	assertConcurrentUsageRecovery(t, ctx, recovered)
	if applied, err := recovered.ApplyNextVoiceUsage(ctx); err != nil || applied {
		t.Fatalf("completed credit replayed=%v err=%v", applied, err)
	}
	used, err = repo.GetMonthlyUsage(ctx, "pending-instance", 2026, 1)
	if err != nil || used != 60 {
		t.Fatalf("recovered usage=%d err=%v", used, err)
	}
	if err = queue.EnqueueVoiceUsage(ctx, "worker-pending", "pending-instance", 2026, 1, 30); err != nil {
		t.Fatal(err)
	}
	assertOwnedPendingUsageRecovery(t, ctx, db, repo)

}

func TestVoiceUsagePostgresServiceHandoffSurvivesApplyFailure(t *testing.T) {
	db := postgresServerFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := db.ExecContext(ctx, `INSERT INTO livekit_instances(id,url,api_key,api_secret) VALUES('handoff-instance','http://127.0.0.1','fixture','fixture')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `CREATE FUNCTION reject_handoff_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'handoff fixture failure'; END $$`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `CREATE TRIGGER reject_handoff_fixture BEFORE INSERT OR UPDATE ON livekit_monthly_usage FOR EACH ROW EXECUTE FUNCTION reject_handoff_fixture()`); err != nil {
		t.Fatal(err)
	}
	repo := repository.NewSQLiteLiveKitRepo(db)
	service := &voiceService{livekitGetter: repo, usageCredit: NewDurableVoiceUsageCredit(repo)}
	ended := time.Date(2026, time.January, 31, 23, 59, 59, 0, time.UTC)
	service.creditUsageSession("handoff-session", "handoff-instance", true, ended.Add(-time.Minute), ended)
	var pending int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM voice_usage_credits WHERE credit_id='handoff-session' AND applied_at IS NULL`).Scan(&pending); err != nil || pending != 1 {
		t.Fatalf("service forgot unapplied session: pending=%d err=%v", pending, err)
	}
	if _, err := db.ExecContext(ctx, `DROP TRIGGER reject_handoff_fixture ON livekit_monthly_usage`); err != nil {
		t.Fatal(err)
	}
	recovered := &voiceService{usageRecovery: repository.NewSQLiteLiveKitRepo(db)}
	stop := startVoiceUsageDelivery(ctx, recovered, time.Millisecond)
	t.Cleanup(stop)
	for {
		used, err := repo.GetMonthlyUsage(ctx, "handoff-instance", 2026, 1)
		if err != nil {
			t.Fatal(err)
		}
		if used == 60 {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("restart worker never applied accepted session")
		default:
			time.Sleep(time.Millisecond)
		}
	}
	stop()
	service.creditUsageSession("handoff-session", "handoff-instance", true, ended.Add(-time.Minute), ended)
	used, err := repo.GetMonthlyUsage(ctx, "handoff-instance", 2026, 1)
	if err != nil || used != 60 {
		t.Fatalf("service replay inflated usage=%d err=%v", used, err)
	}
}

func assertPendingUsageWriteFailures(t *testing.T, ctx context.Context, db *sql.DB, repo repository.LiveKitRepository, queue pendingVoiceUsageQueue) {
	t.Helper()
	if _, err := db.ExecContext(ctx, `CREATE FUNCTION reject_pending_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'pending fixture failure'; END $$`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `CREATE TRIGGER reject_pending_fixture BEFORE INSERT OR UPDATE ON livekit_monthly_usage FOR EACH ROW EXECUTE FUNCTION reject_pending_fixture()`); err != nil {
		t.Fatal(err)
	}
	if applied, err := queue.ApplyNextVoiceUsage(ctx); err == nil || applied {
		t.Fatal("failed aggregate reported applied")
	}
	var pending int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM voice_usage_credits WHERE credit_id='pending-session' AND applied_at IS NULL`).Scan(&pending); err != nil || pending != 1 {
		t.Fatalf("pending handoff lost: %d %v", pending, err)
	}
	if _, err := db.ExecContext(ctx, `DROP TRIGGER reject_pending_fixture ON livekit_monthly_usage`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `CREATE TRIGGER reject_usage_marker BEFORE UPDATE ON voice_usage_credits FOR EACH ROW EXECUTE FUNCTION reject_pending_fixture()`); err != nil {
		t.Fatal(err)
	}
	if applied, err := queue.ApplyNextVoiceUsage(ctx); err == nil || applied {
		t.Fatal("marker failure reported applied")
	}
	used, err := repo.GetMonthlyUsage(ctx, "pending-instance", 2026, 1)
	if err != nil || used != 0 {
		t.Fatalf("failed marker committed aggregate: %d %v", used, err)
	}
	if _, err := db.ExecContext(ctx, `DROP TRIGGER reject_usage_marker ON voice_usage_credits`); err != nil {
		t.Fatal(err)
	}
}

func assertConcurrentUsageRecovery(t *testing.T, ctx context.Context, recovered pendingVoiceUsageQueue) {
	t.Helper()
	type applyResult struct {
		applied bool
		err     error
	}
	results := make(chan applyResult, 16)
	var workers sync.WaitGroup
	for i := 0; i < 16; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			applied, err := recovered.ApplyNextVoiceUsage(ctx)
			results <- applyResult{applied, err}
		}()
	}
	workers.Wait()
	close(results)
	appliedCount := 0
	for result := range results {
		if result.err != nil {
			t.Fatal(result.err)
		}
		if result.applied {
			appliedCount++
		}
	}
	if appliedCount != 1 {
		t.Fatalf("concurrent recovery applied=%d, want1", appliedCount)
	}
}

func assertOwnedPendingUsageRecovery(t *testing.T, ctx context.Context, db *sql.DB, repo repository.LiveKitRepository) {
	t.Helper()
	workerService := &voiceService{usageRecovery: repository.NewSQLiteLiveKitRepo(db)}
	stopWorker := startVoiceUsageDelivery(ctx, workerService, time.Millisecond)
	t.Cleanup(stopWorker)
	for {
		used, err := repo.GetMonthlyUsage(ctx, "pending-instance", 2026, 1)
		if err != nil {
			t.Fatal(err)
		}
		if used == 90 {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("owned worker did not recover durable pending credit")
		default:
			time.Sleep(time.Millisecond)
		}
	}
	stopWorker()
	if err := db.PingContext(ctx); err != nil {
		t.Fatalf("worker shutdown closed caller pool: %v", err)
	}
}

func TestVoiceUsagePostgresShutdownJoinsAcceptedCredit(t *testing.T) {
	db := postgresServerFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := db.ExecContext(ctx, `INSERT INTO livekit_instances(id,url,api_key,api_secret) VALUES('shutdown-instance','http://127.0.0.1','fixture','fixture')`); err != nil {
		t.Fatal(err)
	}
	repo := repository.NewSQLiteLiveKitRepo(db)
	svc, hub := newTestVoiceServiceWithLiveKitGetter(repo, NewDurableVoiceUsageCredit(repo))
	hub.BroadcastToServerFn = func(string, ws.Event) {}
	hub.BroadcastToUserFn = func(string, ws.Event) {}
	s := svc.(*voiceService)
	t.Cleanup(s.ShutdownUsageProducers)
	if err := s.JoinChannel("victim", "victim", "Victim", "", "ch1", false, false); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	state := s.states["victim"]
	state.LiveKitInstanceID = "shutdown-instance"
	state.LiveKitIsCloud = true
	state.JoinedAt = time.Now().Add(-time.Minute)
	id := state.UsageSessionID
	s.mu.Unlock()
	blocker, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback()
	if _, err = blocker.ExecContext(ctx, "LOCK TABLE livekit_monthly_usage IN ACCESS EXCLUSIVE MODE"); err != nil {
		t.Fatal(err)
	}
	if err = s.LeaveChannel("victim"); err != nil {
		t.Fatal(err)
	}
	waitVoiceUsagePostgresLock(t, ctx, blocker, "livekit_monthly_usage")
	var wantSeconds int
	if err = blocker.QueryRowContext(ctx, `SELECT seconds FROM voice_usage_credits WHERE credit_id=$1`, id).Scan(&wantSeconds); err != nil || wantSeconds <= 0 {
		t.Fatalf("accepted credit missing: seconds=%d err=%v", wantSeconds, err)
	}
	stopped := make(chan struct{})
	go func() { s.ShutdownUsageProducers(); close(stopped) }()
	waitVoiceUsageAdmissionClosed(t, &s.operations)
	select {
	case <-stopped:
		t.Fatal("shutdown returned while accepted PostgreSQL credit was blocked")
	default:
	}
	if err = blocker.Rollback(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-stopped:
	case <-ctx.Done():
		t.Fatal("shutdown did not join accepted PostgreSQL credit")
	}
	now := time.Now()
	used, err := repo.GetMonthlyUsage(ctx, "shutdown-instance", now.Year(), int(now.Month()))
	if err != nil || used != int64(wantSeconds) {
		t.Fatalf("accepted credit was not applied before shutdown: usage=%d want=%d err=%v", used, wantSeconds, err)
	}
}

func waitVoiceUsagePostgresLock(t *testing.T, ctx context.Context, tx *sql.Tx, table string) {
	t.Helper()
	for {
		var waiting bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE relation=$1::regclass AND NOT granted)", table).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatal("usage query never reached PostgreSQL lock wait")
		default:
			time.Sleep(time.Millisecond)
		}
	}
}

func TestVoiceUsagePostgresLateMemberRevocationPreservesCredit(t *testing.T) {
	db := postgresServerFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := db.ExecContext(ctx, `INSERT INTO livekit_instances(id,url,api_key,api_secret) VALUES('late-instance','http://127.0.0.1','fixture','fixture')`); err != nil {
		t.Fatal(err)
	}
	repo := repository.NewSQLiteLiveKitRepo(db)
	svc, _ := newTestVoiceServiceWithLiveKitGetter(repo, NewDurableVoiceUsageCredit(repo))
	s := svc.(*voiceService)
	s.states["victim"] = &models.VoiceState{UserID: "victim", ChannelID: "ch1", ServerID: "srv1", UsageSessionID: "late-credit", LiveKitInstanceID: "late-instance", LiveKitIsCloud: true, JoinedAt: time.Now().Add(-time.Minute)}
	s.ShutdownUsageProducers()
	s.DisconnectServerMember("srv1", "victim")
	s.DisconnectServerMember("srv1", "victim")
	var seconds int
	var applied bool
	if err := db.QueryRowContext(ctx, `SELECT seconds,applied_at IS NOT NULL FROM voice_usage_credits WHERE credit_id='late-credit'`).Scan(&seconds, &applied); err != nil {
		t.Fatal(err)
	}
	var used int64
	if err := db.QueryRowContext(ctx, `SELECT COALESCE(SUM(used_seconds),0) FROM livekit_monthly_usage WHERE instance_id='late-instance'`).Scan(&used); err != nil {
		t.Fatal(err)
	}
	if seconds <= 0 || !applied || used != int64(seconds) {
		t.Fatalf("late credit not applied once: seconds=%d applied=%v used=%d", seconds, applied, used)
	}
}

func TestVoiceUsagePostgresShutdownJoinsPermissionRecheck(t *testing.T) {
	db := postgresServerFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	blocker, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback()
	if _, err = blocker.ExecContext(ctx, "LOCK TABLE channels IN ACCESS EXCLUSIVE MODE"); err != nil {
		t.Fatal(err)
	}
	svc, hub := newTestVoiceService()
	s := svc.(*voiceService)
	s.states["reader"] = &models.VoiceState{UserID: "reader", ChannelID: "channel", ServerID: "server"}
	s.permResolver = newUncachedChannelPermService(repository.NewSQLiteChannelPermRepo(db), repository.NewSQLiteRoleRepo(db), repository.NewSQLiteChannelRepo(db), hub)
	rechecked, stopped := make(chan struct{}), make(chan struct{})
	go func() { s.recheckVoiceAccess("reader", "channel"); close(rechecked) }()
	t.Cleanup(func() { blocker.Rollback(); <-rechecked; s.ShutdownUsageProducers() })
	waitVoiceUsagePostgresLock(t, ctx, blocker, "channels")
	go func() { s.ShutdownUsageProducers(); close(stopped) }()
	waitVoiceUsageAdmissionClosed(t, &s.operations)
	select {
	case <-stopped:
		t.Fatal("shutdown returned before PostgreSQL permission lookup")
	case <-time.After(20 * time.Millisecond):
	}
	if err = blocker.Rollback(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-stopped:
	case <-ctx.Done():
		t.Fatal("permission lookup was not joined")
	}
	if s.GetUserVoiceState("reader") != nil {
		t.Fatal("revoked permission retained unauthorized voice session")
	}
}

func TestVoiceUsagePostgresShutdownFinalizesActiveSession(t *testing.T) {
	db := postgresServerFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := db.ExecContext(ctx, `INSERT INTO livekit_instances(id,url,api_key,api_secret) VALUES('active-instance','http://127.0.0.1','fixture','fixture')`); err != nil {
		t.Fatal(err)
	}
	repo := repository.NewSQLiteLiveKitRepo(db)
	svc, _ := newTestVoiceServiceWithLiveKitGetter(repo, NewDurableVoiceUsageCredit(repo))
	s := svc.(*voiceService)
	s.states["reader"] = &models.VoiceState{UserID: "reader", ChannelID: "channel", ServerID: "default", UsageSessionID: "active-credit", LiveKitInstanceID: "active-instance", LiveKitIsCloud: true, JoinedAt: time.Now().Add(-time.Minute)}
	s.ShutdownVoiceSessions()
	s.ShutdownVoiceSessions()
	var seconds int
	var applied bool
	if err := db.QueryRowContext(ctx, `SELECT seconds,applied_at IS NOT NULL FROM voice_usage_credits WHERE credit_id='active-credit'`).Scan(&seconds, &applied); err != nil {
		t.Fatal(err)
	}
	var used int64
	if err := db.QueryRowContext(ctx, `SELECT COALESCE(SUM(used_seconds),0) FROM livekit_monthly_usage WHERE instance_id='active-instance'`).Scan(&used); err != nil {
		t.Fatal(err)
	}
	if seconds <= 0 || !applied || used != int64(seconds) || len(s.GetAllVoiceStates()) != 0 {
		t.Fatalf("active shutdown incomplete: seconds=%d applied=%v usage=%d states=%d", seconds, applied, used, len(s.GetAllVoiceStates()))
	}
}

type blockedShutdownLiveKitRepo struct {
	repository.LiveKitRepository
	repository.VoiceUsageRecorder
	repository.VoiceUsageQueue
	entered, release chan struct{}
	once             sync.Once
}

func (r *blockedShutdownLiveKitRepo) GetByServerID(ctx context.Context, _ string) (*models.LiveKitInstance, error) {
	r.once.Do(func() { close(r.entered) })
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-r.release:
		return nil, errors.New("fixture has no media server")
	}
}

func TestVoiceUsagePostgresShutdownCreditsBeforeMediaWait(t *testing.T) {
	db := postgresServerFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := db.ExecContext(ctx, `INSERT INTO livekit_instances(id,url,api_key,api_secret) VALUES('blocked-media-instance','http://127.0.0.1','fixture','fixture')`); err != nil {
		t.Fatal(err)
	}
	repo := repository.NewSQLiteLiveKitRepo(db)
	getter := &blockedShutdownLiveKitRepo{LiveKitRepository: repo, VoiceUsageRecorder: repo.(repository.VoiceUsageRecorder), VoiceUsageQueue: repo.(repository.VoiceUsageQueue), entered: make(chan struct{}), release: make(chan struct{})}
	svc, _ := newTestVoiceServiceWithLiveKitGetter(getter, NewDurableVoiceUsageCredit(getter))
	s := svc.(*voiceService)
	s.states["reader"] = &models.VoiceState{UserID: "reader", ChannelID: "channel", ServerID: "default", UsageSessionID: "blocked-media-credit", LiveKitInstanceID: "blocked-media-instance", LiveKitIsCloud: true, JoinedAt: time.Now().Add(-time.Minute)}
	done := make(chan struct{})
	var release sync.Once
	t.Cleanup(func() { release.Do(func() { close(getter.release) }); <-done })
	go func() { s.ShutdownVoiceSessions(); close(done) }()
	select {
	case <-getter.entered:
	case <-ctx.Done():
		t.Fatal("media cleanup did not start")
	}
	var applied bool
	if err := db.QueryRowContext(ctx, `SELECT applied_at IS NOT NULL FROM voice_usage_credits WHERE credit_id='blocked-media-credit'`).Scan(&applied); err != nil || !applied {
		t.Fatalf("credit not durable before media wait: applied=%v err=%v", applied, err)
	}
	select {
	case <-done:
		t.Fatal("shutdown escaped blocked media cleanup")
	default:
	}
	release.Do(func() { close(getter.release) })
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("shutdown did not join media cleanup")
	}
}

func TestVoiceUsagePostgresShutdownHandsOffAllBeforeMedia(t *testing.T) {
	for _, mode := range []string{"music", "eviction"} {
		t.Run(mode, func(t *testing.T) {
			db := postgresServerFixture(t)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if _, err := db.ExecContext(ctx, `INSERT INTO livekit_instances(id,url,api_key,api_secret) VALUES('phase-instance','http://127.0.0.1','fixture','fixture')`); err != nil {
				t.Fatal(err)
			}
			repo := repository.NewSQLiteLiveKitRepo(db)
			getter := &blockedShutdownLiveKitRepo{LiveKitRepository: repo, VoiceUsageRecorder: repo.(repository.VoiceUsageRecorder), VoiceUsageQueue: repo.(repository.VoiceUsageQueue), entered: make(chan struct{}), release: make(chan struct{})}
			svc, _ := newTestVoiceServiceWithLiveKitGetter(getter, NewDurableVoiceUsageCredit(getter))
			s := svc.(*voiceService)
			joined := time.Now().Add(-time.Minute)
			for i := 0; i < 6; i++ {
				id := fmt.Sprintf("phase-user-%d", i)
				s.states[id] = &models.VoiceState{UserID: id, ChannelID: "channel", ServerID: "default", UsageSessionID: fmt.Sprintf("phase-credit-%d", i), LiveKitInstanceID: "phase-instance", LiveKitIsCloud: true, JoinedAt: joined}
			}
			if mode == "music" {
				s.musicBotHook = &mockMusicBotHook{StopAllForChannelFn: func(string) { getter.once.Do(func() { close(getter.entered) }); <-getter.release }}
			}
			done := make(chan struct{})
			var release sync.Once
			t.Cleanup(func() { release.Do(func() { close(getter.release) }); <-done })
			go func() { s.ShutdownVoiceSessions(); close(done) }()
			select {
			case <-getter.entered:
			case <-ctx.Done():
				t.Fatal("media stage did not start")
			}
			var count, applied, smallest, largest int
			if err := db.QueryRowContext(ctx, `SELECT COUNT(*),COUNT(applied_at),COALESCE(MIN(seconds),0),COALESCE(MAX(seconds),0) FROM voice_usage_credits`).Scan(&count, &applied, &smallest, &largest); err != nil {
				t.Fatal(err)
			}
			if count != 6 || applied != 6 || smallest <= 0 || smallest != largest {
				t.Fatalf("media started before all final credits: rows=%d applied=%d min=%d max=%d", count, applied, smallest, largest)
			}
			select {
			case <-done:
				t.Fatal("shutdown did not join media stage")
			default:
			}
			release.Do(func() { close(getter.release) })
			select {
			case <-done:
			case <-ctx.Done():
				t.Fatal("media stage not joined")
			}
		})
	}
}

func TestVoiceUsagePostgresShutdownRecoversFailedApplication(t *testing.T) {
	db := postgresServerFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, q := range []string{
		`INSERT INTO livekit_instances(id,url,api_key,api_secret) VALUES('shutdown-recover','http://127.0.0.1','fixture','fixture')`,
		`CREATE FUNCTION reject_shutdown_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'shutdown fixture failure'; END $$`,
		`CREATE TRIGGER reject_shutdown_fixture BEFORE INSERT OR UPDATE ON livekit_monthly_usage FOR EACH ROW EXECUTE FUNCTION reject_shutdown_fixture()`,
	} {
		if _, err := db.ExecContext(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	repo := repository.NewSQLiteLiveKitRepo(db)
	svc, _ := newTestVoiceServiceWithLiveKitGetter(repo, NewDurableVoiceUsageCredit(repo))
	s := svc.(*voiceService)
	s.states["reader"] = &models.VoiceState{UserID: "reader", ChannelID: "channel", ServerID: "default", UsageSessionID: "shutdown-recover-credit", LiveKitInstanceID: "shutdown-recover", LiveKitIsCloud: true, JoinedAt: time.Now().Add(-time.Minute)}
	s.ShutdownVoiceSessions()
	var seconds int
	var pending bool
	if err := db.QueryRowContext(ctx, `SELECT seconds,applied_at IS NULL FROM voice_usage_credits WHERE credit_id='shutdown-recover-credit'`).Scan(&seconds, &pending); err != nil || seconds <= 0 || !pending {
		t.Fatalf("failed application lost final credit: seconds=%d pending=%v err=%v", seconds, pending, err)
	}
	if _, err := db.ExecContext(ctx, `DROP TRIGGER reject_shutdown_fixture ON livekit_monthly_usage`); err != nil {
		t.Fatal(err)
	}
	freshRepo := repository.NewSQLiteLiveKitRepo(db)
	stop := startVoiceUsageDelivery(ctx, &voiceService{usageRecovery: freshRepo}, time.Millisecond)
	t.Cleanup(stop)
	for {
		var applied bool
		if err := db.QueryRowContext(ctx, `SELECT applied_at IS NOT NULL FROM voice_usage_credits WHERE credit_id='shutdown-recover-credit'`).Scan(&applied); err != nil {
			t.Fatal(err)
		}
		if applied {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("restart did not apply final credit")
		case <-time.After(time.Millisecond):
		}
	}
	stop()
	applied, err := freshRepo.(repository.VoiceUsageQueue).ApplyNextVoiceUsage(ctx)
	if err != nil || applied {
		t.Fatalf("recovered credit replayed: applied=%v err=%v", applied, err)
	}
	var used int64
	if err := db.QueryRowContext(ctx, `SELECT COALESCE(SUM(used_seconds),0) FROM livekit_monthly_usage WHERE instance_id='shutdown-recover'`).Scan(&used); err != nil || used != int64(seconds) {
		t.Fatalf("recovered final usage=%d want%d err=%v", used, seconds, err)
	}
}
