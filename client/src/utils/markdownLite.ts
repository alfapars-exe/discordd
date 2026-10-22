/**
 * markdownLite — linear-time, dependency-free parser for the small markdown
 * subset chat messages support (Faz D1, Sözleşme §9):
 *
 *   **bold**   *italic* / _italic_   `code`   ```fenced block```   ||spoiler||
 *   plus `\` escapes for  * _ | ` \ ~
 *
 * Output is a plain AST (`MdNode[]`). Rendering happens in messageParsers.tsx
 * through React element creation only — this module never produces HTML, so
 * no raw-HTML injection API is used anywhere on the path.
 *
 * Pipeline (each phase is a single forward pass):
 *   A. code scan    — fenced blocks (line-start ```), inline code runs of 1–3
 *                      backticks. Nothing inside code is parsed further.
 *   B. atom split   — the caller's token regex (mentions, URLs, custom emoji
 *                      tokens) cuts the remaining text; atoms are opaque
 *                      leaves, so delimiters inside a URL or `@user_name` are
 *                      never interpreted.
 *   C. delimiters   — CommonMark-style delimiter stack with per-kind
 *                      "openers bottom" so every delimiter run is pushed and
 *                      popped at most once (no regex backtracking anywhere).
 *
 * Nesting deeper than MAX_DEPTH is emitted as literal text on conversion.
 */

export type MdNode =
  | { type: "text"; value: string }
  | { type: "atom"; value: string }
  | { type: "code"; value: string }
  | { type: "codeBlock"; value: string; lang: string }
  | { type: "strong"; children: MdNode[] }
  | { type: "em"; children: MdNode[] }
  | { type: "spoiler"; children: MdNode[] };

/** Maximum rendered nesting of strong/em/spoiler; deeper wraps become literal. */
export const MAX_DEPTH = 8;

const ESCAPABLE = new Set(["*", "_", "|", "`", "\\", "~"]);
const FENCE_LANG = /^[A-Za-z0-9_+-]{0,20}$/;

// ─── Phase A: code scan ───────────────────────────────────────────────

/** A raw slice of the source. `raw` always reproduces the original text exactly. */
export type RawSegment =
  | { kind: "text"; raw: string }
  | { kind: "code"; raw: string; value: string }
  | { kind: "codeBlock"; raw: string; value: string; lang: string };

function backtickRunLength(text: string, i: number): number {
  let j = i;
  while (j < text.length && text.charCodeAt(j) === 96 /* ` */) j++;
  return j - i;
}

/**
 * Splits text into code / non-code raw segments. Exported so the composer's
 * shortcode conversion skips exactly the same regions the renderer treats as
 * code (no drift between "what renders as code" and "what isn't rewritten").
 */
export function scanCodeSegments(text: string): RawSegment[] {
  const out: RawSegment[] = [];
  const n = text.length;
  let textStart = 0;
  let i = 0;
  // Failure memos keep the scan linear: once a search for a closer from
  // position p fails, no closer exists anywhere after p, so later openers of
  // the same kind fail immediately instead of rescanning to the end.
  let fenceFailFrom = -1;
  const inlineFailFrom = [-1, -1, -1, -1];

  const flushText = (end: number) => {
    if (end > textStart) out.push({ kind: "text", raw: text.slice(textStart, end) });
  };

  while (i < n) {
    const ch = text.charCodeAt(i);

    if (ch === 92 /* \ */ && i + 1 < n && ESCAPABLE.has(text[i + 1])) {
      i += 2; // escape stays in the text segment; phase C resolves it
      continue;
    }

    if (ch !== 96) {
      i++;
      continue;
    }

    const run = backtickRunLength(text, i);
    const atLineStart = i === 0 || text.charCodeAt(i - 1) === 10;

    // Fenced block: ``` at line start, optional language label + newline.
    if (run >= 3 && atLineStart && (fenceFailFrom < 0 || i < fenceFailFrom)) {
      const afterTicks = i + 3;
      let contentStart = afterTicks;
      let lang = "";
      const nl = text.indexOf("\n", afterTicks);
      if (nl >= 0 && nl - afterTicks <= 20) {
        const label = text.slice(afterTicks, nl);
        if (FENCE_LANG.test(label)) {
          lang = label;
          contentStart = nl + 1;
        }
      }
      const close = text.indexOf("```", contentStart);
      if (close >= 0) {
        flushText(i);
        let value = text.slice(contentStart, close);
        if (value.endsWith("\n")) value = value.slice(0, -1);
        out.push({ kind: "codeBlock", raw: text.slice(i, close + 3), value, lang });
        i = close + 3;
        textStart = i;
        continue;
      }
      fenceFailFrom = i;
    }

    // Inline code: run of 1–3 backticks closed by a run of exactly the same length.
    if (run <= 3) {
      const fail = inlineFailFrom[run];
      if (fail < 0 || i < fail) {
        let j = i + run;
        let closeAt = -1;
        while (j < n) {
          if (text.charCodeAt(j) !== 96) {
            j++;
            continue;
          }
          const r = backtickRunLength(text, j);
          if (r === run) {
            closeAt = j;
            break;
          }
          j += r;
        }
        if (closeAt >= 0) {
          flushText(i);
          out.push({
            kind: "code",
            raw: text.slice(i, closeAt + run),
            value: text.slice(i + run, closeAt),
          });
          i = closeAt + run;
          textStart = i;
          continue;
        }
        inlineFailFrom[run] = i;
      }
    }

    i += run; // literal backtick run
  }

  flushText(n);
  return out;
}

