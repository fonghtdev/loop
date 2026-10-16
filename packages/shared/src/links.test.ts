import { describe, expect, it } from "vitest";
import { linkPreviewUrls, MAX_EMBEDS_PER_MESSAGE, trimUrlTrailing } from "./links.js";

describe("linkPreviewUrls", () => {
  it("finds http(s) URLs in order, normalised and distinct", () => {
    expect(linkPreviewUrls("see https://a.example/x, and HTTP://B.example then https://a.example/x again")).toEqual(["https://a.example/x", "http://b.example/"]);
  });
  it("keeps at most three", () => {
    const text = Array.from({ length: 6 }, (_, i) => `https://s${i}.example`).join(" ");
    expect(linkPreviewUrls(text)).toHaveLength(MAX_EMBEDS_PER_MESSAGE);
    expect(linkPreviewUrls(text)[2]).toBe("https://s2.example/");
  });
  it("skips code spans, fenced blocks and <...>-suppressed links", () => {
    const text = "`https://code.example` ``https://two.example`` <https://quiet.example>\n```\nhttps://fence.example\n```\nhttps://real.example";
    expect(linkPreviewUrls(text)).toEqual(["https://real.example/"]);
  });
  it("drops trailing punctuation, keeps a balanced paren, reads markdown links", () => {
    expect(linkPreviewUrls("(https://w.example/A_(b)) [x](https://md.example/p).")).toEqual(["https://w.example/A_(b)", "https://md.example/p"]);
  });
  it("ignores other schemes, URLs glued to a word, and junk", () => {
    expect(linkPreviewUrls("javascript:alert(1) ftp://x.example xhttps://glued.example https:// http://[::1")).toEqual([]);
  });
  it("trimUrlTrailing is the rule the desktop linkifier uses", () => {
    expect(trimUrlTrailing("https://x.example/a...")).toBe("https://x.example/a");
  });
});
