import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { t } from "./t";
import { vi } from "./vi";

const srcDir = join(__dirname, "..");
const sources = readdirSync(srcDir, { recursive: true, encoding: "utf8" })
  .filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".test.ts") && !f.endsWith("vi.ts"))
  .map((f) => readFileSync(join(srcDir, f), "utf8"))
  .join("\n");

describe("vi dictionary", () => {
  it("has no unused keys (every key appears as a literal in the renderer source)", () => {
    const unused = Object.keys(vi).filter((k) => !sources.includes(`"${k}"`));
    expect(unused).toEqual([]);
  });

  it("has no empty strings and no em/en dashes", () => {
    for (const [k, v] of Object.entries(vi)) {
      expect(v.trim(), k).not.toBe("");
      expect(v, k).not.toMatch(/[–—]/);
    }
  });

  it("t() interpolates variables and leaves unknown ones visible", () => {
    expect(t("friends.requestSent", { name: "Ngọc" })).toBe("Đã gửi lời mời kết bạn tới Ngọc.");
    expect(t("friends.requestSent", {})).toBe("Đã gửi lời mời kết bạn tới {name}.");
  });
});
