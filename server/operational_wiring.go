package main

import (
	"github.com/argeinfina/hichat/config"
	"github.com/argeinfina/hichat/services"
	"time"
)

type operationalDependencies struct {
	Repositories *Repositories
	Config       *config.Config
	ScreenShares services.ScreenShareCounter
	Reachability services.LiveKitReachabilityReporter
}
type operationalServices struct {
	History        services.MetricsHistoryService
	Feedback       services.FeedbackService
	FeedbackUpload services.FeedbackUploadService
	Collector      services.MetricsCollector
}

// initOperationalServices constructs operational services without starting the
// collector worker. The caller owns Stop until successful transfer to main.
func initOperationalServices(deps operationalDependencies) operationalServices {
	for _, input := range []struct {
		name  string
		value any
	}{{"Repositories", deps.Repositories}, {"Config", deps.Config}, {"ScreenShares", deps.ScreenShares}} {
		if missingCompositionInput(input.value) {
			panic("operations requires " + input.name)
		}
	}
	// Nil explicitly disables readiness enrichment; typed nil is invalid.
	if deps.Reachability != nil && missingCompositionInput(deps.Reachability) {
		panic("operations readiness provider is typed nil")
	}
	repos, cfg := deps.Repositories, deps.Config
	for _, input := range []struct {
		name  string
		value any
	}{{"MetricsHistory", repos.MetricsHistory}, {"LiveKit", repos.LiveKit}, {"Feedback", repos.Feedback}} {
		if missingCompositionInput(input.value) {
			panic("operations requires repository " + input.name)
		}
	}
	history := services.NewMetricsHistoryService(repos.MetricsHistory, repos.LiveKit)
	feedback := services.NewFeedbackService(repos.Feedback)
	feedback.SetUploadDir(cfg.Upload.Dir)
	upload := services.NewFeedbackUploadService(repos.Feedback, cfg.Upload.Dir, cfg.Upload.MaxSize)
	collector := services.NewMetricsCollector(repos.LiveKit, repos.MetricsHistory, 5*time.Minute, 30, cfg.HetznerAPIToken, deps.ScreenShares, deps.Reachability)
	return operationalServices{History: history, Feedback: feedback, FeedbackUpload: upload, Collector: collector}
}
