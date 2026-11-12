package services

import (
	"errors"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
	"github.com/google/uuid"
	"sync"
	"testing"
)

func activeSignalService(t *testing.T) (*p2pCallService, string) {
	t.Helper()
	s, _, _ := newManualP2PService()
	if err := s.InitiateCall("a", "b", models.P2PCallTypeVoice); err != nil {
		t.Fatal(err)
	}
	id := s.GetUserCall("a").ID
	if err := s.AcceptCall("b", id); err != nil {
		t.Fatal(err)
	}
	return s, id
}
func signalOffer(id string, revision uint64) ws.P2PSignalData {
	return ws.P2PSignalData{CallID: id, Type: "offer", SDP: "v=0", MediaProtocol: 1, DescriptionID: uuid.NewString(), DescriptionRevision: revision, Capabilities: []string{"screen-audio-v1"}, Sources: []ws.P2PMediaSource{{MID: "0", Source: "microphone"}, {MID: "1", Source: "screen-audio"}}}
}
func TestP2PSignalActiveMembershipAndLegacy(t *testing.T) {
	s, id := activeSignalService(t)
	sent := 0
	s.hub.(*testutil.MockEventPublisher).BroadcastToUserFn = func(user string, event ws.Event) {
		if user != "b" || event.Op != ws.OpP2PSignal {
			t.Error("wrong audience")
		}
		sent++
		_ = s.GetUserCall("a")
	}
	for _, signal := range []ws.P2PSignalData{{CallID: id, Type: "offer", SDP: "v=0"}, {CallID: id, Type: "answer", SDP: "v=0"}, {CallID: id, Type: "ice-candidate", Candidate: map[string]any{"candidate": "", "sdpMid": nil}}} {
		if err := s.RelaySignal("a", id, signal); err != nil {
			t.Fatal(err)
		}
	}
	if sent != 3 {
		t.Fatal(sent)
	}
	for _, mutation := range []func(){func() { s.activeCalls[id].Status = models.P2PCallStatusRinging }, func() { s.activeCalls[id].Status = models.P2PCallStatusActive; delete(s.userCalls, "b") }} {
		mutation()
		if err := s.RelaySignal("a", id, signalOffer(id, 1)); !errors.Is(err, pkg.ErrForbidden) {
			t.Fatalf("inactive/stale membership accepted: %v", err)
		}
	}
	s.userCalls["b"] = id
	if err := s.RelaySignal("outsider", id, signalOffer(id, 1)); !errors.Is(err, pkg.ErrForbidden) {
		t.Fatal(err)
	}
	if err := s.RelaySignal("a", "wrong", signalOffer(id, 1)); !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatal(err)
	}
	if sent != 3 {
		t.Fatal("denied signal broadcast")
	}
}
func TestP2PSignalRevisionAndAnswerRelation(t *testing.T) {
	s, id := activeSignalService(t)
	sent := 0
	s.hub.(*testutil.MockEventPublisher).BroadcastToUserFn = func(_ string, _ ws.Event) { sent++ }
	offer := signalOffer(id, 1)
	if err := s.RelaySignal("a", id, offer); err != nil {
		t.Fatal(err)
	}
	if err := s.RelaySignal("a", id, offer); !errors.Is(err, pkg.ErrConflict) {
		t.Fatal("duplicate offer accepted", err)
	}
	answer := signalOffer(id, 1)
	answer.Type = "answer"
	answer.ReplyToDescriptionID = uuid.NewString()
	if err := s.RelaySignal("b", id, answer); !errors.Is(err, pkg.ErrConflict) {
		t.Fatal("unrelated answer accepted", err)
	}
	answer.ReplyToDescriptionID = offer.DescriptionID
	if err := s.RelaySignal("b", id, answer); err != nil {
		t.Fatal(err)
	}
	replay := answer
	replay.DescriptionRevision = 2
	replay.DescriptionID = uuid.NewString()
	if err := s.RelaySignal("b", id, replay); !errors.Is(err, pkg.ErrConflict) {
		t.Fatal("consumed answer accepted", err)
	}
	newer := signalOffer(id, 2)
	if err := s.RelaySignal("a", id, newer); err != nil {
		t.Fatal(err)
	}
	stale := signalOffer(id, 3)
	stale.Type = "answer"
	stale.ReplyToDescriptionID = offer.DescriptionID
	if err := s.RelaySignal("b", id, stale); !errors.Is(err, pkg.ErrConflict) {
		t.Fatal("superseded answer accepted", err)
	}
	stale.ReplyToDescriptionID = newer.DescriptionID
	if err := s.RelaySignal("b", id, stale); err != nil {
		t.Fatal(err)
	}
	if sent != 4 {
		t.Fatal(sent)
	}
	if err := s.EndCall("a"); err != nil {
		t.Fatal(err)
	}
	if len(s.signals) != 0 {
		t.Fatal("ended call revisions retained")
	}
	if err := s.RelaySignal("a", id, signalOffer(id, 4)); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatal(err)
	}
}
func TestP2PSignalConcurrentDuplicateOnlyOneRelayed(t *testing.T) {
	s, id := activeSignalService(t)
	signal := signalOffer(id, 1)
	var mu sync.Mutex
	count := 0
	s.hub.(*testutil.MockEventPublisher).BroadcastToUserFn = func(_ string, _ ws.Event) { mu.Lock(); count++; mu.Unlock() }
	var wg sync.WaitGroup
	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			err := s.RelaySignal("a", id, signal)
			if err != nil && !errors.Is(err, pkg.ErrConflict) {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if count != 1 {
		t.Fatal(count)
	}
}

func TestP2PSignalLegacyDescriptionInvalidatesPendingV1Relation(t *testing.T) {
	for _, kind := range []string{"offer", "answer"} {
		t.Run(kind, func(t *testing.T) {
			s, id := activeSignalService(t)
			offer := signalOffer(id, 1)
			if err := s.RelaySignal("a", id, offer); err != nil {
				t.Fatal(err)
			}
			actor := "a"
			if kind == "answer" {
				actor = "b"
			}
			if err := s.RelaySignal(actor, id, ws.P2PSignalData{CallID: id, Type: kind, SDP: "v=0"}); err != nil {
				t.Fatal(err)
			}
			answer := signalOffer(id, 1)
			answer.Type = "answer"
			answer.ReplyToDescriptionID = offer.DescriptionID
			if err := s.RelaySignal("b", id, answer); !errors.Is(err, pkg.ErrConflict) {
				t.Fatal("legacy-replaced offer revived", err)
			}
		})
	}
}

func TestP2PSignalGlareAnswerSupersedesOwnPendingOffer(t *testing.T) {
	s, id := activeSignalService(t)
	a, b := signalOffer(id, 1), signalOffer(id, 1)
	if err := s.RelaySignal("a", id, a); err != nil {
		t.Fatal(err)
	}
	if err := s.RelaySignal("b", id, b); err != nil {
		t.Fatal(err)
	}
	answerA := signalOffer(id, 2)
	answerA.Type = "answer"
	answerA.ReplyToDescriptionID = b.DescriptionID
	if err := s.RelaySignal("a", id, answerA); err != nil {
		t.Fatal(err)
	}
	answerB := signalOffer(id, 2)
	answerB.Type = "answer"
	answerB.ReplyToDescriptionID = a.DescriptionID
	if err := s.RelaySignal("b", id, answerB); !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("rolled back own offer remained answerable: %v", err)
	}
	if s.signals[id]["a"].pendingOffer != "" {
		t.Fatal("answer retained superseded own offer")
	}
}
