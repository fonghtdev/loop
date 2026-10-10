import { describe, expect, it, vi } from "vitest";
import { ApiError, createAuthClient } from "./auth-client";
import { errorMessage } from "./errors";

const user = { id: "u1", email: "a@b.c", username: "an" };
const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const tick = () => new Promise((r) => setTimeout(r, 5));

/**
 * A fake server with the real refresh contract: tokens rotate, and presenting an already-rotated refresh token
 * revokes everything (`theft` becomes true). `log` records every call in order, plus storage writes.
 */
function setup(opts: { refreshStatus?: number; protectedStatus?: (auth: string | undefined) => number } = {}) {
  const log: string[] = [];
  let stored: string | null = "r1";
  const live = new Set(["r1"]);
  const state = { theft: false, refreshCalls: 0, access: "a1" };
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const path = url.replace("http://api", "");
    const auth = (init.headers as Record<string, string>).authorization;
    log.push(`${path} ${auth ?? "-"}`);
    if (path === "/auth/refresh") {
      state.refreshCalls++;
      await tick();
      const { refreshToken } = JSON.parse(init.body as string);
      if (opts.refreshStatus) return json(opts.refreshStatus, { error: "nope" });
      if (!live.delete(refreshToken)) {
        state.theft = true;
        return json(401, { error: "Invalid refresh token" });
      }
      const n = state.refreshCalls + 1;
      live.add(`r${n}`);
      state.access = `a${n}`;
      return json(200, { user, accessToken: `a${n}`, refreshToken: `r${n}` });
    }
    if (path === "/auth/login") return json(401, { error: "Invalid email or password" });
    const status = opts.protectedStatus?.(auth) ?? (auth === `Bearer ${state.access}` && state.access !== "a1" ? 200 : 401);
    return json(status, status === 200 ? { ok: path } : { error: "Unauthorized" });
  });
  const storage = {
    get: vi.fn(async () => ({ token: stored, persistent: true })),
    set: vi.fn(async (t: string) => {
      log.push(`store ${t}`);
      stored = t;
    }),
    clear: vi.fn(async () => {
      log.push("clear");
      stored = null;
    }),
  };
  const onSignedOut = vi.fn();
  const client = createAuthClient({ baseUrl: "http://api", storage, onSignedOut, fetch: fetch as unknown as typeof globalThis.fetch });
  return { client, fetch, storage, onSignedOut, log, state, stored: () => stored };
}

/** Puts the client in the "signed in with an expired access token a1" state. */
async function signedInWithExpiredToken(s: ReturnType<typeof setup>) {
  // register is the simplest way to seed an access token without touching refresh
  s.fetch.mockImplementationOnce(async () => json(201, { user, accessToken: "a1", refreshToken: "r1" }));
  await s.client.register({ email: "a@b.c", username: "an", password: "12345678" });
  s.log.length = 0;
  s.storage.set.mockClear();
}

describe("single-flight refresh", () => {
  it("N concurrent 401s share ONE refresh; the new token is stored once, before any retry; each request retried once", async () => {
    const s = setup();
    await signedInWithExpiredToken(s);
    const results = await Promise.all([1, 2, 3, 4, 5].map((i) => s.client.request<{ ok: string }>("GET", `/x${i}`)));

    expect(results.map((r) => r.ok)).toEqual(["/x1", "/x2", "/x3", "/x4", "/x5"]);
    expect(s.state.refreshCalls).toBe(1);
    expect(s.state.theft).toBe(false);
    expect(s.storage.set).toHaveBeenCalledTimes(1);
    expect(s.storage.set).toHaveBeenCalledWith("r2");
    const storedAt = s.log.indexOf("store r2");
    const retries = s.log.filter((l) => l.endsWith("Bearer a2"));
    expect(retries).toHaveLength(5);
    expect(s.log.findIndex((l) => l.endsWith("Bearer a2"))).toBeGreaterThan(storedAt);
    for (let i = 1; i <= 5; i++) expect(s.log.filter((l) => l.startsWith(`/x${i} `))).toHaveLength(2);
  });

  it("a 401 that arrives after another request already refreshed just retries (no second refresh)", async () => {
    const s = setup();
    await signedInWithExpiredToken(s);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const real = s.fetch.getMockImplementation()!;
    s.fetch.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.endsWith("/slow") && (init.headers as Record<string, string>).authorization === "Bearer a1") {
        await gate; // the slow request's first answer arrives only after the refresh is done
      }
      return real(url, init);
    });
    const slow = s.client.request("GET", "/slow");
    await s.client.request("GET", "/fast");
    release();
    await expect(slow).resolves.toEqual({ ok: "/slow" });
    expect(s.state.refreshCalls).toBe(1);
    expect(s.state.theft).toBe(false);
  });

  it("a rejected refresh clears the session once and does not loop", async () => {
    const s = setup({ refreshStatus: 401 });
    await signedInWithExpiredToken(s);
    const results = await Promise.allSettled([1, 2, 3].map((i) => s.client.request("GET", `/x${i}`)));

    expect(results.every((r) => r.status === "rejected" && (r.reason as ApiError).status === 401)).toBe(true);
    expect(s.state.refreshCalls).toBe(1);
    expect(s.storage.clear).toHaveBeenCalledTimes(1);
    expect(s.onSignedOut).toHaveBeenCalledTimes(1);
    expect(s.stored()).toBeNull();
    // later calls do not try to refresh with nothing
    await expect(s.client.request("GET", "/again")).rejects.toMatchObject({ status: 401 });
    expect(s.state.refreshCalls).toBe(1);
  });

  it("a retried request that 401s again does not refresh again, and ends the session", async () => {
    const s = setup({ protectedStatus: () => 401 });
    await signedInWithExpiredToken(s);
    await expect(s.client.request("GET", "/x")).rejects.toMatchObject({ status: 401 });
    expect(s.state.refreshCalls).toBe(1);
    expect(s.log.filter((l) => l.startsWith("/x "))).toHaveLength(2);
    expect(s.onSignedOut).toHaveBeenCalledTimes(1);
  });

  it("an unreachable server during refresh keeps the stored token (offline is not signed out)", async () => {
    const s = setup();
    s.fetch.mockImplementation(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(s.client.restore()).rejects.toMatchObject({ status: 0 });
    expect(s.storage.clear).not.toHaveBeenCalled();
    expect(s.stored()).toBe("r1");
  });
});

