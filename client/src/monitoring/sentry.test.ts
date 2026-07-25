/**
 * redactSecrets regression tests.
 *
 * Root cause covered by the Turkish-regression case: redactParam used to
 * compute the match index on `rest.toLowerCase()` (a copy) and then slice
 * the ORIGINAL string with that index. `toLowerCase()` is not length-
 * preserving for every code point — Turkish "İ" (U+0130) expands to two
 * code units ("i" + U+0307) when folded — so every "İ" appearing before a
 * secret param shifted the computed index by one, and the slice leaked the
 * leading characters of the secret value into the "redacted" output.
 *
 * Mirrors server/pkg/redact_test.go's coverage (same secretParams list,
 * same valueTerminators) so client and server redaction stay in lockstep.
 */
import { describe, it, expect } from "vitest";
import { redactSecrets, scrubBreadcrumb, scrubTransactionEvent, scrubErrorEvent } from "./sentry";
import type { Breadcrumb, ErrorEvent as SentryErrorEvent } from "@sentry/react";
import type * as Sentry from "@sentry/react";

/**
 * Asserts that no substring of `secret` with length >= 4 appears anywhere in
 * `haystack` — prefix, infix, or suffix. A fixed-offset check (e.g. only
 * `secret.slice(0, len)`) misses a redaction bug that leaks from the middle
 * or the end of the value rather than the start.
 */
function assertNoSecretSubstring(haystack: string, secret: string): void {
  for (let len = 4; len <= secret.length; len++) {
    for (let start = 0; start + len <= secret.length; start++) {
      expect(haystack).not.toContain(secret.slice(start, start + len));
    }
  }
}

describe("redactSecrets", () => {
  it("redacts a simple ASCII key=value pair", () => {
    expect(redactSecrets("token=SECRET&next=/x")).toBe("token=***&next=/x");
  });

  it("never leaks any part of the secret value when 'İ' precedes it (Turkish regression)", () => {
    const secret = "SUPERGIZLIDEGER";
    const input = `İşlem İptal İedildi İhata: token=${secret}&next=/x`;

    const out = redactSecrets(input);

    // The invariant that matters: no substring of the secret value survives,
    // not any single fixed expected string. A shifted index could still
    // leak e.g. "UPE" or "PER" rather than exactly "SUPE" — check every
    // substring (prefix, infix, and suffix) of length >= 4, not just a
    // fixed-offset prefix slice.
    expect(out).not.toContain(secret);
    assertNoSecretSubstring(out, secret);
    expect(out).toContain("token=***");
    expect(out).toContain("next=/x");
    // The surrounding Turkish text must survive untouched — redaction must
    // only ever narrow to the secret value, never swallow adjacent context.
    expect(out).toContain("İşlem İptal İedildi İhata: ");
  });

  it("preserves the original key casing while matching case-insensitively", () => {
    expect(redactSecrets("AuthToken=abc123&x=1")).toBe("AuthToken=***&x=1");
    expect(redactSecrets("AUTHTOKEN=abc123")).toBe("AUTHTOKEN=***");
  });

  it("redacts multiple distinct secret params in a single string", () => {
    const out = redactSecrets("token=aaa&password=bbb&apikey=ccc");
    expect(out).toBe("token=***&password=***&apikey=***");
  });

  it("stops the redacted value at each recognized terminator", () => {
    expect(redactSecrets("token=abc&next=1")).toBe("token=***&next=1");
    expect(redactSecrets("token=abc next=1")).toBe("token=*** next=1");
    expect(redactSecrets('token=abc"next=1')).toBe('token=***"next=1');
    expect(redactSecrets("token=abc\r\nnext line kept")).toBe(
      "token=***\r\nnext line kept",
    );
  });

  it("redacts a value that runs to the end of the string (no terminator)", () => {
    expect(redactSecrets("prefix token=abcdef")).toBe("prefix token=***");
  });

  it("redacts ws-ticket query params", () => {
    expect(
      redactSecrets("wss://hichat.example.com/ws?ticket=abc123def456"),
    ).toBe("wss://hichat.example.com/ws?ticket=***");
  });

  it("passes clean strings through unchanged", () => {
    const clean = "UNIQUE constraint failed: users.username";
    expect(redactSecrets(clean)).toBe(clean);
  });
});

