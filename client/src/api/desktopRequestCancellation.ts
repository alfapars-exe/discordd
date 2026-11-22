const REQUEST_HEADER = "X-HiChat-Request-Id";

/** Each HTTP attempt owns one native lease; shared auth refresh never uses it. */
export function createDesktopRequestOwner(enabled: boolean, signal?: AbortSignal) {
  const bridge = enabled ? window.electronAPI : undefined;
  const reserve = bridge?.reserveApiRequest, cancel = bridge?.cancelApiRequest;
  const leases = new Set<string>();
  let disposed = false;
  const cancelLease = (id: string) => {
    leases.delete(id);
    void cancel?.(id).catch(() => {});
  };
  const stop = () => { disposed = true; for (const id of [...leases]) cancelLease(id); };
  if (reserve && cancel && signal) signal.addEventListener("abort", stop, { once: true });
  return {
    async fetch(url: string, init: RequestInit): Promise<Response> {
      if (!reserve || !cancel || !signal) return fetch(url, init);
      if (disposed || signal.aborted) throw new DOMException("Request cancelled", "AbortError");
      // Dispose the preceding unread 401/gateway response before another attempt.
      for (const id of [...leases]) cancelLease(id);
      const headers = new Headers(init.headers);
      const id = await reserve({ url, method: init.method ?? "GET", upstream: headers.get("X-HiChat-Upstream") ?? "" });
      // The caller may have timed out while its IPC acknowledgement was pending.
      // This continuation still runs and retires the late lease without fetching.
      if (disposed || signal.aborted) { cancelLease(id); throw new DOMException("Request cancelled", "AbortError"); }
      leases.add(id);
      headers.set(REQUEST_HEADER, id);
      return fetch(url, { ...init, headers });
    },
    dispose() { stop(); signal?.removeEventListener("abort", stop); },
  };
}
