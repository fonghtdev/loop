import { describe, expect, it } from "vitest";
import { usernameSchema } from "./index.js";

describe("usernameSchema", () => {
  it("chấp nhận tên hợp lệ", () => {
    expect(usernameSchema.safeParse("nam_01.x").success).toBe(true);
  });

  it.each(["a", "Nam", "co dau", "x".repeat(33)])("từ chối %j", (name) => {
    expect(usernameSchema.safeParse(name).success).toBe(false);
  });
});
