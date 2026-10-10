import { describe, expect, it } from "vitest";
import { channelNameError, guildNameError, normalizeChannelName, parseInviteCode, validate } from "./validation";

describe("validate", () => {
  it("requires every field of the mode", () => {
    expect(validate("register", { email: "", username: "", password: "" })).toEqual({
      email: "Vui lòng điền mục này.",
      username: "Vui lòng điền mục này.",
      password: "Vui lòng điền mục này.",
    });
    expect(Object.keys(validate("login", { email: "", username: "", password: "" }))).toEqual(["email", "password"]);
  });

  it("maps the shared schema's rules to Vietnamese per field", () => {
    expect(validate("register", { email: "nope", username: "A b", password: "short" })).toEqual({
      email: "Email chưa đúng định dạng.",
      username: "Chỉ dùng chữ thường không dấu, số, dấu _ và dấu chấm.",
      password: "Mật khẩu cần ít nhất 8 ký tự.",
    });
    expect(validate("register", { email: "a@b.co", username: "a", password: "x".repeat(129) })).toEqual({
      username: "Tên người dùng cần ít nhất 2 ký tự.",
      password: "Mật khẩu tối đa 128 ký tự.",
    });
  });

  it("accepts valid input; login does not length-check the password", () => {
    expect(validate("register", { email: " An@Example.com ", username: "an_01", password: "12345678" })).toEqual({});
    expect(validate("login", { email: "an@example.com", username: "", password: "x" })).toEqual({});
  });
});

describe("server, channel and invite fields", () => {
  it("server name: required after trimming, at most 100", () => {
    expect(guildNameError("   ")).toBe("Vui lòng điền mục này.");
    expect(guildNameError("x".repeat(101))).toBe("Tên máy chủ tối đa 100 ký tự.");
    expect(guildNameError("Nhóm Bạn Thân")).toBeUndefined();
  });

  it("channel name: the shared schema's characters and length", () => {
    expect(channelNameError("")).toBe("Vui lòng điền mục này.");
    expect(channelNameError("Chung")).toBe("Chỉ dùng chữ thường không dấu, số, dấu - và dấu _.");
    expect(channelNameError("thảo-luận")).toBe("Chỉ dùng chữ thường không dấu, số, dấu - và dấu _.");
    expect(channelNameError("a".repeat(101))).toBe("Tên kênh tối đa 100 ký tự.");
    expect(channelNameError("tro-chuyen_1")).toBeUndefined();
    expect(normalizeChannelName("Tro Chuyen  Chung")).toBe("tro-chuyen-chung");
  });

  it("invite code: plain code or the end of a pasted link", () => {
    expect(parseInviteCode(" aB3dE9_x ")).toBe("aB3dE9_x");
    expect(parseInviteCode("https://loop.app/invite/aB3dE9_x/")).toBe("aB3dE9_x");
    expect(parseInviteCode("../../guilds")).toBe("guilds"); // only the last segment ever reaches the URL
    expect(parseInviteCode("mã sai")).toBeNull();
    expect(parseInviteCode("")).toBeNull();
  });
});
