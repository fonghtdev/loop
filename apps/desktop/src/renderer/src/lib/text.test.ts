import { describe, expect, it } from "vitest";
import { avatarColor, AVATAR_COLORS, initials, isSubmitKey, linkify } from "./text";

const links = (s: string) => linkify(s).filter((p) => p.href).map((p) => p.href);

describe("linkify", () => {
  it("links http and https, keeping the text around them", () => {
    expect(linkify("xem http://a.vn và https://b.com/x?y=1#z nhé")).toEqual([
      { text: "xem " },
      { text: "http://a.vn", href: "http://a.vn" },
      { text: " và " },
      { text: "https://b.com/x?y=1#z", href: "https://b.com/x?y=1#z" },
      { text: " nhé" },
    ]);
  });

  it("never links javascript:, data:, file: or other schemes", () => {
    for (const s of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<b>x</b>", "file:///etc/passwd", "vbscript:x", "ftp://a.b"]) {
      expect(links(s), s).toEqual([]);
      expect(linkify(s).map((p) => p.text).join("")).toBe(s);
    }
    expect(links("javascript://https://evil.com")).toEqual(["https://evil.com"]); // only the real web link part
  });

  it("drops trailing punctuation but keeps balanced parentheses", () => {
    expect(links("Vào https://a.vn/b.")).toEqual(["https://a.vn/b"]);
    expect(links("(https://a.vn/x), rồi https://b.vn!")).toEqual(["https://a.vn/x", "https://b.vn"]);
    expect(links("https://vi.wikipedia.org/wiki/Hồ_(định_hướng)")).toEqual(["https://vi.wikipedia.org/wiki/Hồ_(định_hướng)"]);
  });

  it("handles unicode paths and malformed URLs", () => {
    expect(links("https://vi.wikipedia.org/wiki/Việt_Nam")).toEqual(["https://vi.wikipedia.org/wiki/Việt_Nam"]);
    expect(links("https:// hỏng")).toEqual([]);
    expect(links("http://")).toEqual([]);
    expect(links("xhttps://a.vn")).toEqual([]); // not at a word start
  });

  it("returns the text unchanged when there is no link", () => {
    expect(linkify("dòng 1\ndòng 2")).toEqual([{ text: "dòng 1\ndòng 2" }]);
    expect(linkify("")).toEqual([]);
  });
});

describe("isSubmitKey (IME-safe Enter)", () => {
  const enter = { key: "Enter", shiftKey: false, isComposing: false, keyCode: 13 };
  it("Enter submits, Shift+Enter does not", () => {
    expect(isSubmitKey(enter)).toBe(true);
    expect(isSubmitKey({ ...enter, shiftKey: true })).toBe(false);
    expect(isSubmitKey({ ...enter, key: "a", keyCode: 65 })).toBe(false);
  });
  it("the Enter confirming a Telex/VNI composition never submits", () => {
    expect(isSubmitKey({ ...enter, isComposing: true })).toBe(false);
    expect(isSubmitKey({ ...enter, keyCode: 229 })).toBe(false); // Chromium's composition keyCode
  });
});

describe("avatars", () => {
  it("initials take the first letters of two words, in Vietnamese upper case", () => {
    expect(initials("nhóm bạn thân")).toBe("NB");
    expect(initials("đỗ")).toBe("ĐỖ");
    expect(initials("  ")).toBe("?");
  });
  it("the colour depends only on the id and stays in range", () => {
    expect(avatarColor("abc")).toBe(avatarColor("abc"));
    const seen = new Set(Array.from({ length: 200 }, (_, i) => avatarColor(`id-${i}`)));
    expect([...seen].every((c) => c >= 1 && c <= AVATAR_COLORS)).toBe(true);
    expect(seen.size).toBe(AVATAR_COLORS);
  });
});
