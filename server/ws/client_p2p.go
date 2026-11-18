// P2P call event handlers (initiate/accept/decline/end, WebRTC signaling).
package ws

import (
	"encoding/json"
)

// ─── P2P Call Event Handlers ───

func (c *Client) handleP2PCallInitiate(event Event) {
	dataBytes, err := json.Marshal(event.Data)
	if err != nil {
		return
	}

	var data P2PCallInitiateData
	if err := json.Unmarshal(dataBytes, &data); err != nil {
		return
	}

	if data.ReceiverID == "" || data.CallType == "" {
		dispatchLogger.Warn("p2p_call_initiate missing fields", "user_id", c.userID)
		return
	}

	if c.hub.onP2PCallInitiate != nil {
		c.dispatchOwnedCallback("ws.p2p_call_initiate", func() { c.hub.onP2PCallInitiate(c.userID, data) })
	}
}

func (c *Client) handleP2PCallAccept(event Event) {
	dataBytes, err := json.Marshal(event.Data)
	if err != nil {
		return
	}

	var data P2PCallAcceptData
	if err := json.Unmarshal(dataBytes, &data); err != nil {
		return
	}

	if data.CallID == "" {
		dispatchLogger.Warn("p2p_call_accept missing call_id", "user_id", c.userID)
		return
	}

	if c.hub.onP2PCallAccept != nil {
		c.dispatchOwnedCallback("ws.p2p_call_accept", func() { c.hub.onP2PCallAccept(c.userID, data) })
	}
}

func (c *Client) handleP2PCallDecline(event Event) {
	dataBytes, err := json.Marshal(event.Data)
	if err != nil {
		return
	}

	var data P2PCallDeclineData
	if err := json.Unmarshal(dataBytes, &data); err != nil {
		return
	}

	if data.CallID == "" {
		dispatchLogger.Warn("p2p_call_decline missing call_id", "user_id", c.userID)
		return
	}

	if c.hub.onP2PCallDecline != nil {
		c.dispatchOwnedCallback("ws.p2p_call_decline", func() { c.hub.onP2PCallDecline(c.userID, data) })
	}
}

// Older clients omit the payload or send an empty object.
func (c *Client) handleP2PCallEnd(event Event) {
	var callID string
	if event.Data != nil {
		fields, ok := event.Data.(map[string]any)
		if !ok {
			return
		}
		if len(fields) > 0 {
			callID, ok = fields["call_id"].(string)
			if !ok || callID == "" {
				return
			}
		}
	}
	if c.hub.onP2PCallEnd != nil {
		c.dispatchOwnedCallback("ws.p2p_call_end", func() { c.hub.onP2PCallEnd(c.userID, callID) })
	}
}

// handleP2PSignal relays WebRTC SDP/ICE data to the other peer.
func (c *Client) handleP2PSignal(event Event) {
	dataBytes, err := json.Marshal(event.Data)
	if err != nil {
		return
	}

	var data P2PSignalData
	if err := json.Unmarshal(dataBytes, &data); err != nil {
		return
	}

	if err := data.Validate(); err != nil {
		dispatchLogger.Warn("p2p_signal invalid payload", "user_id", c.userID)
		return
	}

	if c.hub.onP2PSignal != nil {
		c.dispatchOwnedCallback("ws.p2p_signal", func() { c.hub.onP2PSignal(c.userID, data) })
	}
}
