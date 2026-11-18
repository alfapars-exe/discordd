package services

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
)

func TestVoiceUsagePostgresChannelDeletionHandsOffAllBeforeMedia(t *testing.T) {
	for _, mode := range []string{"admitted-eviction", "closed-eviction", "closed-music"} {
		t.Run(mode, func(t *testing.T) {
			db := postgresServerFixture(t)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if _, err := db.ExecContext(ctx, `INSERT INTO livekit_instances(id,url,api_key,api_secret) VALUES('deletion-phase','http://127.0.0.1','fixture','fixture')`); err != nil {
				t.Fatal(err)
			}
			repo := repository.NewSQLiteLiveKitRepo(db)
			getter := &blockedShutdownLiveKitRepo{LiveKitRepository: repo, VoiceUsageRecorder: repo.(repository.VoiceUsageRecorder), VoiceUsageQueue: repo.(repository.VoiceUsageQueue), entered: make(chan struct{}), release: make(chan struct{})}
			svc, _ := newTestVoiceServiceWithLiveKitGetter(getter, NewDurableVoiceUsageCredit(getter))
			s := svc.(*voiceService)
			joined := time.Now().Add(-time.Minute)
			for i := 0; i < 6; i++ {
				id := fmt.Sprintf("deletion-user-%d", i)
				s.states[id] = &models.VoiceState{UserID: id, ChannelID: "channel", ServerID: "default", UsageSessionID: fmt.Sprintf("deletion-credit-%d", i), LiveKitInstanceID: "deletion-phase", LiveKitIsCloud: true, JoinedAt: joined}
			}
			if mode == "closed-music" {
				s.musicBotHook = &mockMusicBotHook{StopAllForChannelFn: func(string) { getter.once.Do(func() { close(getter.entered) }); <-getter.release }}
			}
			if mode != "admitted-eviction" {
				s.ShutdownUsageProducers()
			}
			done := make(chan struct{})
			var release sync.Once
			t.Cleanup(func() { release.Do(func() { close(getter.release) }); <-done })
			go func() { s.DeleteVoiceChannel(ctx, "default", "channel"); s.ShutdownUsageProducers(); close(done) }()
			select {
			case <-getter.entered:
			case <-ctx.Done():
				t.Fatal("deletion media stage did not start")
			}
			var count, applied, smallest, largest int
			var ledger, used int64
			if err := db.QueryRowContext(ctx, `SELECT COUNT(*),COUNT(applied_at),COALESCE(MIN(seconds),0),COALESCE(MAX(seconds),0),COALESCE(SUM(seconds),0) FROM voice_usage_credits WHERE instance_id='deletion-phase'`).Scan(&count, &applied, &smallest, &largest, &ledger); err != nil {
				t.Fatal(err)
			}
			if err := db.QueryRowContext(ctx, `SELECT COALESCE(SUM(used_seconds),0) FROM livekit_monthly_usage WHERE instance_id='deletion-phase'`).Scan(&used); err != nil {
				t.Fatal(err)
			}
			if count != 6 || applied != 6 || smallest <= 0 || smallest != largest || used != ledger {
				t.Fatalf("incomplete handoff before deletion media: rows=%d applied=%d min=%d max=%d used=%d ledger=%d", count, applied, smallest, largest, used, ledger)
			}
			select {
			case <-done:
				t.Fatal("deletion owner escaped blocked media")
			default:
			}
			release.Do(func() { close(getter.release) })
			select {
			case <-done:
			case <-ctx.Done():
				t.Fatal("deletion owner did not join cleanup")
			}
		})
	}
}
