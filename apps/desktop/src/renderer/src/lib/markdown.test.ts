import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown, type Inline } from "./markdown";

const txt = (text: string): Inline => ({ t: "text", text });
const inline = (s: string) => parseInline(s);
/** Flattens a tree back to the characters it would show (markers that took effect disappear). */
const shown = (nodes: Inline[]): string => nodes.map((n) => (n.t === "text" || n.t === "code" ? n.text : n.t === "mention" ? "" : shown(n.children))).join("");

describe("inline formatting", () => {
  it("plain text is one text node", () => {
    expect(inline("hello world")).toEqual([txt("hello world")]);
    expect(inline("")).toEqual([]);
  });

  it("bold, italic (both markers), strike and inline code", () => {
    expect(inline("**b**")).toEqual([{ t: "strong", children: [txt("b")] }]);
    expect(inline("*i*")).toEqual([{ t: "em", children: [txt("i")] }]);
    expect(inline("_i_")).toEqual([{ t: "em", children: [txt("i")] }]);
    expect(inline("~~s~~")).toEqual([{ t: "del", children: [txt("s")] }]);
    expect(inline("`c *x*`")).toEqual([{ t: "code", text: "c *x*" }]);
    expect(inline("a **b** c")).toEqual([txt("a "), { t: "strong", children: [txt("b")] }, txt(" c")]);
  });

  it("nests, and ***both*** is bold italic", () => {
    expect(inline("**a *b* c**")).toEqual([{ t: "strong", children: [txt("a "), { t: "em", children: [txt("b")] }, txt(" c")] }]);
    expect(inline("***x***")).toEqual([{ t: "strong", children: [{ t: "em", children: [txt("x")] }] }]);
  });

  it("markers that do not close stay text", () => {
    expect(inline("**bold")).toEqual([txt("**bold")]);
    expect(inline("a * b * c")).toEqual([txt("a * b * c")]);
    expect(inline("2 * 3 * 4")).toEqual([txt("2 * 3 * 4")]);
    expect(inline("~~x")).toEqual([txt("~~x")]);
    expect(inline("`open")).toEqual([txt("`open")]);
    expect(inline("****")).toEqual([txt("****")]);
  });

  it("overlapping markers resolve without losing a character", () => {
    expect(shown(inline("**a *b** c*")).replace(/[^abc]/g, "")).toBe("abc");
    expect(shown(inline("*a **b* c**")).replace(/[^abc]/g, "")).toBe("abc");
  });

  it("underscores inside words are not emphasis", () => {
    expect(inline("snake_case_name")).toEqual([txt("snake_case_name")]);
    expect(inline("a _b_ c")).toEqual([txt("a "), { t: "em", children: [txt("b")] }, txt(" c")]);
  });

  it("backslash escapes a marker", () => {
    expect(inline("\\*not\\*")).toEqual([txt("*not*")]);
    expect(inline("a\\b")).toEqual([txt("a\\b")]);
  });

  it("html stays text", () => {
    const out = inline("<script>alert(1)</script> <b>x</b> <img src=x onerror=y>");
    expect(out).toEqual([txt("<script>alert(1)</script> <b>x</b> <img src=x onerror=y>")]);
  });

  it("emphasis inside code is not applied; code inside emphasis is", () => {
    expect(inline("**`x`**")).toEqual([{ t: "strong", children: [{ t: "code", text: "x" }] }]);
    expect(inline("``a ` b``")).toEqual([{ t: "code", text: "a ` b" }]);
  });
});

describe("links", () => {
  it("bare http(s) URLs become links, trailing punctuation stays outside", () => {
    expect(inline("see https://a.com/x_y_z, ok")).toEqual([txt("see "), { t: "link", href: "https://a.com/x_y_z", children: [txt("https://a.com/x_y_z")] }, txt(", ok")]);
  });

  it("[label](url) with http(s) only; the label may be formatted", () => {
    expect(inline("[**hi**](https://a.com)")).toEqual([{ t: "link", href: "https://a.com", children: [{ t: "strong", children: [txt("hi")] }] }]);
  });

  it.each(["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "ftp://a.com", "//a.com", "HTTP://"])("rejects [x](%s)", (url) => {
    const out = inline(`[x](${url})`);
    expect(JSON.stringify(out)).not.toContain('"t":"link"');
    expect(shown(out)).toBe(`[x](${url})`);
  });

  it("a label with a newline or no text is not a markdown link (the URL itself still links)", () => {
    expect(inline("[a\nb](https://a.com)")[0]).toEqual(txt("[a\nb]("));
    expect(inline("[](https://a.com)")[0]).toEqual(txt("[]("));
  });

  it("a bare URL with a markdown-looking tail is still one link", () => {
    const out = inline("https://a.com/*a*");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ t: "link" });
  });
});

