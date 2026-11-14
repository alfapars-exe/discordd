package services

import "context"

func (b *BackupService) initializeLifecycleLocked() {
	if b.operationsDone == nil {
		b.operationsDone = make(chan struct{})
	}
	if b.svcCancel == nil {
		parent := b.svcCtx
		if parent == nil {
			parent = context.Background()
		}
		b.svcCtx, b.svcCancel = context.WithCancel(parent)
	}
}

func (b *BackupService) beginBackupOperation(parent context.Context) (context.Context, func(), bool) {
	b.lifecycleMu.Lock()
	b.initializeLifecycleLocked()
	if b.stopping {
		b.lifecycleMu.Unlock()
		return nil, nil, false
	}
	b.activeOperations++
	service := b.svcCtx
	b.lifecycleMu.Unlock()
	ctx, cancel := context.WithCancel(parent)
	stopCancellation := context.AfterFunc(service, cancel)
	return ctx, func() { stopCancellation(); cancel(); b.finishBackupOperation() }, true
}

func (b *BackupService) finishBackupOperation() {
	b.lifecycleMu.Lock()
	defer b.lifecycleMu.Unlock()
	b.activeOperations--
	if b.stopping && b.activeOperations == 0 {
		close(b.operationsDone)
	}
}
