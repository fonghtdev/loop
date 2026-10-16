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
      expect(classify(url)).toEqual({ url, source: "youtube" });
  });

  it("keeps a link with &list= as one link (the player asks for a single video)", () => {
    const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123";
    expect(classify(url)).toEqual({ url, source: "youtube" });
  });

  it("SoundCloud links are recognised by host; any other public http(s) link is passed on as a plain link", () => {
    for (const url of ["https://soundcloud.com/a/b", "https://on.soundcloud.com/xyz", "https://m.soundcloud.com/a/b"]) expect(classify(url)).toEqual({ url, source: "soundcloud" });
    for (const url of ["https://example.com/a.mp3", "http://radio.example.org/stream", "https://youtube.com.evil.com/watch?v=x", "https://notyoutube.com/x"])
      expect(classify(url)).toEqual({ url, source: "url" });
  });

  it("never fetches the host's own network or other schemes: those stay a search", () => {
    for (const q of ["http://127.0.0.1:8080/x", "http://10.0.0.5/a.mp3", "http://[::1]/a", "http://localhost/a", "http://redis/a", "https://db.internal/a", "https://printer.local/a", "https://user:pw@example.com/a", "https://user@evil.com@youtube.com.evil.com/", "javascript:alert(1)", "file:///etc/passwd", "ftp://youtube.com/x"])
      expect(classify(q)).toEqual({ search: q });
  });

  it("`sc <text>` searches SoundCloud only; plain text is a normal search; `sc` alone or inside a word is not the switch", () => {
    expect(classify("sc lofi beats")).toEqual({ search: "lofi beats", only: "soundcloud" });
    expect(classify("SC lofi")).toEqual({ search: "lofi", only: "soundcloud" });
    for (const q of ["lofi beats", "sc", "scarface theme", "my sc song"]) expect(classify(q)).toEqual({ search: q });
  });
});