describe("blocks", () => {
  it("plain multi-line text is one paragraph with its newlines", () => {
    expect(parseMarkdown("a\nb\n\nc")).toEqual([{ t: "p", children: [txt("a\nb\n\nc")] }]);
  });

  it("fenced code keeps its text raw and has a language label", () => {
    expect(parseMarkdown("before\n```ts\nconst a = **1**;\n<b>\n```\nafter")).toEqual([
      { t: "p", children: [txt("before")] },
      { t: "code", lang: "ts", text: "const a = **1**;\n<b>" },
      { t: "p", children: [txt("after")] },
    ]);
    expect(parseMarkdown("```\nx\n```")).toEqual([{ t: "code", lang: "", text: "x" }]);
  });

  it("an unclosed fence is plain text", () => {
    expect(parseMarkdown("```js\nlet a")).toEqual([{ t: "p", children: [txt("```js\nlet a")] }]);
  });

  it("blockquote lines merge; '>' without a space is text", () => {
    expect(parseMarkdown("> a\n> **b**\nc")).toEqual([
      { t: "quote", children: [txt("a\n"), { t: "strong", children: [txt("b")] }] },
      { t: "p", children: [txt("c")] },
    ]);
    expect(parseMarkdown(">a")).toEqual([{ t: "p", children: [txt(">a")] }]);
  });
});

describe("hostile and huge input", () => {
  const time = (fn: () => unknown) => {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  };
  const N = 200_000;

  it.each([
    ["stars", "*".repeat(N)],
    ["star pairs", "*a ".repeat(N / 3)],
    ["open markers of every kind", "**a *b ~~c _d ".repeat(N / 14)],
    ["unclosed brackets", "[".repeat(N)],
    ["many label starts, one bad target", "[a".repeat(N / 4) + "](javascript:x)"],
    ["backticks", "`".repeat(N)],
    ["mixed backtick lengths", Array.from({ length: 600 }, (_, i) => "`".repeat(i + 1) + "x").join(" ")],
    ["unclosed fences", "```\n".repeat(N / 4)],
    ["quote lines", "> x\n".repeat(N / 4)],
    ["url starts", "http://".repeat(N / 7)],
    ["escapes", "\\*".repeat(N / 2)],
  ])("%s parses in linear time and keeps every character", (_, input) => {
    let blocks: ReturnType<typeof parseMarkdown> = [];
    const ms = time(() => (blocks = parseMarkdown(input)));
    expect(ms).toBeLessThan(2000);
    expect(blocks.length).toBeGreaterThan(0);
  });

  it("deeply alternating emphasis does not recurse", () => {
    expect(() => parseInline("*a ".repeat(50_000) + "b* ".repeat(50_000))).not.toThrow();
  });
});

describe("mentions", () => {
  const id = "0a1b2c3d-0000-4000-8000-00000000000a";

  it("<@uuid> becomes a mention node among the text", () => {
    expect(inline(`hi <@${id}>, ok`)).toEqual([txt("hi "), { t: "mention", id }, txt(", ok")]);
  });
  it("the id is lowercased", () => {
    expect(inline(`<@${id.toUpperCase()}>`)).toEqual([{ t: "mention", id }]);
  });
  it("anything that is not a full uuid stays text", () => {
    for (const bad of ["<@nope>", "<@123>", "<@>", `<@${id}`, `<@ ${id}>`, `<@!${id}>`, `<@${id}x>`, "<@"]) expect(inline(bad), bad).toEqual([txt(bad)]);
  });
  it("works inside emphasis and a link label, not inside code", () => {
    expect(inline(`**<@${id}>**`)).toEqual([{ t: "strong", children: [{ t: "mention", id }] }]);
    expect(inline(`\`<@${id}>\``)).toEqual([{ t: "code", text: `<@${id}>` }]);
    expect(inline(`[<@${id}>](https://example.com)`)).toEqual([{ t: "link", href: "https://example.com", children: [{ t: "mention", id }] }]);
  });
  it("in a quote and a paragraph", () => {
    expect(parseMarkdown(`> <@${id}>`)).toEqual([{ t: "quote", children: [{ t: "mention", id }] }]);
  });
});
