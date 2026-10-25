import { useSyncExternalStore } from "react";
import type { MicrophonePipeline } from "./microphonePipeline";

export type MicrophoneStatus = {
  requestedEngine: string;
  activeEngine: string | null;
  phase: "loading" | "ready" | "fallback" | "error";
  error?: string;
  errorCode?: "browser-noise-suppression-locked";
  sampleRate: number;
  gateAvailable: boolean;
  gateEnabled?: boolean;
  gainAvailable?: boolean;
  inputDb: number;
  outputDb: number;
  gateOpen: boolean;
};
type Session = { pipeline: MicrophonePipeline; kind: "call" | "test"; status: MicrophoneStatus };
const sessions = new Map<symbol, Session>();
const listeners = new Set<() => void>();
let snapshot: MicrophoneStatus | null = null;
let call: MicrophonePipeline | null = null;
function emit() {
  const all = [...sessions.values()].reverse();
  const current = all.find((s) => s.kind === "call") ?? all[0];
  snapshot = current?.status ?? null;
  call = all.find((s) => s.kind === "call")?.pipeline ?? null;
  listeners.forEach((fn) => fn());
}
export function subscribeMicrophoneStatus(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
export const getActiveCallPipeline = () => call;
export function useMicrophoneStatus() {
  return useSyncExternalStore(subscribeMicrophoneStatus, () => snapshot, () => null);
}
export function registerMicrophonePipeline(pipeline: MicrophonePipeline, kind: Session["kind"]) {
  const key = Symbol(kind);
  const session = { pipeline, kind, status: pipeline.getStatus() };
  sessions.set(key, session);
  const unsubscribe = pipeline.subscribe((status) => { session.status = status; emit(); });
  emit();
  return () => { unsubscribe(); sessions.delete(key); emit(); };
}
