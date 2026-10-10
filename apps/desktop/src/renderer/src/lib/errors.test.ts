import { describe, expect, it } from "vitest";
import { ApiError } from "./auth-client";
import { errorMessage } from "./errors";

describe("friend and DM errors in Vietnamese", () => {
  it("an unknown username and a blocked one are the SAME 404 and get the SAME message", () => {
    const unknown = errorMessage(new ApiError(404, "/friends/requests", "Not found"));
    const blocked = errorMessage(new ApiError(404, "/friends/requests"));
    expect(unknown).toBe(blocked);
    expect(unknown).toMatch(/Không tìm thấy người dùng/);
    expect(unknown).not.toMatch(/chặn/i); // never reveals a block
  });
  it("already friends / request pending, and yourself", () => {
    expect(errorMessage(new ApiError(409, "/friends/requests"))).toMatch(/đã là bạn bè hoặc lời mời đang chờ/);
    expect(errorMessage(new ApiError(400, "/friends/requests"))).toMatch(/chính mình/);
  });
  it("sending in a DM after an unfriend or block is a 403 with its own words", () => {
    const m = errorMessage(new ApiError(403, "/dms/8f2c/messages", "Not friends"));
    expect(m).toMatch(/không còn là bạn bè/);
    expect(m).not.toBe(errorMessage(new ApiError(403, "/channels/c1/messages")));
  });
  it("other paths keep the general messages", () => {
    expect(errorMessage(new ApiError(404, "/friends/requests/abc/accept"))).toBe(errorMessage(new ApiError(404, "/guilds/x")));
    expect(errorMessage(new ApiError(0, "/friends/requests"))).toMatch(/Không kết nối/);
  });
});
