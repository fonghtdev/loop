import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { env } from "../test/helpers.js";

const allowed = "app://loop";
const app = buildApp({ ...env, corsOrigins: ["http://localhost:5173", allowed] });
afterAll(() => app.close());

const preflight = (origin: string, url = "/auth/login") =>
  app.inject({
    method: "OPTIONS",
    url,
    headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" },
  });

describe("CORS", () => {
  it("answers an allowlisted origin's preflight with 204 and the CORS headers", async () => {
    const res = await preflight(allowed);
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(allowed);
    expect(String(res.headers["access-control-allow-headers"]).toLowerCase()).toContain("authorization");
    expect(String(res.headers["access-control-allow-methods"])).toContain("PATCH");
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("adds the allow-origin header to an allowlisted origin's real request", async () => {
    const res = await app.inject({ method: "GET", url: "/me", headers: { origin: allowed } });
    expect(res.statusCode).toBe(401);
    expect(res.headers["access-control-allow-origin"]).toBe(allowed);
  });

  it("gives a non-allowlisted origin no CORS headers", async () => {
    const evil = "https://evil.example";
    const pre = await preflight(evil);
    expect(pre.headers["access-control-allow-origin"]).toBeUndefined();
    const res = await app.inject({ method: "GET", url: "/me", headers: { origin: evil } });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("allows no origin at all when the list is empty (the default)", async () => {
    const closed = buildApp(env);
    const res = await closed.inject({ method: "GET", url: "/me", headers: { origin: allowed } });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    await closed.close();
  });

  it("leaves the LiveKit webhook as it was: signature still required, no CORS header without an Origin", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/livekit/webhook",
      headers: { "content-type": "application/webhook+json" },
      payload: "{}",
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