describe("scrubBreadcrumb", () => {
  it("drops console breadcrumbs entirely", () => {
    const breadcrumb: Breadcrumb = {
      category: "console",
      message: "decrypt failed, plaintext was: hello",
    };
    expect(scrubBreadcrumb(breadcrumb)).toBeNull();
  });

  it("redacts a secret living in a navigation breadcrumb's from/to (reset-password token leak)", () => {
    // Real leak scenario: a user resets their password, then clicks the
    // /login link on the success screen. @sentry/core's navigation
    // breadcrumb sets data.from/data.to from parsed.relative, which
    // includes the query string — so the reset token rode along in a
    // breadcrumb that scrubBreadcrumb used to only redact for
    // category === "fetch" | "xhr".
    const secret = "RESET123";
    const breadcrumb: Breadcrumb = {
      category: "navigation",
      data: { from: `/reset-password?token=${secret}`, to: "/login" },
    };

    const out = scrubBreadcrumb(breadcrumb);

    expect(out).not.toBeNull();
    assertNoSecretSubstring(JSON.stringify(out), secret);
  });

  it("still redacts fetch/xhr breadcrumb urls", () => {
    const secret = "RESET123";
    const breadcrumb: Breadcrumb = {
      category: "fetch",
      data: { method: "GET", url: `https://hichat.example.com/dms/1/search?token=${secret}` },
    };

    const out = scrubBreadcrumb(breadcrumb);

    expect(out).not.toBeNull();
    assertNoSecretSubstring(JSON.stringify(out), secret);
  });

  it("passes through a breadcrumb with no data untouched", () => {
    const breadcrumb: Breadcrumb = { category: "ui.click", message: "clicked button" };
    expect(scrubBreadcrumb(breadcrumb)).toEqual(breadcrumb);
  });
});

describe("scrubTransactionEvent", () => {
  it("redacts secrets in span.data, trace context data, and request.url, and drops request.headers (parity with the error path)", () => {
    // span.description alone doesn't carry the query string (getSanitizedUrlString
    // strips it) — the query survives in span.data.url, span.data["http.query"],
    // and event.contexts.trace.data, and in the Referer header on request.headers
    // (which can be the previous page's full URL, e.g. /reset-password?token=...).
    const secret = "RESET123";
    const url = `https://hichat.example.com/dms/1/search?token=${secret}`;
    const referer = `https://hichat.example.com/reset-password?token=${secret}`;

    const event: Sentry.Event = {
      type: "transaction",
      transaction: "GET /dms/:id/search",
      request: {
        url,
        headers: { Referer: referer, "User-Agent": "Mozilla/5.0" },
      },
      spans: [
        {
          description: "GET /dms/1/search",
          data: { url, "http.query": `?token=${secret}` },
          span_id: "span1",
          start_timestamp: 0,
          trace_id: "trace1",
        },
      ],
      contexts: {
        trace: {
          data: { url },
          span_id: "span1",
          trace_id: "trace1",
        },
      },
    };

    const out = scrubTransactionEvent(event);

    expect(out.request?.headers).toBeUndefined();
    assertNoSecretSubstring(JSON.stringify(out), secret);
  });

  it("redacts a secret param embedded in a real DM-search span.data.url", () => {
    // client/src/api/dm.ts's GET /dms/{id}/search?q=<search term> populates
    // span.data.url (a live example of what previously reached Sentry
    // unredacted, since only span.description was scrubbed). This checks a
    // listed secret param (token=) elsewhere in that same URL is caught;
    // the plaintext `q=` search term itself has no recognized param name in
    // SECRET_PARAMS and is intentionally left alone here, same as the
    // server-side redactor it mirrors (server/pkg/redact.go).
    const secret = "PASSWORD123";
    const event: Sentry.Event = {
      type: "transaction",
      spans: [
        {
          description: "GET /dms/1/search",
          data: { url: `/dms/1/search?q=plaintext+term&token=${secret}` },
          span_id: "span1",
          start_timestamp: 0,
          trace_id: "trace1",
        },
      ],
    };

    const out = scrubTransactionEvent(event);

    assertNoSecretSubstring(JSON.stringify(out), secret);
  });
});

describe("scrubErrorEvent", () => {
  it("redacts message and exception values, and drops event.request", () => {
    const secret = "RESET123";
    const event: SentryErrorEvent = {
      type: undefined,
      message: `failed request to /reset-password?token=${secret}`,
      exception: {
        values: [{ value: `Error: /reset-password?token=${secret}` }],
      },
      request: { url: `https://hichat.example.com/reset-password?token=${secret}` },
    };

    const out = scrubErrorEvent(event);

    expect(out.request).toBeUndefined();
    assertNoSecretSubstring(JSON.stringify(out), secret);
  });
});
