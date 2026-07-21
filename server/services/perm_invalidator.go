package services

// multiInvalidator fans a single PermissionInvalidator call out to several
// underlying caches. Wired in main.go so that role/member write paths only
// need to hold one PermissionInvalidator dependency while actually
// invalidating both channelPermService's per-channel cache and
// middleware.PermissionMiddleware's per-server cache — two independent
// caches keyed differently (userID:channelID vs userID:serverID) that both
// memoize a function of the same underlying role data.
type multiInvalidator struct {
	targets []PermissionInvalidator
}

// NewMultiInvalidator returns a PermissionInvalidator that forwards every
// call to each of targets, in order. Nil targets are not filtered — callers
// are expected to pass only wired invalidators.
func NewMultiInvalidator(targets ...PermissionInvalidator) PermissionInvalidator {
	return &multiInvalidator{targets: targets}
}

func (m *multiInvalidator) InvalidateUser(userID string) {
	for _, t := range m.targets {
		t.InvalidateUser(userID)
	}
}

func (m *multiInvalidator) InvalidateAll() {
	for _, t := range m.targets {
		t.InvalidateAll()
	}
}
