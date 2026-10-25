package repository

import (
	"context"
	"testing"

	"github.com/argeinfina/hichat/models"
)

func TestReportRepositoryPersistsMessageContextAndConsent(t *testing.T) {
	for _, sourceKind := range []string{"channel", "dm", "group"} {
		t.Run(sourceKind, func(t *testing.T) {
			db := newTestDB(t)
			ctx := context.Background()
			users := NewSQLiteUserRepo(db.Conn)
			seedUsers := []*models.User{
				{ID: "reporter", Username: "reporter", PasswordHash: "hash", Status: models.UserStatusOffline},
				{ID: "target", Username: "target", PasswordHash: "hash", Status: models.UserStatusOffline},
			}
			for _, user := range seedUsers {
				if err := users.Create(ctx, user); err != nil {
					t.Fatalf("create user: %v", err)
				}
			}

			repo := NewSQLiteReportRepo(db.Conn)
			kind, serverID, channelID, messageID, evidence := sourceKind, "s1", "c1", "m1", "shared plaintext"
			report := &models.Report{
				ID: "r1", ReporterID: seedUsers[0].ID, ReportedUserID: seedUsers[1].ID,
				Reason: models.ReportReasonHarassment, Description: "A detailed description",
				Status: models.ReportStatusPending, SourceKind: &kind, SourceServerID: &serverID,
				SourceChannelID: &channelID, SourceMessageID: &messageID,
				EvidenceContent: &evidence, EvidenceShared: true,
			}
			if sourceKind != "channel" {
				report.SourceServerID = nil
			}
			if err := repo.Create(ctx, report); err != nil {
				t.Fatalf("Create: %v", err)
			}

			got, err := repo.GetByID(ctx, report.ID)
			if err != nil {
				t.Fatalf("GetByID: %v", err)
			}
			if got.SourceMessageID == nil || *got.SourceMessageID != messageID || !got.EvidenceShared || got.EvidenceContent == nil || *got.EvidenceContent != evidence {
				t.Fatalf("context did not round-trip: %+v", got)
			}
			if got.SourceKind == nil || *got.SourceKind != sourceKind || (sourceKind != "channel" && got.SourceServerID != nil) {
				t.Fatalf("wrong source context: %+v", got)
			}
			pending, err := repo.HasPendingMessageReport(ctx, seedUsers[0].ID, messageID)
			if err != nil || !pending {
				t.Fatalf("HasPendingMessageReport = %v, %v", pending, err)
			}

			listed, total, err := repo.ListPending(ctx, 10, 0)
			if err != nil || total != 1 || len(listed) != 1 || listed[0].SourceMessageID == nil || *listed[0].SourceMessageID != messageID {
				t.Fatalf("ListPending = %+v, total=%d, err=%v", listed, total, err)
			}
			if listed[0].SourceKind == nil || *listed[0].SourceKind != sourceKind || listed[0].EvidenceContent == nil || *listed[0].EvidenceContent != evidence || !listed[0].EvidenceShared {
				t.Fatalf("admin evidence missing: %+v", listed[0])
			}
		})
	}
}
