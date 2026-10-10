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

describe("voice and call errors", () => {
  const e = (status: number, path: string) => errorMessage(new ApiError(status, path, "x"));
  it("every token status has its own Vietnamese sentence", () => {
    const path = "/channels/abc/voice/token";
    const all = [403, 404, 400, 409].map((s) => e(s, path));
    expect(new Set(all).size).toBe(4);
    expect(e(403, path)).toBe("Bạn không có quyền vào kênh thoại này.");
    expect(e(409, path)).toBe("Kênh thoại đã đầy, hãy thử lại sau.");
    expect(e(500, path)).toBe("Máy chủ đang gặp sự cố, vui lòng thử lại sau.");
    expect(e(0, path)).toBe("Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.");
  });
  it("starting a call: not friends vs gone", () => {
    expect(e(403, "/dms/d1/call")).toBe("Không gọi được: hai bạn không còn là bạn bè.");
    expect(e(404, "/dms/d1/call")).toBe("Không tìm thấy cuộc trò chuyện này.");
  });
});

describe("administration refusals (told apart by the server's text)", () => {
  const e = (status: number, path: string, text: string) => errorMessage(new ApiError(status, path, text));
  it.each([
    [403, "/guilds/g/roles/r", "This role is not below your highest role", /ngang hoặc cao hơn/],
    [403, "/guilds/g/members/u", "This member is not below your highest role", /ngang hoặc cao hơn/],
    [403, "/guilds/g/roles/r", "You cannot grant permissions you do not have", /không thể cấp hoặc gỡ quyền/],
    [403, "/channels/c/overwrites/r", "You cannot grant permissions you do not have", /không thể cấp hoặc gỡ quyền/],
    [403, "/guilds/g/members/u", "The owner cannot be managed by others", /chủ máy chủ/],
    [403, "/guilds/g/members/u", "The owner cannot be kicked", /chủ máy chủ/],
    [403, "/guilds/g", "Only the owner can do this", /Chỉ chủ máy chủ/],
    [403, "/guilds/g/roles", "You need a role above the new one", /cần có một vai trò/],
    [400, "/guilds/g/roles/g", "@everyone cannot be renamed, deleted or assigned", /@everyone/],
    [400, "/guilds/g/members/u", "Not allowed on yourself", /Rời máy chủ/],
    [400, "/guilds/g/transfer", "You already own this guild", /đã là chủ/],
    [409, "/guilds/g/channels/c", "A guild must keep at least one channel", /ít nhất một kênh/],
  ])("%i %s: %s", (status, path, text, expected) => {
    expect(e(status, path, text)).toMatch(expected);
  });
  it("other 403/404 keep the general words", () => {
    expect(e(403, "/guilds/g/roles", "Missing permission")).toBe("Bạn không có quyền làm việc này.");
    expect(e(404, "/guilds/g/roles/r", "Not found")).toMatch(/Không tìm thấy/);
  });
});
