import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE } from "@loop/shared";
import { describe, expect, it } from "vitest";
import { checkFile, checkFiles, fileKind, formatSize } from "./attachment-rules";

const file = (name: string, size = 1000, type = "image/png") => ({ name, size, type });

describe("checkFile (the shared limits, client side)", () => {
  it("accepts a normal file and returns the clean name", () => {
    expect(checkFile(file("ảnh đẹp.png"), 0)).toEqual({ ok: true, filename: "ảnh đẹp.png" });
  });
  it("size: exactly 25 MB passes, one byte more is refused, empty is refused", () => {
    expect(checkFile(file("a.png", MAX_ATTACHMENT_BYTES), 0).ok).toBe(true);
    expect(checkFile(file("a.png", MAX_ATTACHMENT_BYTES + 1), 0)).toEqual({ ok: false, reason: "tooLarge" });
    expect(checkFile(file("a.png", 0), 0)).toEqual({ ok: false, reason: "empty" });
  });
  it("type: only the allowlist, by the file's real type; unknown or empty type is refused", () => {
    for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain", "application/zip", "video/mp4", "audio/mpeg"])
      expect(checkFile(file("f", 5, type), 0).ok, type).toBe(true);
    for (const type of ["", "application/x-msdownload", "application/octet-stream", "image/svg+xml", "text/html", "IMAGE/PNG"])
      expect(checkFile(file("f.png", 5, type), 0), type).toEqual({ ok: false, reason: "type" });
  });
  it("a .exe is refused whatever it is named, a PNG-looking name does not make a type", () => {
    expect(checkFile(file("virus.exe", 50, "application/x-msdownload"), 0)).toEqual({ ok: false, reason: "type" });
    expect(checkFile(file("virus.exe", 50, ""), 0)).toEqual({ ok: false, reason: "type" });
  });
  it("count: the 11th file is refused", () => {
    expect(checkFile(file("a.png"), MAX_ATTACHMENTS_PER_MESSAGE - 1).ok).toBe(true);
    expect(checkFile(file("a.png"), MAX_ATTACHMENTS_PER_MESSAGE)).toEqual({ ok: false, reason: "tooMany" });
  });
  it("names go through the shared sanitizer: traversal, control and bidi characters, long names", () => {
    expect(checkFile(file("../../etc/passwd.png"), 0)).toEqual({ ok: true, filename: "passwd.png" });
    expect(checkFile(file("C:\\Users\\a\\b.png"), 0)).toEqual({ ok: true, filename: "b.png" });
    expect(checkFile(file("a\u202Egnp.exe"), 0)).toEqual({ ok: true, filename: "agnp.exe" });
    expect(checkFile(file("\u0007\u0000x.png"), 0)).toEqual({ ok: true, filename: "x.png" });
    const long = checkFile(file("é".repeat(400) + ".png"), 0);
    expect(long.ok && Array.from(long.filename).length).toBe(255);
    expect(checkFile(file("..."), 0)).toEqual({ ok: false, reason: "name" });
    expect(checkFile(file("   "), 0)).toEqual({ ok: false, reason: "name" });
  });
});

describe("checkFiles (a batch)", () => {
  it("counts what is already held and what was accepted earlier in the batch", () => {
    const batch = Array.from({ length: 4 }, (_, i) => file(`f${i}.png`));
    const { accepted, rejected } = checkFiles(batch, MAX_ATTACHMENTS_PER_MESSAGE - 2);
    expect(accepted.map((a) => a.filename)).toEqual(["f0.png", "f1.png"]);
    expect(rejected).toEqual([
      { name: "f2.png", reason: "tooMany" },
      { name: "f3.png", reason: "tooMany" },
    ]);
  });
  it("keeps the good files when others are refused", () => {
    const { accepted, rejected } = checkFiles([file("ok.png"), file("big.png", MAX_ATTACHMENT_BYTES + 1), file("x.exe", 3, "")], 0);
    expect(accepted).toHaveLength(1);
    expect(rejected.map((r) => r.reason)).toEqual(["tooLarge", "type"]);
  });
});

describe("display helpers", () => {
  it("formats sizes with a Vietnamese decimal comma", () => {
    expect(formatSize(500)).toBe("500 B");
    expect(formatSize(1536)).toBe("1,5 KB");
    expect(formatSize(MAX_ATTACHMENT_BYTES)).toBe("25 MB");
  });
  it("kinds", () => {
    expect([fileKind("image/gif"), fileKind("application/pdf"), fileKind("application/zip"), fileKind("video/mp4"), fileKind("audio/mpeg"), fileKind("text/plain")]).toEqual(["image", "pdf", "zip", "video", "audio", "text"]);
  });
});
