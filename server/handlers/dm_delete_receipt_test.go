package handlers

import (
	"context"
	"encoding/json"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/services"
	"net/http/httptest"
	"testing"
)

type deletionReceiptStub struct{ services.DMService }

func (deletionReceiptStub) DeleteMessageWithReceipt(context.Context, string, string) (*models.DMMessageDeleteReceipt, error) {
	return &models.DMMessageDeleteReceipt{ID: "m", DMChannelID: "ch", Message: "message deleted"}, nil
}
func TestDMDeleteHTTPReturnsCommittedScope(t *testing.T) {
	handler := &DMHandler{dmService: deletionReceiptStub{}}
	req := httptest.NewRequest("DELETE", "/api/dms/messages/m", nil)
	req.SetPathValue("id", "m")
	req = req.WithContext(context.WithValue(req.Context(), UserContextKey, &models.User{ID: "alice"}))
	response := httptest.NewRecorder()
	handler.DeleteMessage(response, req)
	var body struct {
		Success bool                          `json:"success"`
		Data    models.DMMessageDeleteReceipt `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if response.Code != 200 || !body.Success || body.Data.ID != "m" || body.Data.DMChannelID != "ch" || body.Data.Message != "message deleted" {
		t.Fatalf("%d %s", response.Code, response.Body.String())
	}
}