// ─── Phase C: delimiter stack over a linked list of inline nodes ──────

type DelimChar = "*" | "_" | "|";

type LNode = {
  kind: "text" | "atom" | "code" | "delim" | "wrap";
  value: string;
  prev: LNode | null;
  next: LNode | null;
  // delim
  delim?: Delim;
  // wrap
  wrapType?: "strong" | "em" | "spoiler";
  wrapMarker?: string;
  childHead?: LNode | null;
};

type Delim = {
  node: LNode;
  char: DelimChar;
  count: number;
  origCount: number;
  canOpen: boolean;
  canClose: boolean;
  prev: Delim | null;
  next: Delim | null;
};

const WS = /\s/;
const PUNCT = /[\p{P}\p{S}]/u;

function isWs(c: string | undefined): boolean {
  return c === undefined || WS.test(c);
}

function isWsOrPunct(c: string | undefined): boolean {
  return c === undefined || WS.test(c) || PUNCT.test(c);
}

type InlinePiece =
  | { kind: "text"; raw: string }
  | { kind: "atom"; value: string }
  | { kind: "code"; value: string };

function pieceFirstChar(p: InlinePiece | undefined): string | undefined {
  if (!p) return undefined;
  if (p.kind === "code") return "`";
  return p.kind === "text" ? p.raw[0] : p.value[0];
}

