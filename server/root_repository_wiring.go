package main

// validateRootRepositoryProviders covers services constructed directly in the
// root, including worker owners inside the returned bundle. Domain groups
// validate their own inputs before acquiring resources.
func validateRootRepositoryProviders(repos *Repositories) {
	if repos == nil {
		panic("services requires Repositories")
	}
	for _, input := range []struct {
		name  string
		value any
	}{
		{"ServerEvent", repos.ServerEvent}, {"Server", repos.Server}, {"Role", repos.Role}, {"Channel", repos.Channel}, {"Invite", repos.Invite}, {"Friendship", repos.Friendship},
		{"ServerMute", repos.ServerMute}, {"ChannelMute", repos.ChannelMute}, {"LinkPreview", repos.LinkPreview}, {"Badge", repos.Badge},
		{"EmailCampaign", repos.EmailCampaign}, {"AccountAssetCleanup", repos.AccountAssetCleanup}, {"Reminder", repos.Reminder}, {"ProfileShowcase", repos.ProfileShowcase},
		{"ServerEventDelivery", repos.ServerEventDelivery}, {"FriendAnniversary", repos.FriendAnniversary},
	} {
		if missingCompositionInput(input.value) {
			panic("services requires repository " + input.name)
		}
	}
}
