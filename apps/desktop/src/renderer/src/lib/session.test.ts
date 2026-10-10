import { describe, expect, it, vi } from "vitest";
import { createSession } from "./session";

const user = { id: "u1", email: "a@b.c", username: "an" };
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

function setup(token: string | null, fetch: (url: string) => Promise<Response>, persistent = true) {
  let stored = token;
  const storage = {
    get: vi.fn(async () => ({ token: stored, persistent })),
    set: vi.fn(async (t: string) => void (stored = t)),
    clear: vi.fn(async () => void (stored = null)),
  };
  const onSignedOut = vi.fn();
  const s = createSession({ baseUrl: "http://api", storage, onSignedOut, fetch: fetch as unknown as typeof globalThis.fetch });
  return { ...s, storage, onSignedOut, stored: () => stored };
}

const tokens = { user, accessToken: "a2", refreshToken: "r2" };

describe("session store", () => {
  it("starts restoring, then signedOut when nothing is stored (no network call)", async () => {
    const fetch = vi.fn();
    const s = setup(null, fetch);
    expect(s.useSession.getState().status).toBe("restoring");
    await s.start();
    expect(s.useSession.getState().status).toBe("signedOut");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("restores a stored session into signedIn with the user", async () => {
    const s = setup("r1", async () => ok(tokens));
    await s.start();
    expect(s.useSession.getState()).toMatchObject({ status: "signedIn", user, persistent: true });
    expect(s.stored()).toBe("r2");
  });

  it("goes offline (not signedOut) when the server cannot be reached, keeping the token", async () => {
    const s = setup("r1", async () => {
      throw new TypeError("Failed to fetch");
    });
    await s.start();
    expect(s.useSession.getState().status).toBe("offline");
    expect(s.stored()).toBe("r1");
  });

  it("signedOut when the stored token is rejected", async () => {
    const s = setup("r1", async () => new Response(JSON.stringify({ error: "Invalid refresh token" }), { status: 401 }));
    await s.start();
    expect(s.useSession.getState().status).toBe("signedOut");
    expect(s.stored()).toBeNull();
  });

  it("login -> signedIn, logout -> signedOut with storage and caches cleared", async () => {
    const s = setup(null, async (url) => (url.endsWith("/auth/logout") ? new Response(null, { status: 204 }) : ok(tokens)), false);
    await s.start();
    expect(s.useSession.getState().persistent).toBe(false);
    await s.login({ email: "a@b.c", password: "12345678" });
    expect(s.useSession.getState()).toMatchObject({ status: "signedIn", user });
    await s.logout();
    expect(s.useSession.getState()).toMatchObject({ status: "signedOut", user: null });
    expect(s.stored()).toBeNull();
    expect(s.onSignedOut).toHaveBeenCalledTimes(1);
  });
});
