import { describe, expect, it } from "vitest";
import { signalOf } from "./signal";

describe("signalOf", () => {
  it("follows LiveKit's rating while connected", () => {
    expect(signalOf("connected", "excellent")).toMatchObject({ level: "full", tone: "good" });
    expect(signalOf("connected", "good")).toMatchObject({ level: "medium", tone: "good" });
    expect(signalOf("connected", "poor")).toMatchObject({ level: "low", tone: "warn" });
    expect(signalOf("connected", "lost")).toMatchObject({ level: "lost", tone: "bad" });
  });

  it("does not claim a good connection before LiveKit has reported", () => {
    expect(signalOf("connected", "unknown")).toMatchObject({ tone: "idle", label: "voice.signal.unknown" });
  });

  it("ignores a stale rating while not connected", () => {
    expect(signalOf("reconnecting", "excellent")).toMatchObject({ level: "low", label: "voice.signal.reconnecting" });
    expect(signalOf("connecting", "excellent")).toMatchObject({ level: "low", tone: "idle" });
  });
});
