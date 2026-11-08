package pkg

import (
	"context"
	"fmt"
	"net/http"
	"time"
)

type voiceTimingKey struct{}
type voiceTiming struct {
	last   time.Time
	header http.Header
}

// TimeVoiceToken attaches Server-Timing only to this request's synchronous
// admission path. Labels are constant and carry no account or room data.
func TimeVoiceToken(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		timing := &voiceTiming{last: time.Now(), header: w.Header()}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), voiceTimingKey{}, timing)))
	})
}

func MarkVoiceTime(ctx context.Context, name string) {
	if t, ok := ctx.Value(voiceTimingKey{}).(*voiceTiming); ok {
		now := time.Now()
		t.header.Add("Server-Timing", fmt.Sprintf("%s;dur=%.1f", name, float64(now.Sub(t.last).Microseconds())/1000))
		t.last = now
	}
}
