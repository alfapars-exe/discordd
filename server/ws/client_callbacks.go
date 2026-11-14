package ws

// dispatchOwnedCallback shares Hub callback ownership and per-user ordering.
// Reserve under Hub.mu so shutdown closes admission before joining workers.
func (c *Client) dispatchOwnedCallback(name string, callback func()) {
	h := c.hub
	h.mu.Lock()
	if h.shuttingDown {
		h.mu.Unlock()
		return
	}
	ticket := h.presenceCallbacks.reserve(c.userID, name)
	h.mu.Unlock()
	h.presenceCallbacks.submit(ticket, callback)
}
