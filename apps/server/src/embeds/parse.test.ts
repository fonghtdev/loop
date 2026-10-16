import { describe, expect, it } from "vitest";
import { clean, MAX, parsePreview } from "./parse.js";

const page = "https://www.site.example/a/b";

describe("parsePreview", () => {
  it("prefers Open Graph, then Twitter, then <title> / meta description", () => {
    const og = `<meta property="og:title" content="OG"><meta name="twitter:title" content="TW"><title>T</title>
      <meta property='og:description' content='D'><meta property="og:site_name" content="Site"><meta property="og:image" content="/i.png">`;
    expect(parsePreview(og, page)).toEqual({ title: "OG", description: "D", siteName: "Site", image: "https://www.site.example/i.png" });
    expect(parsePreview(`<meta name="twitter:title" content="TW"><meta name="twitter:image" content="https://cdn.example/x.jpg"><title>T</title>`, page))
      .toEqual({ title: "TW", description: null, siteName: "site.example", image: "https://cdn.example/x.jpg" });
    expect(parsePreview(`<title data-x="1">Plain &amp; simple</title><meta name=description content=Words>`, page))
      .toEqual({ title: "Plain & simple", description: "Words", siteName: "site.example", image: null });
  });

  it("nothing to show is null", () => {
    expect(parsePreview("<html><body>hello</body></html>", page)).toBeNull();
    expect(parsePreview(`<meta property="og:title" content="   ">`, page)).toBeNull();
  });

  it("only http(s) images, resolved against the page", () => {
    const img = (src: string) => parsePreview(`<title>x</title><meta property="og:image" content="${src}">`, page)!.image;
    expect(img("javascript:alert(1)")).toBeNull();
    expect(img("data:image/png;base64,AAAA")).toBeNull();
    expect(img("../up.png")).toBe("https://www.site.example/up.png");
    expect(img("http://[bad")).toBeNull();
  });

  it("decodes entities and strips control and bidi characters", () => {
    const p = parsePreview(`<title>A&#x202E;B&#8238;C\u202Ed&#65;&lt;&#0;&#xD800;\u0007</title>`, page)!;
    expect(p.title).toBe("A B C dA<");
  });

  it("first meta of a kind wins; tags are matched case-insensitively", () => {
    expect(parsePreview(`<META PROPERTY="OG:TITLE" CONTENT="first"><meta property="og:title" content="second">`, page)!.title).toBe("first");
  });

  it("stays linear on hostile markup", () => {
    const started = Date.now();
    parsePreview(`<meta ${"a".repeat(400_000)}`, page);
    parsePreview(`<meta ${"a=".repeat(2000)}>`.repeat(100), page);
    parsePreview("<title".repeat(80_000), page);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("clean", () => {
  it.each(Object.entries(MAX))("cuts %s to %i characters with an ellipsis", (_k, max) => {
    const out = clean("é".repeat(max + 10), max)!;
    expect([...out]).toHaveLength(max);
    expect(out.endsWith("…")).toBe(true);
    expect(clean("é".repeat(max), max)).toBe("é".repeat(max));
  });
  it("collapses whitespace, empty is null", () => {
    expect(clean("  a \n\t b  ", 10)).toBe("a b");
    expect(clean(" \n ", 10)).toBeNull();
    expect(clean(undefined, 10)).toBeNull();
  });
});