describe("accessToken (socket handshakes)", () => {
  it("returns the current token; with the refused one it refreshes through the SAME single flight as REST 401s", async () => {
    const s = setup();
    await signedInWithExpiredToken(s);
    expect(await s.client.accessToken()).toBe("a1");
    const [socketToken] = await Promise.all([s.client.accessToken("a1"), s.client.request("GET", "/x"), s.client.request("GET", "/y")]);
    expect(socketToken).toBe("a2");
    expect(s.state.refreshCalls).toBe(1);
    expect(s.state.theft).toBe(false);
    // a refusal of a token already replaced does not refresh again
    expect(await s.client.accessToken("a1")).toBe("a2");
    expect(s.state.refreshCalls).toBe(1);
  });

  it("null when the refresh is rejected (session over)", async () => {
    const s = setup({ refreshStatus: 401 });
    await signedInWithExpiredToken(s);
    expect(await s.client.accessToken("a1")).toBeNull();
    expect(s.onSignedOut).toHaveBeenCalledTimes(1);
  });
});

describe("auth endpoints", () => {
  it("a 401 from /auth/login is wrong credentials, not an expired session", async () => {
    const s = setup();
    const err = await s.client.login({ email: "a@b.c", password: "wrong" }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
    expect(s.state.refreshCalls).toBe(0);
    expect(s.storage.clear).not.toHaveBeenCalled();
    expect(s.onSignedOut).not.toHaveBeenCalled();
    expect(errorMessage(err)).toBe("Email hoặc mật khẩu không đúng.");
  });

  it("logout revokes on the server (best effort) and clears the stored token", async () => {
    const s = setup();
    s.fetch.mockImplementation(async () => {
      throw new TypeError("offline");
    });
    await s.client.logout();
    expect(s.fetch).toHaveBeenCalledWith("http://api/auth/logout", expect.objectContaining({ body: JSON.stringify({ refreshToken: "r1" }) }));
    expect(s.stored()).toBeNull();
    expect(s.onSignedOut).toHaveBeenCalledTimes(1);
  });
});

describe("errorMessage", () => {
  it.each([
    [new ApiError(0, "/x"), "Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại."],
    [new ApiError(400, "/auth/register"), "Thông tin chưa hợp lệ, vui lòng kiểm tra lại."],
    [new ApiError(401, "/auth/login"), "Email hoặc mật khẩu không đúng."],
    [new ApiError(401, "/guilds"), "Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại."],
    [new ApiError(409, "/auth/register"), "Email hoặc tên người dùng đã có người dùng."],
    [new ApiError(429, "/auth/login"), "Bạn thao tác hơi nhanh, vui lòng thử lại sau ít phút."],
    [new ApiError(503, "/x"), "Máy chủ đang gặp sự cố, vui lòng thử lại sau."],
    [new ApiError(404, "/invites/abc/join"), "Mã mời không tồn tại hoặc đã hết hạn."],
    [new ApiError(404, "/messages/m1"), "Không tìm thấy. Có thể nó đã bị xoá hoặc bạn không còn quyền truy cập."],
    [new ApiError(403, "/channels/c1/messages"), "Bạn không có quyền làm việc này."],
    [new ApiError(409, "/guilds/g1/members/me"), "Bạn là chủ máy chủ nên chưa thể rời đi. Hãy chuyển quyền chủ cho thành viên khác hoặc xoá máy chủ."],
    [new ApiError(409, "/guilds/g1/channels"), "Máy chủ đã có kênh tên này. Chọn tên khác nhé."],
    [new ApiError(400, "/guilds"), "Thông tin chưa hợp lệ, vui lòng kiểm tra lại."],
    [new Error("boom"), "Đã có lỗi xảy ra, vui lòng thử lại."],
  ])("%s", (err, text) => {
    expect(errorMessage(err)).toBe(text);
  });

  it("a network failure surfaces as status 0", async () => {
    const s = setup();
    s.fetch.mockImplementation(async () => {
      throw new TypeError("Failed to fetch");
    });
    const err = await s.client.login({ email: "a@b.c", password: "x" }).catch((e) => e);
    expect(errorMessage(err)).toBe("Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.");
  });
});
