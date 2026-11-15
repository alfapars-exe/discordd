package services

import (
	"context"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type optionalReadinessHistory struct {
	repository.MetricsHistoryRepository
	rows []models.MetricsSnapshot
}

func (r *optionalReadinessHistory) Insert(_ context.Context, row *models.MetricsSnapshot) error {
	r.rows = append(r.rows, *row)
	return nil
}

type optionalReadinessReporter struct{ observations []bool }

func (r *optionalReadinessReporter) ReportLiveKitReachable(ok bool) {
	r.observations = append(r.observations, ok)
}

type optionalReadinessTransport func(*http.Request) (*http.Response, error)

func (f optionalReadinessTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestMetricsOptionalReadinessPreservesCollectionAndCancellation(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		for _, cancelled := range []bool{false, true} {
			name := "disabled"
			if enabled {
				name = "enabled"
			}
			if cancelled {
				name += "/cancelled"
			}
			t.Run(name, func(t *testing.T) {
				history := &optionalReadinessHistory{}
				reporter := &optionalReadinessReporter{}
				var readiness LiveKitReachabilityReporter
				if enabled {
					readiness = reporter
				}
				collector := NewMetricsCollector(nil, history, time.Hour, 30, "", nil, readiness).(*metricsCollector)
				t.Cleanup(collector.Stop)
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				collector.httpClient = &http.Client{Transport: optionalReadinessTransport(func(req *http.Request) (*http.Response, error) {
					if cancelled {
						cancel()
						return nil, context.Canceled
					}
					return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader("livekit_room_total 2\nlivekit_participant_total 3\n")), Header: make(http.Header), Request: req}, nil
				})}
				collector.collectOne(ctx, &models.LiveKitInstance{ID: "fixture", URL: "ws://metrics.example.invalid:7880"}, time.Now())
				if cancelled {
					if len(history.rows) != 0 || len(reporter.observations) != 0 {
						t.Fatal("cancelled collection recorded snapshot or outage")
					}
					return
				}
				if len(history.rows) != 1 || !history.rows[0].Available || history.rows[0].RoomCount != 2 || history.rows[0].ParticipantCount != 3 {
					t.Fatalf("snapshot=%+v", history.rows)
				}
				if enabled {
					if len(reporter.observations) != 1 || !reporter.observations[0] {
						t.Fatalf("readiness=%v", reporter.observations)
					}
				} else if len(reporter.observations) != 0 {
					t.Fatal("disabled readiness reported")
				}
			})
		}
	}
}
