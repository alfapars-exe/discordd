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

func TestRegistrationProfileFollowsActiveConnections(t *testing.T) {
	h := NewHub()
	connect := func(name string, rejected bool) *Client {
		c := &Client{hub: h, userID: "reader", done: make(chan struct{}), registrationProfile: &cachedUserInfo{Username: name}}
		if rejected {
			c.closeDone()
		}
		h.addClient(c)
		return c
	}

	rejected := connect("rejected", true)
	if rejected.registrationProfile != nil {
		t.Fatal("rejected client retained its registration profile")
	}
	if len(h.userInfos) != 0 {
		t.Fatal("rejected registration retained a profile")
	}
	first := connect("original", false)
	h.UpdateUserInfo("reader", "updated", "", "")
	second := connect("stale", false)
	h.removeClient(first)
	if got := h.getUserUsername("reader"); got != "updated" {
		t.Fatalf("second tab replaced the active profile: %q", got)
	}
	h.removeClient(second)
	if len(h.userInfos) != 0 {
		t.Fatal("last disconnect retained a profile")
	}
}
