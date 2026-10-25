package models

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	EmailCategoryCommunication   = "communication"
	EmailCategorySocial          = "social"
	EmailCategoryAnnouncements   = "announcements"
	EmailCategoryTips            = "tips"
	EmailCategoryRecommendations = "recommendations"
)

type EmailDeliveryJob struct {
	ID, UserID, Category, Subject, BodyHTML, Status string
	Address, LastError, DedupeKey                   string
	ServerEventID, ServerEventStartsAt              string
	ExpiresAt                                       string
	NotBefore, DMMessageID                          string
	FriendshipID, FriendshipEvent                   string
	ClaimToken                                      string `json:"-"`
	Attempts                                        int
	// Delivery-time count only; never persisted or populated from message text.
	DMUnreadCount int `json:"-"`
}

func (j *EmailDeliveryJob) Validate() error {
	allowed := map[string]bool{EmailCategoryCommunication: true, EmailCategorySocial: true, EmailCategoryAnnouncements: true, EmailCategoryTips: true, EmailCategoryRecommendations: true}
	if !allowed[j.Category] || strings.TrimSpace(j.DedupeKey) == "" || utf8.RuneCountInString(j.DedupeKey) > 200 || strings.TrimSpace(j.Subject) == "" || utf8.RuneCountInString(j.Subject) > 200 || strings.TrimSpace(j.BodyHTML) == "" || len(j.BodyHTML) > 256*1024 {
		return fmt.Errorf("invalid email delivery job")
	}
	if (j.ServerEventID == "") != (j.ServerEventStartsAt == "") {
		return fmt.Errorf("invalid email delivery event context")
	}
	contexts := 0
	if j.DMMessageID != "" {
		contexts++
	}
	if j.FriendshipID != "" || j.FriendshipEvent != "" {
		contexts++
	}
	if j.ServerEventID != "" {
		contexts++
	}
	if contexts > 1 {
		return fmt.Errorf("email delivery event contexts are mutually exclusive")
	}
	if j.ServerEventID != "" && (j.Category != EmailCategorySocial || strings.TrimSpace(j.ServerEventID) != j.ServerEventID || len(j.ServerEventID) > 128 || len(j.ServerEventStartsAt) > 64) {
		return fmt.Errorf("invalid email delivery event context")
	}
	if j.ExpiresAt != "" {
		if _, err := time.Parse(time.RFC3339Nano, j.ExpiresAt); err != nil {
			return fmt.Errorf("invalid email delivery expiry")
		}
	}
	if j.NotBefore != "" {
		notBefore, err := time.Parse(time.RFC3339Nano, j.NotBefore)
		if err != nil {
			return fmt.Errorf("invalid email delivery not-before time")
		}
		if j.ExpiresAt != "" {
			expiresAt, _ := time.Parse(time.RFC3339Nano, j.ExpiresAt)
			if !expiresAt.After(notBefore) {
				return fmt.Errorf("invalid email delivery schedule")
			}
		}
	}
	if j.DMMessageID != "" && (j.Category != EmailCategoryCommunication || strings.TrimSpace(j.DMMessageID) != j.DMMessageID || len(j.DMMessageID) > 128) {
		return fmt.Errorf("invalid email delivery DM context")
	}
	if (j.FriendshipID == "") != (j.FriendshipEvent == "") || (j.FriendshipID != "" && (j.Category != EmailCategorySocial || strings.TrimSpace(j.FriendshipID) != j.FriendshipID || len(j.FriendshipID) > 128 || (j.FriendshipEvent != "request" && j.FriendshipEvent != "accepted"))) {
		return fmt.Errorf("invalid email delivery friendship context")
	}
	return nil
}
