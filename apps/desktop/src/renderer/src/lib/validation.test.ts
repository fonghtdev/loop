import { describe, expect, it } from "vitest";
import { validate } from "./validation";

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
