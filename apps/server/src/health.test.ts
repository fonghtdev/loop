import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { probes } from "./health.js";
import { env } from "../test/helpers.js";

const app = buildApp({ ...env, rateLimit: true, rateLimitOverrides: { namespace: "rl-health:", policies: { global: { max: 1, windowMs: 60_000, by: "ip" } } } });
afterAll(() => app.close());
afterEach(() => vi.restoreAllMocks());

const get = () => app.inject({ method: "GET", url: "/health" });

describe("GET /health", () => {
  it("is 200 {ok:true} without credentials when Postgres and Redis answer", async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("is 503 {ok:false} with no details when Postgres fails", async () => {
    vi.spyOn(probes, "postgres").mockRejectedValue(new Error("db password=secret"));
    const res = await get();
    expect(res.statusCode).toBe(503);
    expect(res.body).toBe('{"ok":false}');
  });

  it("is 503 when Redis fails", async () => {
    vi.spyOn(probes, "redis").mockRejectedValue(new Error("down"));
    expect((await get()).statusCode).toBe(503);
  });

  it("is 503 when a dependency does not answer within about a second", async () => {
    vi.spyOn(probes, "redis").mockReturnValue(new Promise(() => {}));
    const started = Date.now();
    expect((await get()).statusCode).toBe(503);
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it("is never rate limited, even when the global budget is 1 per minute", async () => {
    for (let i = 0; i < 5; i++) expect((await get()).statusCode).toBe(200);
  });
});
