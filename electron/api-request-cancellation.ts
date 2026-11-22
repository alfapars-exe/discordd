import { randomUUID } from "node:crypto";
import type { WebContents, WebFrameMain } from "electron";

export const API_REQUEST_HEADER = "x-hichat-request-id";
export type ApiRequestBinding = { url: string; method: string; upstream: string };
export type ApiRequestOwner = { sender: WebContents; frame: WebFrameMain };
type Entry = { owner: ApiRequestOwner; binding: string; controller: AbortController; claimed: boolean; timer: ReturnType<typeof setTimeout> };

function bindingKey(raw: ApiRequestBinding): string {
  if (!raw || typeof raw.url !== "string" || raw.url.length > 4096 || typeof raw.method !== "string"
    || !/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(raw.method) || typeof raw.upstream !== "string" || raw.upstream.length > 2048) {
    throw new TypeError("Invalid API request registration");
  }
  const url = new URL(raw.url), upstream = new URL(raw.upstream);
  if (url.protocol !== "app:" || url.hostname !== "hichat" || url.username || url.password || url.hash
    || !(url.pathname === "/api" || url.pathname.startsWith("/api/"))
    || !["http:", "https:"].includes(upstream.protocol) || upstream.username || upstream.password) {
    throw new TypeError("Invalid API request registration");
  }
  return JSON.stringify([url.href, raw.method, upstream.origin]);
}

function validId(id: unknown): id is string {
  return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
}

/** Capability IDs are created only after trusted-main IPC authorization. */
export function createApiRequestCancellation(maxEntries = 128, registrationTimeoutMs = 10_000) {
  const entries = new Map<string, Entry>();
  let disposed = false;
  const release = (id: string, entry: Entry, abort: boolean) => {
    if (entries.get(id) !== entry) return;
    entries.delete(id); clearTimeout(entry.timer);
    if (abort) entry.controller.abort();
  };
  return {
    reserve(owner: ApiRequestOwner, binding: ApiRequestBinding): string {
      if (disposed || owner.sender.isDestroyed() || owner.sender.mainFrame !== owner.frame) throw new Error("API request owner unavailable");
      const key = bindingKey(binding);
      if (entries.size >= maxEntries) throw new Error("Too many active API requests");
      const id = randomUUID();
      const entry: Entry = { owner, binding: key, controller: new AbortController(), claimed: false,
        timer: setTimeout(() => release(id, entry, true), registrationTimeoutMs) };
      entry.timer.unref?.();
      entries.set(id, entry);
      return id;
    },
    claim(id: string, binding: ApiRequestBinding) {
      const entry = validId(id) ? entries.get(id) : undefined;
      if (!entry || entry.claimed || entry.binding !== bindingKey(binding) || entry.owner.sender.isDestroyed()
        || entry.owner.sender.mainFrame !== entry.owner.frame) throw new Error("API request registration unavailable");
      entry.claimed = true;
      clearTimeout(entry.timer);
      return { signal: entry.controller.signal, finish: () => release(id, entry, false), cancel: () => release(id, entry, true) };
    },
    cancel(owner: ApiRequestOwner, id: unknown): boolean {
      if (!validId(id)) throw new TypeError("Invalid API request ID");
      const entry = entries.get(id);
      if (!entry) return false;
      if (entry.owner.sender !== owner.sender || entry.owner.frame !== owner.frame) throw new Error("API request owner mismatch");
      release(id, entry, true);
      return true;
    },
    retire(sender: WebContents): void {
      for (const [id, entry] of entries) if (entry.owner.sender === sender) release(id, entry, true);
    },
    dispose(): void {
      disposed = true;
      for (const [id, entry] of entries) release(id, entry, true);
    },
    get size() { return entries.size; },
  };
}

export const apiRequestCancellation = createApiRequestCancellation();
