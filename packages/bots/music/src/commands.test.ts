import { describe, expect, it } from "vitest";
import { classify, parseCommand } from "./commands.js";

describe("parseCommand", () => {
  it("needs the prefix right in front of the name; name is case-insensitive, args are trimmed and collapsed", () => {
    expect(parseCommand("!play  Lo-fi   beats ")).toEqual({ name: "play", args: "Lo-fi beats" });
    expect(parseCommand("  !SKIP")).toEqual({ name: "skip", args: "" });
    expect(parseCommand("!play")).toEqual({ name: "play", args: "" });
    expect(parseCommand("!play\nsecond line")).toEqual({ name: "play", args: "second line" });
  });

  it("is not a command without the prefix, or with a space after it", () => {
    for (const text of ["play x", "hello !play", "! play x", "!", "", "?play x"]) expect(parseCommand(text)).toBeNull();
  });
});

describe("classify", () => {
  it("takes links on the known YouTube hosts", () => {
    for (const url of ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://youtu.be/dQw4w9WgXcQ", "http://m.youtube.com/watch?v=x", "https://music.youtube.com/watch?v=x", "https://youtube.com/watch?v=x"])
      expect(classify(url)).toEqual({ url });
  });

  it("keeps a link with &list= as one link (the player asks for a single video)", () => {
    const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123";
    expect(classify(url)).toEqual({ url });
  });

  it("treats look-alike hosts, other schemes and other sites as a search", () => {
    for (const q of ["https://youtube.com.evil.com/watch?v=x", "https://evil.com/?u=youtube.com", "https://notyoutube.com/x", "javascript:alert(1)", "file:///etc/passwd", "ftp://youtube.com/x", "https://example.com/a.mp3", "lofi beats", "https://user@evil.com@youtube.com.evil.com/"])
      expect(classify(q)).toEqual({ search: q });
  });
});
