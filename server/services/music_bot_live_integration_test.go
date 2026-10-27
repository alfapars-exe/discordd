package services

// Opt-in external integration. Starts no services and never uses real user
// credentials: point it at a disposable loopback LiveKit --dev instance.
// MUSIC_YOUTUBE_SMOKE_URL must be a public video you are permitted to play.
import (
	"context"
	"encoding/binary"
	"fmt"
	"math"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg/crypto"
	"github.com/argeinfina/hichat/testutil"
	livekitproto "github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	lke2ee "github.com/livekit/server-sdk-go/v2/e2ee"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media/oggwriter"
)

type staticMusicRoomKey struct{ passphrase string }

func (s staticMusicRoomKey) MusicRoomKey(string) (string, uint32, error) {
	return s.passphrase, 0, nil
}

type observedMusicListenerKeys struct {
	*lke2ee.ExternalKeyProvider
	rotatedLookups atomic.Int64
}

func (p *observedMusicListenerKeys) GetKey(index uint32) ([]byte, error) {
	key, err := p.ExternalKeyProvider.GetKey(index)
	if err == nil && index == 1 {
		p.rotatedLookups.Add(1)
	}
	return key, err
}

func TestMusicYouTubeLiveKitSmoke(t *testing.T) {
	videoURL := os.Getenv("MUSIC_YOUTUBE_SMOKE_URL")
	lkURL := os.Getenv("MUSIC_LIVEKIT_SMOKE_URL")
	if videoURL == "" || lkURL == "" {
		t.Skip("set MUSIC_YOUTUBE_SMOKE_URL + MUSIC_LIVEKIT_SMOKE_URL; requires yt-dlp, deno, ffmpeg")
	}
	u, err := url.Parse(lkURL)
	if err != nil || (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost" && u.Hostname() != "::1") {
		t.Fatal("smoke test requires disposable loopback LiveKit, never production")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	channelID := fmt.Sprintf("music-smoke-%d", time.Now().UnixNano())
	const serverID = "integration"
	roomName := serverID + ":" + channelID
	var packets atomic.Int64
	var rotatedPackets atomic.Int64
	var captureStarted atomic.Bool
	var stopping atomic.Bool
	var listenerRoom atomic.Pointer[lksdk.Room]
	var sampleMu sync.Mutex
	var receiveErr error
	oggPath := filepath.Join(t.TempDir(), "received.ogg")
	writer, err := oggwriter.New(oggPath, 48000, 2)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	rotatedPath := filepath.Join(t.TempDir(), "rotated.ogg")
	rotatedWriter, err := oggwriter.New(rotatedPath, 48000, 2)
	if err != nil {
		t.Fatal(err)
	}
	defer rotatedWriter.Close()
	listenerKeys := &observedMusicListenerKeys{ExternalKeyProvider: lke2ee.NewExternalKeyProvider()}
	roomKeys := &mutableMusicRoomKey{passphrase: "music-live-smoke"}
	if err := listenerKeys.SetKeyFromPassphrase("music-live-smoke", 0); err != nil {
		t.Fatal(err)
	}
	listener, err := lksdk.ConnectToRoom(lkURL, lksdk.ConnectInfo{APIKey: "devkey", APISecret: "secret", RoomName: roomName, ParticipantIdentity: "music-smoke-listener"}, &lksdk.RoomCallback{
		ParticipantCallback: lksdk.ParticipantCallback{OnTrackSubscribed: func(track *webrtc.TrackRemote, publication *lksdk.RemoteTrackPublication, participant *lksdk.RemoteParticipant) {
			if !strings.HasPrefix(participant.Identity(), models.MusicBotUserID+":") {
				return
			}
			if publication.TrackInfo().GetEncryption() != livekitproto.Encryption_GCM {
				sampleMu.Lock()
				receiveErr = fmt.Errorf("music track was published without GCM encryption")
				sampleMu.Unlock()
				return
			}
			currentRoom := listenerRoom.Load()
			if currentRoom == nil {
				sampleMu.Lock()
				receiveErr = fmt.Errorf("music listener room is not ready")
				sampleMu.Unlock()
				return
			}
			// LiveKit injects silence before a publisher sends real media.
			// Its room-specific trailer lets the SDK discard those frames;
			// they must never be mistaken for encrypted music or counted.
			decryptor, decryptErr := lksdk.NewFrameDecryptor(listenerKeys, lksdk.CodecOpus, currentRoom.SifTrailer())
			if decryptErr != nil {
				sampleMu.Lock()
				receiveErr = decryptErr
				sampleMu.Unlock()
				return
			}
			decryptedTrack := lke2ee.NewTrackDecryptor(track, decryptor)
			go func() {
				var sequence uint16
				var timestamp uint32
				var rotatedSequence uint16
				var rotatedTimestamp uint32
				for ctx.Err() == nil {
					deadline, _ := ctx.Deadline()
					_ = track.SetReadDeadline(deadline)
					sample, readErr := decryptedTrack.ReadSample()
					if readErr != nil {
						if ctx.Err() == nil && !stopping.Load() {
							sampleMu.Lock()
							receiveErr = fmt.Errorf("read/decrypt music sample: %w", readErr)
							sampleMu.Unlock()
						}
						return
					}
					if sample == nil {
						continue
					}
					// The SDK sends silence/padding before the extractor is ready.
					// That proves connectivity, not YouTube playback.
					if !captureStarted.Load() {
						continue
					}
					packet := &rtp.Packet{Header: rtp.Header{Version: 2, PayloadType: 111, SequenceNumber: sequence, Timestamp: timestamp, SSRC: 1}, Payload: sample.Data}
					sequence++
					timestamp += 960
					sampleMu.Lock()
					if packets.Load() < 100 {
						if err := writer.WriteRTP(packet); err != nil {
							receiveErr = err
						}
					}
					if listenerKeys.rotatedLookups.Load() > 0 {
						if rotatedPackets.Load() < 100 {
							rotatedPacket := &rtp.Packet{Header: rtp.Header{Version: 2, PayloadType: 111, SequenceNumber: rotatedSequence, Timestamp: rotatedTimestamp, SSRC: 2}, Payload: sample.Data}
							if err := rotatedWriter.WriteRTP(rotatedPacket); err != nil {
								receiveErr = err
							}
							rotatedSequence++
							rotatedTimestamp += 960
						}
						rotatedPackets.Add(1)
					}
					sampleMu.Unlock()
					packets.Add(1)
				}
			}()
		}},
	}, lksdk.WithConnectTimeout(10*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	listenerRoom.Store(listener)
	defer listener.Disconnect()
	key := []byte("01234567890123456789012345678901") // disposable test encryption key
	apiKey, err := crypto.Encrypt("devkey", key)
	if err != nil {
		t.Fatal(err)
	}
	secret, err := crypto.Encrypt("secret", key)
	if err != nil {
		t.Fatal(err)
	}
	lk := &mockConfigurableLiveKitGetter{GetByServerIDFn: func(context.Context, string) (*models.LiveKitInstance, error) {
		return &models.LiveKitInstance{URL: lkURL, APIKey: apiKey, APISecret: secret}, nil
	}}
	svc := NewMusicBotService(&stubChannelGetter{channel: &models.Channel{ID: channelID, ServerID: serverID, Type: models.ChannelTypeVoice}}, lk, nil, &testutil.MockBroadcaster{}, stubMusicUserGetter{}, key, nil, nil, roomKeys)
	defer svc.Stop(channelID)
	tracks, err := svc.Enqueue(ctx, "integration-user", channelID, videoURL)
	if err != nil {
		t.Fatal(err)
	}
	if len(tracks) != 1 {
		t.Fatalf("expected single YouTube track, got %d", len(tracks))
	}
	await := func(label string, cond func() bool) {
		t.Helper()
		timer := time.NewTicker(20 * time.Millisecond)
		defer timer.Stop()
		for !cond() {
			sampleMu.Lock()
			captureErr := receiveErr
			sampleMu.Unlock()
			if captureErr != nil {
				t.Fatalf("%s: %v", label, captureErr)
			}
			select {
			case <-ctx.Done():
				t.Fatalf("%s: timeout", label)
			case <-timer.C:
			}
		}
	}
	await("extractor first audio", func() bool {
		state := svc.GetState(channelID)
		return state != nil && state.StartedAt != nil && state.ElapsedSeconds >= .1
	})
	captureStarted.Store(true)
	await("actual RTP audio", func() bool { return packets.Load() >= 100 })
	// An opt-in external controller can interrupt the disposable LiveKit server
	// at this point. The ordinary smoke test never waits for this handshake.
	if marker := os.Getenv("MUSIC_SMOKE_INTERRUPT_MARKER"); marker != "" {
		if _, err := os.Stat(marker + ".resume"); err == nil {
			t.Fatal("interruption resume marker already exists; use a fresh marker path")
		} else if !os.IsNotExist(err) {
			t.Fatalf("check interruption resume marker: %v", err)
		}
		if err := os.WriteFile(marker, []byte("audio-ready"), 0600); err != nil {
			t.Fatalf("write interruption marker: %v", err)
		}
		await("interruption controller", func() bool {
			_, err := os.Stat(marker + ".resume")
			return err == nil
		})
		before := packets.Load()
		await("audio after interruption", func() bool { return packets.Load() >= before+100 })
	}
	// Preinstall the new listener key before advancing the publisher's source.
	// Old in-flight frames remain decryptable, while new key-index lookups prove
	// that continued audio is not merely buffered pre-rotation media.
	if err := listenerKeys.SetKeyFromPassphrase("music-live-smoke-rotated", 1); err != nil {
		t.Fatal(err)
	}
	roomKeys.mu.Lock()
	roomKeys.passphrase, roomKeys.index = "music-live-smoke-rotated", 1
	roomKeys.mu.Unlock()
	await("rotated-key decrypted audio", func() bool { return listenerKeys.rotatedLookups.Load() >= 100 && rotatedPackets.Load() >= 100 })
	if err := svc.Pause(channelID); err != nil {
		t.Fatal(err)
	}
	paused := svc.GetState(channelID)
	if paused == nil || !paused.IsPaused || paused.ElapsedSeconds < 1 {
		t.Fatalf("bad paused state: %+v", paused)
	}
	time.Sleep(250 * time.Millisecond) // deliberate observation window: clock must remain frozen
	if got := svc.GetState(channelID).ElapsedSeconds; got != paused.ElapsedSeconds {
		t.Fatalf("pause advanced audio %f -> %f", paused.ElapsedSeconds, got)
	}
	before := packets.Load()
	if err := svc.Resume(channelID); err != nil {
		t.Fatal(err)
	}
	await("resumed RTP", func() bool { return packets.Load() >= before+10 })
	// Re-enqueue the same public video, skip, and confirm the next item starts.
	if _, err := svc.Enqueue(ctx, "integration-user", channelID, videoURL); err != nil {
		t.Fatal(err)
	}
	if err := svc.Skip(channelID); err != nil {
		t.Fatal(err)
	}
	before = packets.Load()
	await("next track RTP", func() bool {
		state := svc.GetState(channelID)
		return state != nil && len(state.Queue) == 0 && state.StartedAt != nil && packets.Load() >= before+10
	})
	// EOF is expected only once this test deliberately closes the publisher.
	stopping.Store(true)
	if err := svc.Stop(channelID); err != nil {
		t.Fatal(err)
	}
	if svc.GetState(channelID) != nil {
		t.Fatal("stop left an active bot")
	}
	sampleMu.Lock()
	closeErr := writer.Close()
	rotatedCloseErr := rotatedWriter.Close()
	captureErr := receiveErr
	sampleMu.Unlock()
	if closeErr != nil {
		t.Fatal(closeErr)
	}
	if rotatedCloseErr != nil {
		t.Fatal(rotatedCloseErr)
	}
	if captureErr != nil {
		t.Fatal(captureErr)
	}
	peak := decodedMusicSmokePeak(t, ctx, oggPath)
	rotatedPeak := decodedMusicSmokePeak(t, ctx, rotatedPath)
	t.Logf("YouTube %s -> real FFmpeg -> LiveKit -> independent RTP listener: %d packets, decoded peak %.4f; rotated-key frames %d, rotated peak %.4f; pause/resume/queue/skip/stop passed", tracks[0].VideoID, packets.Load(), peak, listenerKeys.rotatedLookups.Load(), rotatedPeak)
}

func decodedMusicSmokePeak(t *testing.T, ctx context.Context, path string) float64 {
	t.Helper()
	pcm, err := exec.CommandContext(ctx, "ffmpeg", "-hide_banner", "-loglevel", "error", "-i", path, "-f", "f32le", "pipe:1").Output()
	if err != nil {
		t.Fatalf("received RTP is not decodable Opus: %v", err)
	}
	var peak float64
	for offset := 0; offset+4 <= len(pcm); offset += 4 {
		v := math.Abs(float64(math.Float32frombits(binary.LittleEndian.Uint32(pcm[offset:]))))
		if v > peak {
			peak = v
		}
	}
	if peak < .00001 {
		t.Fatalf("decoded stream silent (peak=%v, bytes=%d)", peak, len(pcm))
	}
	return peak
}
