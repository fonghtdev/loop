import { describe, expect, it } from "vitest";
import { checkReleaseEnv } from "./check-release-env.mjs";

const good = { VITE_API_URL: "https://api.loop.example", VITE_STORAGE_ORIGIN: "https://files.loop.example", VITE_LIVEKIT_ORIGIN: "wss://loop.livekit.cloud" };

describe("checkReleaseEnv", () => {
  it("accepts real https/wss addresses (with or without an https update feed)", () => {
    expect(checkReleaseEnv(good)).toEqual([]);
    expect(checkReleaseEnv({ ...good, VITE_UPDATE_URL: "https://updates.loop.example/" })).toEqual([]);
  });
  it("rejects missing values", () => {
    expect(checkReleaseEnv({})).toHaveLength(3);
  });
  it.each([
    ["VITE_API_URL", "http://localhost:3000"],
    ["VITE_API_URL", "https://localhost"],
    ["VITE_API_URL", "https://127.0.0.1"],
    ["VITE_STORAGE_ORIGIN", "https://[::1]:9000"],
    ["VITE_LIVEKIT_ORIGIN", "wss://127.0.0.1:7880"],
    ["VITE_LIVEKIT_ORIGIN", "wss://mac.local"],
  ])("rejects local %s=%s", (name, value) => {
    expect(checkReleaseEnv({ ...good, [name]: value })).toHaveLength(1);
  });
  it.each([
    ["VITE_API_URL", "http://api.loop.example"],
    ["VITE_LIVEKIT_ORIGIN", "ws://loop.livekit.cloud"],
    ["VITE_UPDATE_URL", "http://updates.loop.example"],
  ])("rejects an insecure %s=%s", (name, value) => {
    expect(checkReleaseEnv({ ...good, [name]: value })).toHaveLength(1);
  });
  it("LOOP_ALLOW_LOCAL=1 bypasses everything", () => {
    expect(checkReleaseEnv({ LOOP_ALLOW_LOCAL: "1", VITE_API_URL: "http://localhost:3000" })).toEqual([]);
  });
});