/** Parse one inline run (no fenced blocks inside) into MdNodes. */
function parseInline(pieces: InlinePiece[]): MdNode[] {
  const head: LNode = { kind: "text", value: "", prev: null, next: null };
  let tail = head;
  const append = (node: LNode) => {
    node.prev = tail;
    tail.next = node;
    tail = node;
  };

  let firstDelim: Delim | null = null;
  let lastDelim: Delim | null = null;
  let prevChar: string | undefined;

  for (let p = 0; p < pieces.length; p++) {
    const piece = pieces[p];
    if (piece.kind === "atom") {
      append({ kind: "atom", value: piece.value, prev: null, next: null });
      prevChar = piece.value[piece.value.length - 1];
      continue;
    }
    if (piece.kind === "code") {
      append({ kind: "code", value: piece.value, prev: null, next: null });
      prevChar = "`";
      continue;
    }

    const s = piece.raw;
    const nextPieceChar = pieceFirstChar(pieces[p + 1]);
    let buf = "";
    let i = 0;
    const flush = () => {
      if (buf) {
        append({ kind: "text", value: buf, prev: null, next: null });
        buf = "";
      }
    };

    while (i < s.length) {
      const c = s[i];
      if (c === "\\" && i + 1 < s.length && ESCAPABLE.has(s[i + 1])) {
        buf += s[i + 1];
        prevChar = s[i + 1];
        i += 2;
        continue;
      }
      if (c === "*" || c === "_" || c === "|") {
        let j = i;
        while (j < s.length && s[j] === c) j++;
        const len = j - i;
        const before = prevChar;
        const after = j < s.length ? s[j] : nextPieceChar;
        let canOpen: boolean;
        let canClose: boolean;
        if (c === "|") {
          // Same inner-side rule as `*` so nested spoilers pair correctly.
          canOpen = len === 2 && !isWs(after);
          canClose = len === 2 && !isWs(before);
        } else if (c === "*") {
          // CommonMark flanking: never next to whitespace on the inner side,
          // and a punctuation-adjacent run needs whitespace/punctuation on
          // its outer side (so `*||*x*||*` nests instead of pairing `*||*`).
          canOpen = !isWs(after) && (!PUNCT.test(after ?? "") || isWsOrPunct(before));
          canClose = !isWs(before) && (!PUNCT.test(before ?? "") || isWsOrPunct(after));
        } else {
          canOpen = !isWs(after) && isWsOrPunct(before);
          canClose = !isWs(before) && isWsOrPunct(after);
        }
        if (canOpen || canClose) {
          flush();
          const node: LNode = { kind: "delim", value: c.repeat(len), prev: null, next: null };
          const d: Delim = {
            node,
            char: c,
            count: len,
            origCount: len,
            canOpen,
            canClose,
            prev: lastDelim,
            next: null,
          };
          node.delim = d;
          if (lastDelim) lastDelim.next = d;
          else firstDelim = d;
          lastDelim = d;
          append(node);
        } else {
          buf += s.slice(i, j);
        }
        prevChar = c;
        i = j;
        continue;
      }
      buf += c;
      prevChar = c;
      i++;
    }
    flush();
  }

  // Remove a delimiter entry from the delimiter list (its node stays).
  const removeDelim = (d: Delim) => {
    if (d.prev) d.prev.next = d.next;
    else firstDelim = d.next;
    if (d.next) d.next.prev = d.prev;
    else lastDelim = d.prev;
    d.node.delim = undefined;
  };
  const unlinkNode = (node: LNode) => {
    if (node.prev) node.prev.next = node.next;
    if (node.next) node.next.prev = node.prev;
    if (tail === node) tail = node.prev ?? head;
  };

  const openersBottom = new Map<string, Delim | null>();
  let current: Delim | null = firstDelim;

  while (current) {
    const closer: Delim = current;
    if (!closer.canClose) {
      current = closer.next;
      continue;
    }
    const key = `${closer.char}${closer.canOpen ? 1 : 0}${closer.origCount % 3}`;
    const bottom = openersBottom.has(key) ? openersBottom.get(key) ?? null : null;

    let opener: Delim | null = closer.prev;
    let found: Delim | null = null;
    while (opener && opener !== bottom) {
      if (opener.char === closer.char && opener.canOpen) {
        if (closer.char === "|") {
          if (opener.count >= 2 && closer.count >= 2) {
            found = opener;
            break;
          }
        } else {
          const oddMatch =
            (opener.canClose || closer.canOpen) &&
            (opener.origCount + closer.origCount) % 3 === 0 &&
            !(opener.origCount % 3 === 0 && closer.origCount % 3 === 0);
          if (!oddMatch) {
            found = opener;
            break;
          }
        }
      }
      opener = opener.prev;
    }

    if (!found) {
      openersBottom.set(key, closer.prev);
      const next = closer.next;
      if (!closer.canOpen) removeDelim(closer);
      current = next;
      continue;
    }

    const use = closer.char === "|" ? 2 : found.count >= 2 && closer.count >= 2 ? 2 : 1;
    const wrapType: "strong" | "em" | "spoiler" =
      closer.char === "|" ? "spoiler" : use === 2 ? "strong" : "em";

    // Delimiters strictly between opener and closer can no longer match.
    let between = found.next;
    while (between && between !== closer) {
      const nx: Delim | null = between.next;
      removeDelim(between);
      between = nx;
    }

    // O(1) splice: nodes strictly between opener.node and closer.node
    // become the wrap's children.
    const first = found.node.next;
    const last = closer.node.prev;
    const wrap: LNode = {
      kind: "wrap",
      value: "",
      prev: found.node,
      next: closer.node,
      wrapType,
      wrapMarker: closer.char.repeat(use),
      childHead: null,
    };
    if (first && first !== closer.node && last) {
      wrap.childHead = first;
      first.prev = null;
      last.next = null;
    }
    found.node.next = wrap;
    closer.node.prev = wrap;

    found.count -= use;
    closer.count -= use;
    found.node.value = found.char.repeat(found.count);
    closer.node.value = closer.char.repeat(closer.count);

    if (found.count === 0) {
      removeDelim(found);
      unlinkNode(found.node);
    }
    if (closer.count === 0) {
      const next = closer.next;
      removeDelim(closer);
      unlinkNode(closer.node);
      current = next;
    }
  }

  return toMdNodes(head.next);
}

