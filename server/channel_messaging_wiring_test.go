package main

import (
	"fmt"
	"github.com/argeinfina/hichat/config"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
	"reflect"
	"testing"
)

func TestChannelMessagingRejectsMissingCompositionInputs(t *testing.T) {
	for _, name := range []string{"repositories", "config", "hub", "typed nil hub", "permissions", "typed nil permissions"} {
		t.Run(name, func(t *testing.T) {
			repos, cfg := &Repositories{}, &config.Config{}
			var hub channelMessagingHub = ws.NewHub()
			var permissions services.ChannelPermResolver = &testutil.MockChannelPermResolver{}
			want := name
			switch name {
			case "repositories":
				repos = nil
			case "config":
				cfg = nil
			case "hub":
				hub = nil
			case "typed nil hub":
				var value *ws.Hub
				hub = value
				want = "hub"
			case "permissions":
				permissions = nil
			case "typed nil permissions":
				var value *testutil.MockChannelPermResolver
				permissions = value
				want = "permissions"
			}
			var caught any
			func() {
				defer func() { caught = recover() }()
				initChannelMessagingServices(nil, repos, hub, cfg, permissions, nil)
			}()
			if fmt.Sprint(caught) != "channel messaging requires "+want {
				t.Fatalf("panic=%v want missing %s", caught, want)
			}
		})
	}
}

func TestChannelMessagingSQLiteModeRetainsDeclaredOwners(t *testing.T) {
	db, repos := startupServiceDependencies(t)
	group := initChannelMessagingServices(db, repos, ws.NewHub(), &config.Config{}, &testutil.MockChannelPermResolver{}, nil)
	if group.Message == nil || group.Upload == nil || group.Notifications == nil || group.DeliveryDB != nil {
		t.Fatalf("standalone owners=%+v", group)
	}
}

func TestChannelMessagingRejectsMissingRepositoryReaders(t *testing.T) {
	base := startupPolicyRepositories(t)
	for _, field := range []string{"Message", "Attachment", "Channel", "User", "Mention", "RoleMention", "Role", "Reaction", "ReadState", "MemberTimeout", "Notification", "Preferences"} {
		t.Run(field, func(t *testing.T) {
			repos := *base
			value := reflect.ValueOf(&repos).Elem().FieldByName(field)
			value.Set(reflect.Zero(value.Type()))
			var caught any
			func() {
				defer func() { caught = recover() }()
				initChannelMessagingServices(nil, &repos, ws.NewHub(), &config.Config{}, &testutil.MockChannelPermResolver{}, nil)
			}()
			if fmt.Sprint(caught) != "channel messaging requires repository "+field {
				t.Fatalf("panic=%v want missing %s", caught, field)
			}
		})
	}
}

type nilMessagingMessage struct{ repository.MessageRepository }

func TestChannelMessagingRejectsTypedNilMessageRepository(t *testing.T) {
	repos := startupPolicyRepositories(t)
	var missing *nilMessagingMessage
	repos.Message = missing
	var caught any
	func() {
		defer func() { caught = recover() }()
		initChannelMessagingServices(nil, repos, ws.NewHub(), &config.Config{}, &testutil.MockChannelPermResolver{}, nil)
	}()
	if fmt.Sprint(caught) != "channel messaging requires repository Message" {
		t.Fatalf("typed nil repository accepted: %v", caught)
	}
}

func TestChannelMessagingRejectsMissingTransactionDatabase(t *testing.T) {
	repos := startupPolicyRepositories(t)
	var caught any
	func() {
		defer func() { caught = recover() }()
		initChannelMessagingServices(nil, repos, ws.NewHub(), &config.Config{}, &testutil.MockChannelPermResolver{}, nil)
	}()
	if fmt.Sprint(caught) != "channel messaging requires transaction database" {
		t.Fatalf("missing database accepted: %v", caught)
	}
}
