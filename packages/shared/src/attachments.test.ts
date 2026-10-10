import { describe, expect, it } from "vitest";
import { createAttachmentSchema, sanitizeFilename } from "./index.js";

describe("sanitizeFilename", () => {
  it.each([
    ["../../etc/passwd", "passwd"],
    ["a/b\\c", "c"],
    ["C:\\Users\\me\\cv.pdf", "cv.pdf"],
    ["bad\0na\nme\t.txt", "badname.txt"],
    ["evil\u202Egnp.exe", "evilgnp.exe"],
    ["  many   spaces  .png ", "many spaces .png"],
    [".gitignore", ".gitignore"],
    ["x".repeat(300), "x".repeat(255)],
    ["", ""],
    ["...", ""],
    ["..", ""],
    ["///", ""],
    ["\0\n", ""],
  ])("%j -> %j", (input, expected) => {
    expect(sanitizeFilename(input)).toBe(expected);
  });

  it("never splits a surrogate pair when cutting", () => {
    expect(Array.from(sanitizeFilename("😀".repeat(300)))).toHaveLength(255);
  });
});

describe("createAttachmentSchema", () => {
  const ok = { filename: "a.png", contentType: "image/png", size: 10, channelId: "c" };
  it("needs exactly one target", () => {
    expect(createAttachmentSchema.safeParse(ok).success).toBe(true);
    expect(createAttachmentSchema.safeParse({ ...ok, dmChannelId: "d" }).success).toBe(false);
    expect(createAttachmentSchema.safeParse({ ...ok, channelId: undefined }).success).toBe(false);
  });
  it("rejects an empty sanitized name, unlisted types and bad sizes", () => {
    for (const bad of [{ filename: "../.." }, { contentType: "image/svg+xml" }, { size: 0 }, { size: 25 * 1024 * 1024 + 1 }, { size: 1.5 }])
      expect(createAttachmentSchema.safeParse({ ...ok, ...bad }).success, JSON.stringify(bad)).toBe(false);
    expect(createAttachmentSchema.safeParse({ ...ok, size: 25 * 1024 * 1024 }).success).toBe(true);
  });
});
