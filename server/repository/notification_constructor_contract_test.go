package repository

import (
	"context"
	"reflect"
	"testing"

	"github.com/argeinfina/hichat/models"
)

func TestNotificationConstructorDeclaresReactionWriter(t *testing.T) {
	required := reflect.TypeFor[interface {
		CreateReactionIfAbsent(context.Context, *models.Notification, string) (bool, error)
	}]()
	if got := reflect.TypeOf(NewSQLiteNotificationRepo).Out(0); !got.Implements(required) {
		t.Fatalf("notification factory result %s omits required reaction writer", got)
	}
}
