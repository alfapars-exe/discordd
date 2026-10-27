package repository

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

func TestDataExportOwnAttachmentsAndConversationMemberships(t *testing.T) {
	db := newTestDB(t)
	const envelope = `{"opaque_envelope": "sealed+/cipher==", "version": 1}`
	execSeed(t, db, []seedStmt{
		{q: `INSERT INTO users(id,username,password_hash) VALUES('conv-owner','convowner','owner-password-secret'),('conv-peer','convpeer','peer-password-secret'),('conv-other','convother','other-password-secret')`},
		{q: `INSERT INTO servers(id,name,owner_id) VALUES('conv-server','Shared','conv-peer')`},
		{q: `INSERT INTO channels(id,name,type,server_id) VALUES('conv-channel','Shared','text','conv-server')`},
		{q: `INSERT INTO messages(id,channel_id,user_id,content,encryption_version,ciphertext,sender_device_id,e2ee_metadata) VALUES('channel-own','conv-channel','conv-owner',NULL,1,'channel+/cipher==','device',?),('channel-peer','conv-channel','conv-peer','excluded-peer-plaintext',0,NULL,NULL,NULL)`, args: []any{envelope}},
		{q: `INSERT INTO attachments(id,message_id,filename,file_url,file_size,mime_type,created_at) VALUES('channel-file-b','channel-own','opaque.bin','/files/channel-b',99,'application/octet-stream','2026-10-01 00:00:00'),('channel-file-a','channel-own','opaque-null.bin','/files/channel-a',NULL,NULL,'2026-10-01 00:00:00'),('excluded-channel-peer-file','channel-peer','excluded-peer-file','/files/excluded-channel-peer',3,'text/plain','2026-10-01 00:00:00')`},
		{q: `INSERT INTO dm_channels(id,user1_id,user2_id,e2ee_enabled,status,initiated_by) VALUES('dm-owner-first','conv-owner','conv-peer',1,'accepted','conv-peer'),('dm-owner-second','conv-other','conv-owner',1,'pending','conv-owner'),('excluded-dm','conv-peer','conv-other',1,'accepted','conv-peer')`},
		{q: `INSERT INTO dm_messages(id,dm_channel_id,user_id,content,encryption_version,ciphertext,sender_device_id,e2ee_metadata) VALUES('dm-own','dm-owner-first','conv-owner',NULL,1,'dm+/cipher==','device',?),('dm-peer','dm-owner-first','conv-peer','excluded-peer-plaintext',0,NULL,NULL,NULL),('excluded-dm-message','excluded-dm','conv-peer','excluded-conversation-message',0,NULL,NULL,NULL)`, args: []any{envelope}},
		{q: `INSERT INTO dm_attachments(id,dm_message_id,filename,file_url,file_size,mime_type) VALUES('dm-file','dm-own','opaque.bin','/files/dm-own',101,'application/octet-stream'),('excluded-dm-peer-file','dm-peer','excluded-peer-file','/files/excluded-dm-peer',3,'text/plain'),('excluded-other-dm-file','excluded-dm-message','excluded-peer-file','/files/excluded-other-dm',3,'text/plain')`},
		{q: `INSERT INTO group_dm_channels(id,owner_id,name,icon_url,key_epoch,call_room_key) VALUES('group-member','conv-peer','Shared group','/icons/shared',4,'excluded-room-secret'),('group-left','conv-peer','Old group',NULL,3,'excluded-old-room-secret'),('excluded-group','conv-peer','excluded-foreign-group',NULL,1,'excluded-foreign-room-secret')`},
		{q: `INSERT INTO group_dm_members(group_id,user_id,is_muted,settings_revision) VALUES('group-member','conv-owner',1,5),('group-member','conv-peer',0,91),('group-left','conv-peer',0,92),('excluded-group','conv-peer',0,93)`},
		{q: `INSERT INTO group_dm_messages(id,group_id,user_id,content,encryption_version,ciphertext,sender_device_id,e2ee_metadata,key_epoch) VALUES('group-own','group-member','conv-owner',NULL,1,'group+/cipher==','device',?,4),('group-own-left','group-left','conv-owner',NULL,1,'left+/cipher==','device',?,3),('group-peer','group-member','conv-peer',NULL,1,'excluded-peer-ciphertext','peer-device',?,4),('excluded-group-message','excluded-group','conv-peer',NULL,1,'excluded-foreign-ciphertext','peer-device',?,1)`, args: []any{envelope, envelope, envelope, envelope}},
		{q: `INSERT INTO group_dm_attachments(id,group_message_id,filename,file_url,file_size,mime_type,file_key_index) VALUES('group-file','group-own','opaque.bin','/files/group-own',102,'application/octet-stream',0),('group-left-file','group-own-left','opaque.bin','/files/group-left',NULL,NULL,NULL),('excluded-group-peer-file','group-peer','excluded-peer-file','/files/excluded-group-peer',3,'text/plain',0),('excluded-other-group-file','excluded-group-message','excluded-peer-file','/files/excluded-other-group',3,'text/plain',0)`},
	})
	repo := NewSQLiteDataExportRepo(wrapForRepo(db))
	ctx := context.Background()
	job, err := repo.Create(ctx, &models.User{ID: "conv-owner"})
	if err != nil {
		t.Fatal(err)
	}
	payload, err := repo.Download(ctx, "conv-owner", job.ID)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(payload, &doc); err != nil {
		t.Fatal(err)
	}
	decode := func(section string) []map[string]any {
		t.Helper()
		var rows []map[string]any
		if err := json.Unmarshal(doc[section], &rows); err != nil {
			t.Fatalf("section %s: %v", section, err)
		}
		return rows
	}
	assertKeys := func(row map[string]any, keys ...string) {
		t.Helper()
		var got []string
		for k := range row {
			got = append(got, k)
		}
		sort.Strings(got)
		sort.Strings(keys)
		if !reflect.DeepEqual(got, keys) {
			t.Fatalf("unexpected export keys: got %v; want %v", got, keys)
		}
	}
	for section, wantIDs := range map[string][]string{"channel_attachments": {"channel-file-a", "channel-file-b"}, "direct_message_attachments": {"dm-file"}, "group_attachments": {"group-file", "group-left-file"}} {
		rows := decode(section)
		var ids []string
		for _, row := range rows {
			ids = append(ids, row["id"].(string))
			keys := []string{"id", "filename", "file_url", "file_size", "mime_type", "created_at"}
			switch section {
			case "channel_attachments":
				keys = append(keys, "message_id", "channel_id")
			case "direct_message_attachments":
				keys = append(keys, "dm_message_id", "dm_channel_id")
			case "group_attachments":
				keys = append(keys, "group_message_id", "group_id", "file_key_index")
			}
			assertKeys(row, keys...)
		}
		sort.Strings(ids)
		if !reflect.DeepEqual(ids, wantIDs) {
			t.Fatalf("%s: got %v; want %v", section, ids, wantIDs)
		}
	}
	var archiveSnapshot string
	if err := db.Conn.QueryRow(`SELECT attachment_payload FROM data_exports WHERE id=?`, job.ID).Scan(&archiveSnapshot); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(archiveSnapshot, `"encryption_version":1`) || !strings.Contains(archiveSnapshot, `"file_url":"/files/channel-b"`) {
		t.Fatal("private archive snapshot omitted metadata needed to package owned attachments")
	}
	files := decode("channel_attachments")
	if files[0]["id"] != "channel-file-a" || files[0]["file_size"] != nil || files[0]["mime_type"] != nil || files[1]["file_size"] != float64(99) || files[1]["file_url"] != "/files/channel-b" {
		t.Fatal("attachment ordering or nullable metadata changed")
	}
	dms := decode("direct_message_memberships")
	if len(dms) != 2 {
		t.Fatalf("own DM memberships: %d", len(dms))
	}
	if dms[0]["dm_channel_id"] != "dm-owner-first" || dms[1]["dm_channel_id"] != "dm-owner-second" || dms[1]["status"] != "pending" || dms[1]["initiated_by"] != "conv-owner" {
		t.Fatal("DM export omitted one owner position or changed request metadata")
	}
	for _, row := range dms {
		assertKeys(row, "dm_channel_id", "user1_id", "user2_id", "e2ee_enabled", "status", "initiated_by", "created_at", "last_message_at")
	}
	groups := decode("group_memberships")
	if len(groups) != 1 || groups[0]["group_id"] != "group-member" || groups[0]["is_muted"] != float64(1) || groups[0]["settings_revision"] != float64(5) || groups[0]["key_epoch"] != float64(4) {
		t.Fatal("group export included another member or lost owner preferences")
	}
	assertKeys(groups[0], "group_id", "name", "icon_url", "owner_id", "key_epoch", "created_at", "updated_at", "joined_at", "is_muted", "settings_revision")
	groupFiles := decode("group_attachments")
	byAttachmentID := map[string]map[string]any{}
	for _, row := range groupFiles {
		byAttachmentID[row["id"].(string)] = row
	}
	if byAttachmentID["group-file"]["file_key_index"] != float64(0) || byAttachmentID["group-left-file"]["file_key_index"] != nil {
		t.Fatal("opaque attachment key index changed")
	}
	for section, cipher := range map[string]string{"channel_messages": "channel+/cipher==", "direct_messages": "dm+/cipher==", "group_messages": "group+/cipher=="} {
		rows := decode(section)
		found := false
		for _, row := range rows {
			if row["ciphertext"] == cipher {
				found = true
				if row["content"] != nil || row["encryption_version"] != float64(1) || row["e2ee_metadata"] != envelope {
					t.Fatalf("%s encrypted message changed", section)
				}
			}
		}
		if !found {
			t.Fatalf("missing opaque ciphertext: %s", section)
		}
	}
	for _, marker := range []string{"excluded-", "password-secret", "call_room_key", "file_key\"", "raw_key\""} {
		if strings.Contains(string(payload), marker) {
			t.Fatalf("export leaked peer data or secret field: %s", marker)
		}
	}
	if _, err := repo.Download(ctx, "conv-peer", job.ID); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("peer download: %v", err)
	}
}

func TestDataExportEmptyConversationMetadataArrays(t *testing.T) {
	db := newTestDB(t)
	execSeed(t, db, []seedStmt{{q: `INSERT INTO users(id,username,password_hash) VALUES('empty-conv','emptyconv','hash')`}})
	repo := NewSQLiteDataExportRepo(wrapForRepo(db))
	job, err := repo.Create(context.Background(), &models.User{ID: "empty-conv"})
	if err != nil {
		t.Fatal(err)
	}
	payload, err := repo.Download(context.Background(), "empty-conv", job.ID)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(payload, &doc); err != nil {
		t.Fatal(err)
	}
	for _, section := range []string{"direct_message_memberships", "group_memberships", "channel_attachments", "direct_message_attachments", "group_attachments"} {
		if string(doc[section]) != "[]" {
			t.Fatalf("%s: expected empty array, got %s", section, doc[section])
		}
	}
}
