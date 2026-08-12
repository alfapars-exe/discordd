/**
 * useWebSocket — WebSocket connection and event routing hook.
 *
 * Singleton — only used in AppLayout.tsx.
 * Responsibilities:
 * 1. Establish WS connection on login
 * 2. Send heartbeats (30s interval, 3 misses = disconnect)
 * 3. Route incoming events to store handlers (switch/case)
 * 4. Auto-reconnect on disconnect (10s delay, max 5 attempts)
 * 5. Expose sendTyping for MessageInput
 *
 * StrictMode protection:
 * Each effect invocation gets a monotonically increasing connectionId.
 * Socket callbacks only execute if their connectionId is still active.
 * IDs are incremented (never reset) to prevent stale onclose collisions.
 */

import { useEffect, useLayoutEffect, useRef, useCallback, useState } from "react";
import { ensureFreshToken, apiClient } from "../api/client";
import { logToServer } from "../api/clientLog";
import { APP_RESUME_EVENT } from "../utils/nativePlugins";
import { randomUnit } from "../utils/random";
import { useP2PCallStore } from "../stores/p2pCallStore";
import { useVoiceStore } from "../stores/voiceStore";
import {
  WS_URL,
  WS_HEARTBEAT_INTERVAL,
  WS_HEARTBEAT_MAX_MISS,
} from "../utils/constants";
import type { WSMessage, UserStatus } from "../types";
import { handleChannelEvent } from "./ws/channelEventHandlers";
import { handleDMEvent } from "./ws/dmEventHandlers";
import { handleVoiceEvent } from "./ws/voiceEventHandlers";
import { handleSystemEvent } from "./ws/systemEventHandlers";
import type { WSHandlerContext } from "./ws/types";

/**
 * ConnectionStatus — Public status enum for the WS connection.
 *
 *   - "connecting"   — handshake in flight, initial or after reconnect
 *   - "connected"    — socket open + heartbeat healthy
 *   - "disconnected" — server-side dropout, reconnect scheduled
 *   - "offline"      — client-side network loss (navigator.onLine=false),
 *                      reconnect paused until "online" event fires
 *
 * Exported so consumers can render distinct UX per state without
 * duplicating the literal union.
 */
export type ConnectionStatus =
  | "connected"
  | "connecting"
  | "disconnected"
  | "offline";

/**
 * Exponential backoff reconnect schedule (ms).
 * Fast first attempt catches brief network blips before the server-side
 * orphan grace period (35s) expires. Later attempts back off to avoid
 * thundering herd during server outages.
 */
const RECONNECT_BASE_DELAY = 1_500;
const RECONNECT_MAX_DELAY = 20_000;

/**
 * How long a connection must stay open before the reconnect backoff counter
 * resets. Resetting at onopen let a connect-then-drop loop stay pinned at
 * the 1.5s base forever (2026-08-13 presence-flap incident); ten seconds
 * comfortably exceeds the server's 8s presence grace + one heartbeat.
 */
const BACKOFF_RESET_STABLE_MS = 10_000;

/**
 * Max reconnect attempts before showing "disconnected".
 * Exported so ConnectionBanner renders the same N in its retry counter —
 * the two drifted once (5 vs 7) when this was duplicated there.
 */
export const MAX_RECONNECT_ATTEMPTS = 7;

