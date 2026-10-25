package services

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
)

type p2pFriendLookup struct{}

func (p2pFriendLookup) GetByPair(context.Context, string, string) (*models.Friendship, error) {
	return &models.Friendship{Status: models.FriendshipStatusAccepted}, nil
}

type p2pUserLookup struct{}

func (p2pUserLookup) GetByID(_ context.Context, id string) (*models.User, error) {
	return &models.User{ID: id, Username: id}, nil
}

type manualP2PTimer struct {
	fn      func()
	stopped bool
}

func (t *manualP2PTimer) Stop() bool { was := !t.stopped; t.stopped = true; return was }
func (t *manualP2PTimer) Fire() {
	if !t.stopped {
		t.fn()
	}
}

func newManualP2PService() (*p2pCallService, *testutil.MockEventPublisher, **manualP2PTimer) {
	hub := &testutil.MockEventPublisher{}
	svc := NewP2PCallService(p2pFriendLookup{}, p2pUserLookup{}, hub).(*p2pCallService)
	var timer *manualP2PTimer
	svc.afterFunc = func(d time.Duration, fn func()) p2pCallTimer {
		if d != p2pRingTimeout {
			panic("ring deadline changed")
		}
		timer = &manualP2PTimer{fn: fn}
		return timer
	}
	return svc, hub, &timer
}

func TestP2PCallRingTimeoutEndsBothPartiesAndEnqueuesGenericMissedCall(t *testing.T) {
	svc, hub, timerPtr := newManualP2PService()
	var delivered []struct {
		user  string
		event ws.Event
	}
	hub.BroadcastToUserFn = func(user string, event ws.Event) {
		delivered = append(delivered, struct {
			user  string
			event ws.Event
		}{user, event})
	}
	enqueuer := &stubEmailEnqueuer{}
	svc.SetEmailEnqueuer(enqueuer)
	if err := svc.InitiateCall("caller", "receiver", models.P2PCallTypeVoice); err != nil {
		t.Fatal(err)
	}
	call := svc.GetUserCall("caller")
	if call == nil || call.Status != models.P2PCallStatusRinging {
		t.Fatalf("call=%+v", call)
	}
	(*timerPtr).Fire()
	if svc.GetUserCall("caller") != nil || svc.GetUserCall("receiver") != nil {
		t.Fatal("timed-out call remained active")
	}
	if len(enqueuer.calls) != 1 {
		t.Fatalf("enqueue calls=%+v", enqueuer.calls)
	}
	queued := enqueuer.calls[0]
	if queued.userID != "receiver" || queued.category != models.EmailCategoryCommunication || queued.dedupeKey != "missed-call:"+call.ID {
		t.Fatalf("missed-call job=%+v", queued)
	}
	if queued.subject == "" || queued.body == "" || queued.userID == "caller" {
		t.Fatalf("invalid generic email: %+v", queued)
	}
	if len(delivered) != 4 {
		t.Fatalf("broadcasts=%d want two initiates and two timeout ends", len(delivered))
	}
	for _, sent := range delivered[2:] {
		if sent.event.Op != ws.OpP2PCallEnd || sent.event.Data.(map[string]string)["call_id"] != call.ID || sent.event.Data.(map[string]string)["reason"] != "no_answer" {
			t.Fatalf("timeout event=%+v", sent)
		}
	}
}

func TestP2PCallTerminalActionsCancelRingTimer(t *testing.T) {
	for _, action := range []string{"accept", "decline", "end", "disconnect"} {
		t.Run(action, func(t *testing.T) {
			svc, _, timerPtr := newManualP2PService()
			enqueuer := &stubEmailEnqueuer{}
			svc.SetEmailEnqueuer(enqueuer)
			if err := svc.InitiateCall("caller", "receiver", models.P2PCallTypeVideo); err != nil {
				t.Fatal(err)
			}
			timer := *timerPtr
			call := svc.GetUserCall("caller")
			if call == nil {
				t.Fatal("ringing call missing")
			}
			var err error
			switch action {
			case "accept":
				err = svc.AcceptCall("receiver", svc.GetUserCall("caller").ID)
			case "decline":
				err = svc.DeclineCall("receiver", svc.GetUserCall("caller").ID)
			case "end":
				err = svc.EndCall("caller")
			case "disconnect":
				svc.HandleDisconnect("receiver")
			}
			if err != nil {
				t.Fatalf("terminal action: %v", err)
			}
			if !timer.stopped {
				t.Fatal("terminal action did not stop server ring timer")
			}
			if action == "accept" && !errors.Is(svc.AcceptCall("receiver", "missing"), pkg.ErrNotFound) { // a second, late event cannot resurrect it
				t.Fatal("missing call did not remain absent")
			}
			// Simulate the actual captured callback already runnable when Stop raced it.
			timer.fn()
			timer.Fire()
			if len(enqueuer.calls) != 0 {
				t.Fatalf("terminal call enqueued missed-call email: %+v", enqueuer.calls)
			}
		})
	}
}

func TestP2PCallSnapshotDoesNotExposeMutableState(t *testing.T) {
	svc, _, _ := newManualP2PService()
	if err := svc.InitiateCall("caller", "receiver", models.P2PCallTypeVoice); err != nil {
		t.Fatal(err)
	}
	before := svc.GetUserCall("caller")
	before.CallerID = "untrusted mutation"
	if svc.GetUserCall("caller").CallerID != "caller" {
		t.Fatal("snapshot mutation changed service state")
	}
	var readers sync.WaitGroup
	readers.Add(1)
	go func() {
		defer readers.Done()
		for range 1000 {
			if snapshot := svc.GetUserCall("caller"); snapshot != nil {
				_ = snapshot.Status
			}
		}
	}()
	if err := svc.AcceptCall("receiver", before.ID); err != nil {
		t.Fatal(err)
	}
	readers.Wait()
	if before.Status != models.P2PCallStatusRinging || svc.GetUserCall("caller").Status != models.P2PCallStatusActive {
		t.Fatal("snapshot was changed by acceptance")
	}
}