/** Iterative linked-list → AST conversion (no recursion: deep input can't blow the stack). */
function toMdNodes(start: LNode | null): MdNode[] {
  const root: MdNode[] = [];
  type Frame = { node: LNode | null; out: MdNode[]; depth: number; closeText?: string };
  const stack: Frame[] = [{ node: start, out: root, depth: 0 }];

  const pushText = (out: MdNode[], value: string) => {
    if (!value) return;
    const last = out[out.length - 1];
    if (last && last.type === "text") last.value += value;
    else out.push({ type: "text", value });
  };

  while (stack.length > 0) {
    const f = stack[stack.length - 1];
    if (!f.node) {
      stack.pop();
      if (f.closeText !== undefined) pushText(f.out, f.closeText);
      continue;
    }
    const n = f.node;
    f.node = n.next;
    switch (n.kind) {
      case "text":
      case "delim":
        pushText(f.out, n.value);
        break;
      case "atom":
        f.out.push({ type: "atom", value: n.value });
        break;
      case "code":
        f.out.push({ type: "code", value: n.value });
        break;
      case "wrap": {
        const marker = n.wrapMarker ?? "";
        if (f.depth < MAX_DEPTH && n.wrapType) {
          const children: MdNode[] = [];
          f.out.push({ type: n.wrapType, children });
          stack.push({ node: n.childHead ?? null, out: children, depth: f.depth + 1 });
        } else {
          pushText(f.out, marker);
          stack.push({ node: n.childHead ?? null, out: f.out, depth: f.depth, closeText: marker });
        }
        break;
      }
    }
  }
  return root;
}

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Split a raw text segment by the caller's atom regex. The regex must have
 * exactly ONE capturing group around the whole alternation (like
 * messageParsers' TOKEN_REGEX) so odd split indices are the atoms.
 */
function splitAtoms(raw: string, atomPattern: RegExp | undefined): InlinePiece[] {
  if (!atomPattern) return [{ kind: "text", raw }];
  const parts = raw.split(atomPattern);
  const out: InlinePiece[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    if (i % 2 === 1) out.push({ kind: "atom", value: part });
    else out.push({ kind: "text", raw: part });
  }
  return out;
}

/**
 * Parse a message into the markdown-lite AST.
 *
 * @param atomPattern global regex with one capture group; its matches become
 *   opaque `atom` nodes (never scanned for delimiters).
 */
export function parseMarkdownLite(text: string, atomPattern?: RegExp): MdNode[] {
  const segments = scanCodeSegments(text);
  const out: MdNode[] = [];
  let pending: InlinePiece[] = [];
  let stripLeadingNewline = false;

  const flushInline = () => {
    if (pending.length === 0) return;
    for (const node of parseInline(pending)) {
      const last = out[out.length - 1];
      if (node.type === "text" && last && last.type === "text") last.value += node.value;
      else out.push(node);
    }
    pending = [];
  };

  for (const seg of segments) {
    if (seg.kind === "codeBlock") {
      flushInline();
      out.push({ type: "codeBlock", value: seg.value, lang: seg.lang });
      stripLeadingNewline = true;
      continue;
    }
    if (seg.kind === "code") {
      pending.push({ kind: "code", value: seg.value });
      stripLeadingNewline = false;
      continue;
    }
    let raw = seg.raw;
    // A fenced block renders as its own <pre>; the newline right after the
    // closing fence would otherwise add a blank line under it.
    if (stripLeadingNewline && raw.startsWith("\n")) raw = raw.slice(1);
    stripLeadingNewline = false;
    if (raw) pending.push(...splitAtoms(raw, atomPattern));
  }
  flushInline();
  return out;
}

/** Visit every atom outside spoilers (code never holds atoms). */
export function collectAtomsOutsideSpoilers(nodes: MdNode[], into: string[] = []): string[] {
  const stack: MdNode[][] = [nodes];
  while (stack.length > 0) {
    const list = stack.pop();
    if (!list) break;
    for (const n of list) {
      if (n.type === "atom") into.push(n.value);
      else if (n.type === "strong" || n.type === "em") stack.push(n.children);
    }
  }
  return into;
}
