package services

import (
	"context"
	"github.com/argeinfina/hichat/models"
	"sync"
	"testing"
)

func TestChannelDeliveryWakeCoalesces(t *testing.T) {
	s := &messageService{deliveryWake: make(chan struct{}, 1)}
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); s.wakeChannelDelivery() }()
	}
	wg.Wait()
	if len(s.deliveryWake) != 1 {
		t.Fatal("wake hints must coalesce")
	}
	<-s.deliveryWake
	s.wakeChannelDelivery()
	if len(s.deliveryWake) != 1 {
		t.Fatal("wake must rearm")
	}
	(&messageService{}).wakeChannelDelivery() // legacy fixtures never block
}

func TestChannelDeliveryCommitWake(t *testing.T) {
	s, _, _, _ := channelDeliveryFixture(t)
	ctx := context.Background()
	_, err := s.Create(ctx, "default", "channel", "sender", &models.CreateMessageRequest{Content: "wake", ClientMessageID: "wake"})
	if err != nil {
		t.Fatal(err)
	}
	if len(s.deliveryWake) != 1 {
		t.Fatal("committed send must wake worker")
	}
	<-s.deliveryWake
	_, err = s.Create(ctx, "default", "missing", "sender", &models.CreateMessageRequest{Content: "reject", ClientMessageID: "reject"})
	if err == nil {
		t.Fatal("expected failed send")
	}
	if len(s.deliveryWake) != 0 {
		t.Fatal("failed send must not wake worker")
	}
	// A lost hint cannot lose the durable event.
	s.deliveryTick(ctx)
	health, err := s.ChannelDeliveryHealth(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if health.Pending != 0 {
		t.Fatalf("poll must drain without hint: %+v", health)
	}
}

func TestChannelDeliveryAttachmentWakeAfterPreparation(t *testing.T) {
	s, _, _, _ := channelDeliveryFixture(t)
	ctx := context.Background()
	message, err := s.Create(ctx, "default", "channel", "sender", &models.CreateMessageRequest{Content: "attachment", HasFiles: true, FileNames: []string{"file"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(s.deliveryWake) != 0 {
		t.Fatal("attachment send woke before preparation completed")
	}
	if err := s.CompleteChannelSend(ctx, message); err != nil {
		t.Fatal(err)
	}
	if len(s.deliveryWake) != 1 {
		t.Fatal("completed attachment preparation did not wake delivery")
	}
}
