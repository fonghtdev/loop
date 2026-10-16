import { describe, expect, it } from "vitest";
import { gifSearchQuerySchema, gifSize, isGifUrl, wholeGifUrl } from "./gifs.js";
import { linkPreviewUrls } from "./links.js";

describe("isGifUrl", () => {
  it.each(["https://media0.giphy.com/media/abc/200.gif", "https://media4.giphy.com/x.gif?cid=1#w=2&h=3", "https://i.giphy.com/abc.gif", "HTTPS://MEDIA2.GIPHY.COM/a.gif"])("accepts %s", (u) => {
    expect(isGifUrl(u)).toBe(true);
  });
  it.each([
    "http://media0.giphy.com/a.gif",
    "https://media0.giphy.com.evil.com/a.gif",
    "https://evilgiphy.com/a.gif",
    "https://evil.com/media0.giphy.com/a.gif",
    "https://media0.giphy.com@evil.com/a.gif",
    "https://user:pw@media0.giphy.com/a.gif",
    "https://media0.giphy.com:8443/a.gif",
    "https://media5.giphy.com/a.gif",
    "https://media.giphy.com/a.gif",
    "https://giphy.com/a.gif",
    "https://sub.media0.giphy.com/a.gif",
    "javascript:alert(1)//media0.giphy.com",
    "//media0.giphy.com/a.gif",
    "not a url",
    "",
  ])("rejects %s", (u) => {
    expect(isGifUrl(u)).toBe(false);
  });
});

describe("wholeGifUrl", () => {
  const u = "https://media1.giphy.com/media/a/200.gif";
  it("is the URL when it is the whole message", () => {
    expect(wholeGifUrl(`  ${u}\n`)).toBe(u);
  });
  it.each([`look ${u}`, `${u} lol`, `${u}\n${u}`, "https://evil.com/a.gif", ""])("is null for %j", (c) => {
    expect(wholeGifUrl(c)).toBeNull();
  });
});

describe("gifSize", () => {
  it("reads the hint and refuses nonsense", () => {
    expect(gifSize("https://i.giphy.com/a.gif#w=200&h=150")).toEqual({ width: 200, height: 150 });
    for (const bad of ["https://i.giphy.com/a.gif", "#w=0&h=5", "#w=5&h=99999", "#w=1.5&h=2", "#w=x&h=2", "#w=3"]) expect(gifSize(bad)).toBeNull();
  });
});

describe("gifSearchQuerySchema", () => {
  it("trims, defaults and bounds", () => {
    expect(gifSearchQuerySchema.parse({ q: " cat " })).toEqual({ q: "cat", offset: 0, limit: 24 });
    for (const bad of [{}, { q: "  " }, { q: "x".repeat(101) }, { q: "a", limit: "31" }, { q: "a", limit: "0" }, { q: "a", offset: "-1" }, { q: "a", extra: "1" }, { q: "a\u0000" }])
      expect(gifSearchQuerySchema.safeParse(bad).success).toBe(false);
  });
});

describe("link previews skip GIF hosts", () => {
  it("leaves them out of the candidates", () => {
    expect(linkPreviewUrls("https://media0.giphy.com/a.gif and https://example.com/x")).toEqual(["https://example.com/x"]);
  });
});
