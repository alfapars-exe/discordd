/** Remove common credential-bearing values while keeping trace JSON readable. */
export function scrubPerformanceTrace(text: string): string {
  return text
    .replace(/([?&](?:token|ticket|key|code|session|auth)=)[^&#"\s]+/gi, "$1[REDACTED]")
    .replace(/(authorization["']?\s*[:=]\s*["']?)(?:bearer\s+)?[^"'\s,}]+/gi, "$1[REDACTED]")
    .replace(/(wss?:\/\/[^/"\s]+\/)[^"\s]*/gi, "$1[REDACTED]");
}
