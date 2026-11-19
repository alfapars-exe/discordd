package database

import (
	"context"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

// QueueWakeChannel is the NOTIFY channel raised by migration 056 when durable
// queue work becomes ready. The payload is the queue table name.
const QueueWakeChannel = "hichat_queue_wake"

// Queue tables that publish wake notifications.
const (
	WakeChannelDelivery      = "channel_delivery_outbox"
	WakeDMDelivery           = "dm_delivery_outbox"
	WakeChannelNotifications = "channel_message_notification_jobs"
)

// QueueWaker fans PostgreSQL wake notifications out to in-process workers.
// A wake is only a hint: workers still poll at a bounded idle interval, so a
// lost notification delays work but never strands it.
type QueueWaker struct {
	mu   sync.Mutex
	subs map[string][]chan struct{}
}

func NewQueueWaker() *QueueWaker {
	return &QueueWaker{subs: make(map[string][]chan struct{})}
}

// Subscribe returns a coalescing wake channel for table. A nil waker returns a
// nil channel, which never fires, so workers degrade to idle polling.
func (w *QueueWaker) Subscribe(table string) <-chan struct{} {
	if w == nil {
		return nil
	}
	ch := make(chan struct{}, 1)
	w.mu.Lock()
	w.subs[table] = append(w.subs[table], ch)
	w.mu.Unlock()
	return ch
}

// Wake signals every subscriber of table without blocking.
func (w *QueueWaker) Wake(table string) {
	if w == nil {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, ch := range w.subs[table] {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

func (w *QueueWaker) wakeAll() {
	w.mu.Lock()
	tables := make([]string, 0, len(w.subs))
	for table := range w.subs {
		tables = append(tables, table)
	}
	w.mu.Unlock()
	for _, table := range tables {
		w.Wake(table)
	}
}

// Run holds one dedicated LISTEN connection outside the pool until ctx ends.
// After every (re)connect it wakes all workers once, because notifications
// sent while disconnected are lost. onError (optional) reports connection loss.
func (w *QueueWaker) Run(ctx context.Context, connect func(context.Context) (*pgx.Conn, error), onError func(error)) {
	if w == nil || connect == nil {
		return
	}
	backoff := time.Second
	for ctx.Err() == nil {
		err := w.listen(ctx, connect)
		if ctx.Err() != nil {
			return
		}
		if onError != nil && err != nil {
			onError(err)
		}
		timer := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}

func (w *QueueWaker) listen(ctx context.Context, connect func(context.Context) (*pgx.Conn, error)) error {
	conn, err := connect(ctx)
	if err != nil {
		return err
	}
	defer func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = conn.Close(closeCtx)
		cancel()
	}()
	if _, err = conn.Exec(ctx, "LISTEN "+QueueWakeChannel); err != nil {
		return err
	}
	w.wakeAll()
	for {
		n, err := conn.WaitForNotification(ctx)
		if err != nil {
			return err
		}
		w.Wake(n.Payload)
	}
}

// QueueWakeConnector opens a dedicated connection with the pool's verified TLS
// settings, or returns nil when the database cannot LISTEN (non-PostgreSQL).
func (d *DB) QueueWakeConnector() func(context.Context) (*pgx.Conn, error) {
	if d == nil || d.listenConfig == nil {
		return nil
	}
	cfg := d.listenConfig.Copy()
	return func(ctx context.Context) (*pgx.Conn, error) {
		return pgx.ConnectConfig(ctx, cfg.Copy())
	}
}