/** Typing throttle (ms) — prevents flooding same channel */
const TYPING_THROTTLE = 3_000;

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const lastSeqRef = useRef<number>(0);
  const missedHeartbeatsRef = useRef<number>(0);
  const heartbeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tokenRefreshIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectAttemptRef = useRef<number>(0);
  // Pending "connection proved stable → reset backoff" timer; cancelled on
  // close so a short-lived connection can never wipe the attempt counter.
  const backoffResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Monotonically increasing connection ID — StrictMode guard.
   * Never reset to 0; always incremented to keep IDs unique.
   */
  const activeConnectionIdRef = useRef<number>(0);

  // "offline" is distinct from "disconnected" — offline means the client
  // itself lost the network (navigator went offline / OS reports no
  // connectivity), so the reconnect loop should pause instead of burning
  // exponential-backoff attempts against a socket that CAN'T reach a
  // reachable server. UI can differentiate too: "You're offline" vs
  // "Reconnecting…" are different messages a user acts on differently.
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");

  const [reconnectAttempt, setReconnectAttempt] = useState<number>(0);

  /** Last typing timestamp per channel — throttle map */
  const lastTypingRef = useRef<Map<string, number>>(new Map());

  /**
   * routeEventRef — "latest ref" pattern.
   * Updated every render so onmessage always calls the freshest handler,
   * avoiding stale closures after HMR or re-renders.
   */
  const routeEventRef = useRef<(msg: WSMessage) => void>(() => {});

  // routeEvent is defined further down (below sendVoiceJoin) because
  // it captures sendVoiceJoin in its WSHandlerContext. The lint rule
  // react-hooks/immutability used to flag the forward reference in the
  // old top-of-component routeEvent; reordering the declarations is
  // the minimal-disruption fix.

  function cleanupTimers() {
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
    if (backoffResetTimerRef.current) {
      clearTimeout(backoffResetTimerRef.current);
      backoffResetTimerRef.current = null;
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (tokenRefreshIntervalRef.current) {
      clearInterval(tokenRefreshIntervalRef.current);
      tokenRefreshIntervalRef.current = null;
    }
  }

  /**
   * Exponential backoff with jitter. Attempt 1 ≈ 1.5s, then 3s, 6s, ...
   * Jitter (±25%) prevents synchronized reconnects after server restart.
   * 7 attempts covers ~60s total — well beyond the 35s orphan grace period.
   */
  function getReconnectDelay(): number {
    const attempt = reconnectAttemptRef.current;
    const base = Math.min(RECONNECT_BASE_DELAY * Math.pow(2, attempt), RECONNECT_MAX_DELAY);
    const jitter = base * 0.25 * (randomUnit() * 2 - 1); // ±25%
    return Math.round(base + jitter);
  }

  /**
   * sendTyping — Called by MessageInput on keystroke.
   * Throttled: max once per 3s per channel.
   */
  const sendTyping = useCallback((channelId: string) => {
    const now = Date.now();
    const lastSent = lastTypingRef.current.get(channelId) ?? 0;

    if (now - lastSent < TYPING_THROTTLE) return;

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          op: "typing",
          d: { channel_id: channelId },
        })
      );
      lastTypingRef.current.set(channelId, now);
    }
  }, []);

  /** sendDMTyping — Same throttle as channel typing. */
  const sendDMTyping = useCallback((dmChannelId: string) => {
    const now = Date.now();
    const key = `dm:${dmChannelId}`;
    const lastSent = lastTypingRef.current.get(key) ?? 0;

    if (now - lastSent < TYPING_THROTTLE) return;

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          op: "dm_typing_start",
          d: { dm_channel_id: dmChannelId },
        })
      );
      lastTypingRef.current.set(key, now);
    }
  }, []);

  const sendVoiceJoin = useCallback((channelId: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const { isMuted, isDeafened } = useVoiceStore.getState();
      wsRef.current.send(
        JSON.stringify({
          op: "voice_join",
          d: { channel_id: channelId, is_muted: isMuted, is_deafened: isDeafened },
        })
      );
    }
  }, []);

  const sendVoiceLeave = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          op: "voice_leave",
        })
      );
    }
  }, []);

  /**
   * routeEvent — Thin dispatcher that delegates to domain-specific
   * handler modules. Declared HERE (after sendVoiceJoin) so the
   * WSHandlerContext captures a real function reference instead of a
   * forward declaration that react-hooks/immutability flagged as
   * accessed-before-declared.
   */
  async function routeEvent(msg: WSMessage) {
    // Heartbeat ack is handled inline (no store interaction)
    if (msg.op === "heartbeat_ack") {
      missedHeartbeatsRef.current = 0;
      return;
    }

    const ctx: WSHandlerContext = { sendVoiceJoin };

    if (await handleChannelEvent(msg)) return;
    if (await handleDMEvent(msg)) return;
    if (await handleVoiceEvent(msg, ctx)) return;
    if (await handleSystemEvent(msg, ctx, setConnectionStatus)) return;
  }

  // Latest-ref mirror — updated after every commit so onmessage in
  // the WebSocket lifecycle effect can always dispatch through the
  // freshest handler closure without stale-context bugs.
  useLayoutEffect(() => {
    routeEventRef.current = routeEvent;
  });

  /**
   * sendPresenceUpdate — Sends presence status via WS.
   * Called by idle detection (isAuto=true) and manual status picker (isAuto=false).
   * Auto-idle does NOT persist to pref_status — so idle detection resumes after WS reconnect.
   */
  const sendPresenceUpdate = useCallback((status: UserStatus, isAuto = false) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          op: "presence_update",
          d: { status, is_auto: isAuto },
        })
      );
    }
  }, []);

  /** sendVoiceStateUpdate — Partial update: only changed fields are sent. */
  const sendVoiceStateUpdate = useCallback(
    (state: { is_muted?: boolean; is_deafened?: boolean; is_streaming?: boolean }) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            op: "voice_state_update_request",
            d: state,
          })
        );
      }
    },
    []
  );

  /**
   * sendWS — Generic WS sender, used by P2P call store.
   * Single function instead of per-event helpers since store knows its own op codes.
   */
  const sendWS = useCallback((op: string, data?: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({ op, d: data })
      );
    }
  }, []);

  // Register WS sender in P2P call store. Done inside an effect (vs in
  // the render body) because the previous shape was flagged by
  // react-hooks/refs — passing a useCallback identity to a store
  // setter during render is a render-time side effect. The store
  // accepts re-registration; calling it again with the same `sendWS`
  // reference is a no-op, and only the latest call wins anyway.
  useEffect(() => {
    useP2PCallStore.getState().registerSendWS(sendWS);
  }, [sendWS]);

  // ─── Effect: Mount/unmount lifecycle ───
  useEffect(() => {
    const myId = ++activeConnectionIdRef.current;

    /**
     * scheduleReconnect — Exponential backoff, max 7 attempts (~60s total).
     * Shows "disconnected" banner after limit is reached.
     */
    function scheduleReconnect() {
      if (activeConnectionIdRef.current !== myId) return;

      if (reconnectAttemptRef.current >= MAX_RECONNECT_ATTEMPTS) {
        setConnectionStatus("disconnected");
        logToServer("error", "ws_disconnected_final", {
          attempts: reconnectAttemptRef.current,
          maxAttempts: MAX_RECONNECT_ATTEMPTS,
        });
        return;
      }

      const delay = getReconnectDelay();
      reconnectAttemptRef.current++;
      setReconnectAttempt(reconnectAttemptRef.current);

      // Only the first attempt of an outage gets logged — final outcome
      // is captured by ws_disconnected_final (gave up) or onopen success.
      // Without this gate, a 7-attempt outage would burn the entire
      // 10-token client-log bucket on reconnect telemetry alone.
      if (reconnectAttemptRef.current === 1) {
        logToServer("info", "ws_reconnect_attempt", {
          attempt: reconnectAttemptRef.current,
          delayMs: delay,
          maxAttempts: MAX_RECONNECT_ATTEMPTS,
        });
      }

      reconnectTimeoutRef.current = setTimeout(() => {
        if (activeConnectionIdRef.current === myId) {
          doConnect();
        }
      }, delay);
    }

    /**
     * doConnect — Establishes WS connection within this effect scope.
     * Refreshes token before connecting (WS has no 401 retry mechanism).
     */
    async function doConnect() {
      if (activeConnectionIdRef.current !== myId) return;

      setConnectionStatus("connecting");

      let token: string | null = null;
      try {
        token = await ensureFreshToken();
      } catch {
        // Server may be down — network error on refresh.
        // Log only the first and last attempt of a flap cycle to stay
        // under the 10-token per-user rate limit on /client-log.
        const attempt = reconnectAttemptRef.current;
        if (attempt === 0 || attempt === MAX_RECONNECT_ATTEMPTS - 1) {
          logToServer("warn", "ws_connect_token_refresh_failed", {
            attempt,
            maxAttempts: MAX_RECONNECT_ATTEMPTS,
          });
        }
      }

      if (activeConnectionIdRef.current !== myId) return;

      if (!token) {
        scheduleReconnect();
        return;
      }

      cleanupTimers();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }

      // Prefer the short-lived one-time ticket over embedding the JWT
      // access token in the WS URL. The ticket dies on first use (or
      // ~30s later, whichever comes first) and never lands in proxy
      // access logs or browser history as a recoverable credential.
      //
      // Falls back to the legacy `?token=` path if the server hasn't
      // shipped the ticket endpoint yet — apiClient turns the 404 into
      // a success:false response, which we read explicitly here.
      let connectURL = `${WS_URL}?token=${token}`;
      try {
        const ticketRes = await apiClient<{ ticket: string }>(
          "/auth/ws-ticket",
          { method: "POST" },
        );
        if (ticketRes.success && ticketRes.data?.ticket) {
          connectURL = `${WS_URL}?ticket=${ticketRes.data.ticket}`;
        }
      } catch {
        // Network blip / server cold-boot — fall through to the token
        // path; the next reconnect cycle will retry the ticket fetch.
      }

      if (activeConnectionIdRef.current !== myId) return;

      const socket = new WebSocket(connectURL);
      wsRef.current = socket;

      // ─── onopen ───
      socket.onopen = () => {
        if (activeConnectionIdRef.current !== myId) return;

        // Backoff resets only after the connection PROVES stable (stays open
        // for a stretch), not at onopen. Resetting here pinned a
        // connect-then-immediately-drop loop to the 1.5s base forever:
        // attempt never climbed, exponential backoff never engaged, and the
        // MAX_RECONNECT_ATTEMPTS "disconnected" banner never showed — the
        // 2026-08-13 presence-flap incident's client half.
        if (backoffResetTimerRef.current) clearTimeout(backoffResetTimerRef.current);
        backoffResetTimerRef.current = setTimeout(() => {
          if (activeConnectionIdRef.current !== myId) return;
          reconnectAttemptRef.current = 0;
          setReconnectAttempt(0);
        }, BACKOFF_RESET_STABLE_MS);
        setReconnectAttempt(0); // UI: hide any reconnect notice immediately
        missedHeartbeatsRef.current = 0;

        // Start heartbeat interval
        heartbeatIntervalRef.current = setInterval(() => {
          if (activeConnectionIdRef.current !== myId) {
            clearInterval(heartbeatIntervalRef.current!);
            return;
          }

          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ op: "heartbeat" }));
            missedHeartbeatsRef.current++;

            if (missedHeartbeatsRef.current >= WS_HEARTBEAT_MAX_MISS) {
              logToServer("warn", "ws_heartbeat_timeout", {
                missedHeartbeats: missedHeartbeatsRef.current,
                maxMissAllowed: WS_HEARTBEAT_MAX_MISS,
                intervalMs: WS_HEARTBEAT_INTERVAL,
              });
              socket.close();
            }
          }
        }, WS_HEARTBEAT_INTERVAL);

        // Proactive token refresh every 10min while WS is open.
        // Access token expires at 15min — 10min gives 5min buffer.
        // On failure, retries every 10s (up to 9 times) for smooth recovery.
        const TOKEN_REFRESH_INTERVAL = 10 * 60 * 1000;
        const TOKEN_REFRESH_RETRY_DELAY = 10_000;
        const TOKEN_REFRESH_MAX_RETRIES = 9;

        tokenRefreshIntervalRef.current = setInterval(async () => {
          if (activeConnectionIdRef.current !== myId) {
            clearInterval(tokenRefreshIntervalRef.current!);
            return;
          }

          for (let attempt = 0; attempt < TOKEN_REFRESH_MAX_RETRIES; attempt++) {
            try {
              await ensureFreshToken();
              break;
            } catch {
              console.warn(`[useWebSocket] Token refresh attempt ${attempt + 1} failed`);
              // Server-side bucket is 10 burst / ~30/min — a 9-retry loop
              // would absorb most of it. Log first attempt (initial failure
              // signal) and last attempt (give-up signal) only.
              if (attempt === 0 || attempt === TOKEN_REFRESH_MAX_RETRIES - 1) {
                logToServer("warn", "ws_token_refresh_attempt_failed", {
                  attempt: attempt + 1,
                  maxRetries: TOKEN_REFRESH_MAX_RETRIES,
                });
              }
              if (attempt < TOKEN_REFRESH_MAX_RETRIES - 1) {
                await new Promise((r) => setTimeout(r, TOKEN_REFRESH_RETRY_DELAY));
                if (activeConnectionIdRef.current !== myId) return;
              }
            }
          }
        }, TOKEN_REFRESH_INTERVAL);
      };

      // ─── onmessage ───
      socket.onmessage = (event: MessageEvent) => {
        if (activeConnectionIdRef.current !== myId) return;

        let msg: WSMessage;
        try {
          msg = JSON.parse(event.data as string);
        } catch {
          return;
        }

        if (msg.seq) {
          lastSeqRef.current = msg.seq;
        }

        // Route via ref for closure freshness
        routeEventRef.current(msg);
      };

      // ─── onclose ───
      socket.onclose = (event: CloseEvent) => {
        // Stale socket guard — critical for StrictMode
        if (activeConnectionIdRef.current !== myId) return;

        // Code 1000 (Normal) and 1001 (Going Away) are not interesting on
        // their own. Log only when the close is unexpected (not clean) or
        // when it happens on a fresh connection — repeated reconnect
        // attempts would otherwise emit one ws_close per attempt.
        if (!event.wasClean || reconnectAttemptRef.current <= 1) {
          const isNormal = event.code === 1000 || event.code === 1001;
          logToServer(isNormal ? "info" : "warn", "ws_close", {
            wasClean: event.wasClean,
            code: event.code,
            reason: event.reason?.slice(0, 200) ?? "",
            attempt: reconnectAttemptRef.current,
          });
        }

        setConnectionStatus("disconnected");
        cleanupTimers();
        scheduleReconnect();
      };

      // ─── onerror ───
      socket.onerror = () => {
        if (activeConnectionIdRef.current !== myId) return;
        // The browser's WebSocket ErrorEvent carries no useful diagnostic
        // info (security restriction); the real reason will follow in
        // onclose. We still log the moment so we have evidence of a
        // transport-level fault that is distinct from a clean close.
        logToServer("warn", "ws_error", {
          readyState: socket.readyState,
        });
      };
    }

    doConnect();

    // App resume listener — reconnect WS if socket is closed (mobile background → foreground)
    function onAppResume() {
      if (activeConnectionIdRef.current !== myId) return;

      const ws = wsRef.current;
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        reconnectAttemptRef.current = 0;
        setReconnectAttempt(0);
        doConnect();
      }
    }

    window.addEventListener(APP_RESUME_EVENT, onAppResume);

    // Client-side network loss (navigator.onLine flipped false): close the
    // socket eagerly so we don't sit here waiting on the 90-second heartbeat
    // to notice. Flag connectionStatus so the UI can render a specific
    // "You're offline" state instead of the generic reconnecting spinner.
    function onOffline() {
      if (activeConnectionIdRef.current !== myId) return;
      cleanupTimers();
      setConnectionStatus("offline");
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    }

    // Network came back — reset backoff and reconnect immediately. Skipping
    // the delay is intentional: the browser only flips "online" after the
    // OS reports connectivity, so waiting further would be sluggish for no
    // reason. If the WS host is still unreachable, the normal onerror path
    // in doConnect resumes the backoff sequence.
    function onOnline() {
      if (activeConnectionIdRef.current !== myId) return;
      reconnectAttemptRef.current = 0;
      setReconnectAttempt(0);
      doConnect();
    }

    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);

    return () => {
      // Increment from the snapshotted myId so the lint rule
      // react-hooks/exhaustive-deps doesn't flag a cleanup-time
      // ref read. Semantically identical to `activeConnectionIdRef.current++`
      // because no one else mutates this ref during the effect's
      // lifetime (scheduleReconnect/doConnect only *read* it via
      // `=== myId` checks and bail out — they never increment).
      activeConnectionIdRef.current = myId + 1;
      cleanupTimers();
      window.removeEventListener(APP_RESUME_EVENT, onAppResume);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);

      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []);

  return { sendTyping, sendDMTyping, sendPresenceUpdate, sendVoiceJoin, sendVoiceLeave, sendVoiceStateUpdate, sendWS, connectionStatus, reconnectAttempt };
}
