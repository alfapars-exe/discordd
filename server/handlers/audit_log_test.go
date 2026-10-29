package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/argeinfina/hichat/models"
)

type auditHistoryServiceStub struct{ entries []models.AuditLog }

func (s *auditHistoryServiceStub) Write(models.AuditLog) {}
func (s *auditHistoryServiceStub) Start()                {}
func (s *auditHistoryServiceStub) Stop()                 {}
func (s *auditHistoryServiceStub) List(context.Context, string, models.AuditLogFilter) ([]models.AuditLog, error) {
	return s.entries, nil
}

func TestAuditHistoryResponseUsesClientEnvelope(t *testing.T) {
	for _, entries := range [][]models.AuditLog{nil, {{ID: "persisted-history", ServerID: "srv", EventType: models.AuditEventType("server_mute")}}} {
		req := httptest.NewRequest(http.MethodGet, "/api/servers/srv/audit", nil)
		req.SetPathValue("serverId", "srv")
		req = req.WithContext(context.WithValue(req.Context(), UserContextKey, &models.User{ID: "viewer"}))
		rec := httptest.NewRecorder()
		NewAuditLogHandler(&auditHistoryServiceStub{entries: entries}).ListServerAudit(rec, req)
		var body struct {
			Success bool `json:"success"`
			Data    *struct {
				Entries []models.AuditLog `json:"entries"`
			} `json:"data"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if rec.Code != http.StatusOK || !body.Success || body.Data == nil {
			t.Fatalf("history must use the client's success/data envelope: %s", rec.Body.String())
		}
		if body.Data.Entries == nil {
			t.Fatal("empty history must be an array, not null")
		}
		if len(body.Data.Entries) != len(entries) {
			t.Fatalf("got %d records, want %d", len(body.Data.Entries), len(entries))
		}
	}
}
