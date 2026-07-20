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
		go c.hub.onP2PCallInitiate(c.userID, data)
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
		go c.hub.onP2PCallAccept(c.userID, data)
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
		go c.hub.onP2PCallDecline(c.userID, data)
	}
}

// handleP2PCallEnd — no payload needed, userID identifies the active call.
func (c *Client) handleP2PCallEnd() {
	if c.hub.onP2PCallEnd != nil {
		go c.hub.onP2PCallEnd(c.userID)
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

	if data.CallID == "" || data.Type == "" {
		dispatchLogger.Warn("p2p_signal missing fields", "user_id", c.userID)
		return
	}

	if c.hub.onP2PSignal != nil {
		go c.hub.onP2PSignal(c.userID, data)
	}
}
