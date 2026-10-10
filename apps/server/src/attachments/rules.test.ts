import { ATTACHMENT_TYPES } from "@loop/shared";
import { describe, expect, it } from "vitest";
import { contentDisposition, matchesType } from "./rules.js";

const bytes = (...b: (number | string)[]) => Uint8Array.from(b.flatMap((x) => (typeof x === "string" ? [...x].map((c) => c.charCodeAt(0)) : [x])));

const GOOD: Record<string, Uint8Array> = {
  "image/png": bytes(0x89, "PNG\r\n"),
  "image/jpeg": bytes(0xff, 0xd8, 0xff, 0xe0),
  "image/gif": bytes("GIF89a"),
  "image/webp": bytes("RIFF", 1, 2, 3, 4, "WEBPVP8 "),
  "application/pdf": bytes("%PDF-1.7"),
  "application/zip": bytes("PK", 3, 4),
  "video/mp4": bytes(0, 0, 0, 0x18, "ftypmp42"),
  "audio/mpeg": bytes("ID3", 4),
  "text/plain": bytes("hello"),
};

describe("magic numbers", () => {
  it("has a sample for every allowed type", () => expect(Object.keys(GOOD).sort()).toEqual([...ATTACHMENT_TYPES].sort()));

  it.each(Object.entries(GOOD))("%s accepts its own signature", (type, b) => expect(matchesType(type, b)).toBe(true));

  it("accepts the other valid forms", () => {
    expect(matchesType("image/gif", bytes("GIF87a"))).toBe(true);
    expect(matchesType("application/zip", bytes("PK", 5, 6))).toBe(true);
    expect(matchesType("audio/mpeg", bytes(0xff, 0xfb))).toBe(true);
    expect(matchesType("audio/mpeg", bytes(0xff, 0xe3))).toBe(true);
  });

  it("rejects every type's bytes under every other binary type, and empty input", () => {
    for (const [type] of Object.entries(GOOD)) {
      expect(matchesType(type, new Uint8Array())).toBe(false);
      for (const [other, b] of Object.entries(GOOD)) if (other !== type && type !== "text/plain") expect(matchesType(type, b), `${other} as ${type}`).toBe(false);
    }
  });

  it("text/plain rejects NUL bytes; html and exe bytes fail every binary type", () => {
    expect(matchesType("text/plain", bytes("ab", 0, "c"))).toBe(false);
    for (const evil of [bytes("<html><script>"), bytes("MZ", 0x90, 0)])
      for (const type of ATTACHMENT_TYPES.filter((t) => t !== "text/plain")) expect(matchesType(type, evil), type).toBe(false);
  });

  it("an unlisted type never matches", () => expect(matchesType("image/svg+xml", bytes("<svg"))).toBe(false));
});

describe("contentDisposition", () => {
  it.each(["image/png", "image/jpeg", "image/gif", "image/webp"])("%s is inline", (t) => expect(contentDisposition(t, "x")).toBe("inline"));

  it.each(["application/pdf", "text/plain", "application/zip", "video/mp4", "audio/mpeg"])("%s downloads", (t) =>
    expect(contentDisposition(t, "r.bin")).toBe("attachment; filename*=UTF-8''r.bin"),
  );

  it("encodes the name (quotes, spaces, unicode, RFC 5987 specials)", () =>
    expect(contentDisposition("application/pdf", `a "b" (1)*'é.pdf`)).toBe(
      "attachment; filename*=UTF-8''a%20%22b%22%20%281%29%2A%27%C3%A9.pdf",
    ));
});
