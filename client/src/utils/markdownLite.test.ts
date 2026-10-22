import { describe, it, expect } from "vitest";
import { MAX_DEPTH, parseMarkdownLite, scanCodeSegments, type MdNode } from "./markdownLite";
import { TOKEN_REGEX } from "./messageParsers";

const parse = (s: string) => parseMarkdownLite(s, TOKEN_REGEX);
const text = (value: string): MdNode => ({ type: "text", value });

/** Compact S-expression for readable assertions. */
function show(nodes: MdNode[]): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case "text":
          return JSON.stringify(n.value);
        case "atom":
          return `atom(${n.value})`;
        case "code":
          return `code(${n.value})`;
        case "codeBlock":
          return `block[${n.lang}](${n.value})`;
        default:
          return `${n.type}(${show(n.children)})`;
      }
    })
    .join(" ");
}

function depth(nodes: MdNode[]): number {
  let max = 0;
  for (const n of nodes) {
    if (n.type === "strong" || n.type === "em" || n.type === "spoiler") {
      max = Math.max(max, 1 + depth(n.children));
    }
  }
  return max;
}

describe("parseMarkdownLite — emphasis", () => {
  it("bold", () => expect(show(parse("**k**"))).toBe('strong("k")'));
  it("italic with *", () => expect(show(parse("*i*"))).toBe('em("i")'));
  it("italic with _", () => expect(show(parse("_i_"))).toBe('em("i")'));
  it("snake_case_ad is not italic", () => {
    expect(parse("snake_case_ad")).toEqual([text("snake_case_ad")]);
  });
  it("italic inside bold", () => {
    expect(show(parse("**k *i* k**"))).toBe('strong("k " em("i") " k")');
  });
  it("triple star nests em + strong", () => {
    const out = show(parse("***x***"));
    expect(out === 'em(strong("x"))' || out === 'strong(em("x"))').toBe(true);
  });
  it("unclosed ** stays literal", () => {
    expect(parse("**x")).toEqual([text("**x")]);
  });
  it("whitespace-flanked * is literal", () => {
    expect(parse("a * b * c")).toEqual([text("a * b * c")]);
  });
  it("surrounding text is preserved", () => {
    expect(show(parse("hi **there** you"))).toBe('"hi " strong("there") " you"');
  });
});

describe("parseMarkdownLite — spoiler", () => {
  it("||s||", () => expect(show(parse("||s||"))).toBe('spoiler("s")'));
  it("|||| (empty) is literal", () => expect(parse("||||")).toEqual([text("||||")]));
  it("custom emoji token inside spoiler stays an atom", () => {
    expect(show(parse("||<:kedi:0123456789abcdef>||"))).toBe(
      "spoiler(atom(<:kedi:0123456789abcdef>))",
    );
  });
  it("single | is literal", () => expect(parse("a | b")).toEqual([text("a | b")]));
  it("a URL does not swallow the closing ||", () => {
    expect(show(parse("||https://a.com/x||"))).toBe("spoiler(atom(https://a.com/x))");
  });
});

describe("parseMarkdownLite — code", () => {
  it("inline code content is literal", () => {
    expect(show(parse("`**x**`"))).toBe("code(**x**)");
  });
  it("double-backtick code can hold a single backtick", () => {
    expect(show(parse("``a`b``"))).toBe("code(a`b)");
  });
  it("unclosed inline code is literal", () => {
    expect(parse("`abc")).toEqual([text("`abc")]);
  });
  it("fenced block with language label", () => {
    expect(show(parse("```ts\nconst a = **1**;\n```"))).toBe("block[ts](const a = **1**;)");
  });
  it("fenced block swallows the newline after the closing fence", () => {
    expect(show(parse("```\nx\n```\nafter"))).toBe('block[](x) "after"');
  });
  it("unclosed fence is literal", () => {
    expect(parse("```js\nno end")).toEqual([text("```js\nno end")]);
  });
  it("mentions / URLs inside code are not atoms", () => {
    expect(show(parse("`<@abc123> https://a.com`"))).toBe("code(<@abc123> https://a.com)");
  });
  it("scanCodeSegments round-trips raw text exactly", () => {
    const src = "a `b` ```\nc\n``` \\`d` ``e";
    expect(scanCodeSegments(src).map((s) => s.raw).join("")).toBe(src);
  });
});

describe("parseMarkdownLite — escapes and atoms", () => {
  it("\\*x\\* is literal", () => expect(parse("\\*x\\*")).toEqual([text("*x*")]));
  it("escaped backtick does not open code", () => {
    expect(parse("\\`a`")).toEqual([text("`a`")]);
  });
  it("URL with markers stays whole", () => {
    expect(show(parse("https://a.com/*x*_y_"))).toBe("atom(https://a.com/*x*_y_)");
  });
  it("bold mention", () => {
    expect(show(parse("**<@abc123>**"))).toBe("strong(atom(<@abc123>))");
  });
  it("@user_name_x stays one atom", () => {
    expect(show(parse("@user_name_x"))).toBe("atom(@user_name_x)");
  });
  it("custom emoji token is never split by _", () => {
    expect(show(parse("_<:a_b:0123456789abcdef>_"))).toBe("em(atom(<:a_b:0123456789abcdef>))");
  });
});

describe("parseMarkdownLite — depth and linearity", () => {
  it(`nesting deeper than ${MAX_DEPTH} is emitted as literal text`, () => {
    const levels = 12;
    let s = "x";
    for (let i = 0; i < levels; i++) s = i % 2 === 0 ? `*a ${s} a*` : `||b ${s} b||`;
    const nodes = parse(s);
    expect(depth(nodes)).toBe(MAX_DEPTH);
    // Nothing is lost: flattening the tree gives back every character.
    const flat = (ns: MdNode[]): string =>
      ns
        .map((n) =>
          n.type === "text" || n.type === "atom" || n.type === "code" || n.type === "codeBlock"
            ? n.value
            : flat(n.children),
        )
        .join("");
    // The innermost levels beyond the cap keep their markers as literal text.
    expect(flat(nodes)).toContain("||b *a x a* b||");
  });

  // Linearity is asserted by how parse time scales, not by a wall-clock
  // budget: a 4× larger input must take well under the ~16× a quadratic
  // parser would need. Ratios stay stable on a loaded CI box where a fixed
  // millisecond threshold flakes. A generous absolute cap remains as a
  // backstop against pathological slowness.
  const cases: [string, (n: number) => string, number][] = [
    ["*", (n) => "*".repeat(n), 100_000],
    ["**a", (n) => "**a".repeat(n), 50_000],
    ["*_| alternating", (n) => "*_|".repeat(n), 33_334],
    ["`", (n) => "`".repeat(n), 100_000],
    ["` a", (n) => "` a".repeat(n), 33_334],
    ["deep nesting", (n) => `${"*a ".repeat(n)}x${" a*".repeat(n)}`, 10_000],
  ];
  const fastest = (input: string): number => {
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      parse(input);
      best = Math.min(best, performance.now() - start);
    }
    return best;
  };
  for (const [label, build, n] of cases) {
    it(`${label} scales linearly (${n} units)`, () => {
      const small = fastest(build(Math.floor(n / 4)));
      const large = fastest(build(n));
      expect(large).toBeLessThan(3000);
      // Below ~5 ms the ratio is timer noise; the absolute cap covers it.
      if (large > 5) {
        expect(large / Math.max(small, 0.5)).toBeLessThan(10);
      }
    });
  }
});
