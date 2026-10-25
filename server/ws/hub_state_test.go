// Hub userInfos cache tests — SetUserInfo / UpdateUserInfo semantics and
// eviction on full disconnect (regression for the unbounded-growth +
// stale-profile-after-edit bugs fixed 2026-06).
package ws

import "testing"

func TestIsInvisibleReadsHiddenFlag(t *testing.T) {
	h := NewHub()
	if h.IsInvisible("u1") {
		t.Fatal("unknown user must not be invisible")
	}
	h.SetInvisible("u1", true)
	if !h.IsInvisible("u1") {
		t.Fatal("invisible flag was not observed")
	}
	h.SetInvisible("u1", false)
	if h.IsInvisible("u1") {
		t.Fatal("cleared invisible flag still observed")
	}
}

func TestUpdateUserInfo_RefreshesExistingEntry(t *testing.T) {
	h := NewHub()
	h.SetUserInfo("u1", "alice", "Alice", "/a.png")

	h.UpdateUserInfo("u1", "alice", "Alice Yeni", "/b.png")

	info := h.getUserInfo("u1")
	if info.DisplayName != "Alice Yeni" || info.AvatarURL != "/b.png" {
		t.Fatalf("expected refreshed info, got %+v", info)
	}
}

func TestUpdateUserInfo_UnknownUserIsNoOp(t *testing.T) {
	h := NewHub()

	h.UpdateUserInfo("ghost", "ghost", "Ghost", "")

	if info := h.getUserInfo("ghost"); info.Username != "" {
		t.Fatalf("UpdateUserInfo must not plant entries for unknown users, got %+v", info)
	}
}

func TestRemoveClient_EvictsUserInfoOnlyOnFullDisconnect(t *testing.T) {
	h := NewHub()
	c1 := &Client{hub: h, userID: "u1", send: make(chan []byte, 1), done: make(chan struct{})}
	c2 := &Client{hub: h, userID: "u1", send: make(chan []byte, 1), done: make(chan struct{})}
	h.SetUserInfo("u1", "alice", "Alice", "")
	h.addClient(c1)
	h.addClient(c2)

	h.removeClient(c1)
	if info := h.getUserInfo("u1"); info.Username != "alice" {
		t.Fatalf("partial disconnect must retain user info, got %+v", info)
	}

	h.removeClient(c2)
	if info := h.getUserInfo("u1"); info.Username != "" {
		t.Fatalf("full disconnect must evict user info, got %+v", info)
	}
}
