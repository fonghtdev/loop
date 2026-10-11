import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const dir = dirname(require.resolve("@fontsource-variable/plus-jakarta-sans/package.json"));
const faces = [...readFileSync(join(dir, "wght.css"), "utf8").matchAll(/@font-face\s*{[^}]*}/g)].map((m) => m[0]);

const ranges = (face: string) =>
  [...(face.match(/unicode-range:\s*([^;]+);/)?.[1] ?? "").matchAll(/U\+([0-9A-F]+)(?:-([0-9A-F]+))?/gi)].map((m) => [parseInt(m[1], 16), parseInt(m[2] ?? m[1], 16)] as const);
const covered = (cp: number) => faces.some((f) => ranges(f).some(([a, b]) => cp >= a && cp <= b));

// the mock's glyph test: base letters with every Vietnamese tone mark
const VIETNAMESE = "ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ";

describe("Plus Jakarta Sans (self-hosted)", () => {
  it.each([...VIETNAMESE])("covers %s", (ch) => {
    expect(covered(ch.codePointAt(0)!), ch).toBe(true);
  });
  it("is a variable font file shipped with the package (offline, no CDN)", () => {
    expect(faces.every((f) => /url\(\.\/files\/[^)]+\.woff2\)/.test(f))).toBe(true);
    expect(faces.some((f) => /font-weight:\s*200 800/.test(f))).toBe(true);
  });
});
